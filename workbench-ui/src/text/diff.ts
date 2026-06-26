import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createExplorerIgnore } from "./file-tree";

// The git "empty tree" object; diffing against it represents "everything is new"
// and lets us handle freshly-initialised repos that have no HEAD commit yet.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_LINES = 4000;
// LCS diffs are O(n*m) in memory; above this we fall back to a whole-file
// replace rather than allocate a huge table.
const MAX_DIFF_LINES = 2000;
// fs-snapshot caps (non-git workspaces only).
const MAX_SNAPSHOT_FILES = 4000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
// Upper bound on files listed in a single diff. A fresh repo with no commits
// and no .gitignore over a huge tree can have 100k+ "untracked" files; listing
// them all (and reading each to count lines) would hang the UI. Past this we
// truncate the list and skip the per-file content reads entirely.
const MAX_DIFF_FILES = 2000;

// The diff scan runs on the main thread; it can touch thousands of files, so we
// hand control back to the event loop every so often to keep input/rendering
// responsive (otherwise opening a workspace freezes clicks while it scans).
const YIELD_EVERY = 48;
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  added: number;
  binary: boolean;
  deleted: number;
  path: string;
  relativePath: string;
  status: DiffStatus;
}

export interface SessionDiff {
  available: boolean;
  baseline: "HEAD" | "session-start";
  files: DiffFile[];
  isGit: boolean;
  reason?: string;
  root: string;
  totalAdded: number;
  totalDeleted: number;
}

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  newNo?: number;
  oldNo?: number;
  text: string;
}

export interface FilePatch {
  binary: boolean;
  lines: DiffLine[];
  path: string;
  truncated: boolean;
}

interface GitProcess {
  code: number;
  stderr: string;
  stdout: string;
}

async function runGit(root: string, args: string[]): Promise<GitProcess> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Avoid touching index.lock so concurrent agent git ops aren't disturbed.
      env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch {
    return { code: -1, stdout: "", stderr: "" };
  }
}

// Whether a root is a git work tree is stable for a session, and once a repo
// has a HEAD commit it keeps one. Cache both so the 5-spawn diff drops to 3
// spawns per poll on the steady-state path (this poller runs continuously).
const isGitCache = new Map<string, boolean>();
const hasHeadCache = new Set<string>();

async function isInsideGitWorkTree(root: string): Promise<boolean> {
  const cached = isGitCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  const result = inside.code === 0 && inside.stdout.trim() === "true";
  isGitCache.set(root, result);
  return result;
}

async function repoHasHead(root: string): Promise<boolean> {
  if (hasHeadCache.has(root)) {
    return true;
  }
  const ok = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).code === 0;
  if (ok) {
    hasHeadCache.add(root);
  }
  return ok;
}

export async function computeSessionDiff(root: string): Promise<SessionDiff> {
  if (await isInsideGitWorkTree(root)) {
    return gitDiff(root);
  }
  return snapshotDiff(root);
}

async function gitDiff(root: string): Promise<SessionDiff> {
  const hasHead = await repoHasHead(root);
  const base = hasHead ? "HEAD" : EMPTY_TREE;

  // `--relative` scopes the diff to the session cwd subtree and emits paths
  // relative to it, so a session in a sub-package only shows its own changes.
  const numstat = await runGit(root, [
    "diff",
    "--numstat",
    "--no-renames",
    "--relative",
    base,
  ]);
  const nameStatus = await runGit(root, [
    "diff",
    "--name-status",
    "--no-renames",
    "--relative",
    base,
  ]);

  const counts = new Map<
    string,
    { added: number; deleted: number; binary: boolean }
  >();
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) {
      continue;
    }
    const binary = a === "-" || d === "-";
    counts.set(path, {
      added: binary ? 0 : Number(a) || 0,
      deleted: binary ? 0 : Number(d) || 0,
      binary,
    });
  }

  const statuses = new Map<string, DiffStatus>();
  for (const line of nameStatus.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [code, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) {
      continue;
    }
    statuses.set(
      path,
      code.startsWith("A")
        ? "added"
        : code.startsWith("D")
          ? "deleted"
          : "modified"
    );
  }

  const files: DiffFile[] = [];
  for (const [gitPath, count] of counts) {
    files.push({
      path: resolve(root, gitPath),
      relativePath: gitPath,
      added: count.added,
      deleted: count.deleted,
      binary: count.binary,
      status: statuses.get(gitPath) ?? "modified",
    });
  }

  // Untracked files don't show up in `git diff`; count them as pure additions.
  // ls-files paths are already relative to cwd; scope to this subtree with `.`.
  const untrackedPaths = (
    await runGit(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ])
  ).stdout
    .split("\0")
    .filter(Boolean);

  // When there are far too many untracked files to be a meaningful "changes"
  // view, skip the (blocking) per-file line counting and just list a capped
  // set. This keeps a no-commit/no-.gitignore megarepo from hanging the UI.
  const tooMany = files.length + untrackedPaths.length > MAX_DIFF_FILES;
  let processed = 0;
  for (const gitPath of untrackedPaths) {
    if (files.length >= MAX_DIFF_FILES) {
      break;
    }
    const abs = resolve(root, gitPath);
    if (tooMany) {
      files.push({
        path: abs,
        relativePath: gitPath,
        added: 0,
        deleted: 0,
        binary: false,
        status: "added",
      });
      continue;
    }
    const { added, binary } = countAdditions(abs);
    files.push({
      path: abs,
      relativePath: gitPath,
      added,
      deleted: 0,
      binary,
      status: "added",
    });
    if (++processed % YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    root,
    isGit: true,
    available: true,
    baseline: "HEAD",
    files,
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalDeleted: files.reduce((sum, file) => sum + file.deleted, 0),
    reason: tooMany
      ? `${untrackedPaths.length.toLocaleString()} untracked files - showing ${MAX_DIFF_FILES.toLocaleString()} (commit a baseline or add a .gitignore)`
      : undefined,
  };
}

function countAdditions(path: string): { added: number; binary: boolean } {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return { added: 0, binary: false };
    }
    if (stats.size > MAX_FILE_BYTES) {
      return { added: 0, binary: true };
    }
    const buffer = readFileSync(path);
    if (buffer.includes(0)) {
      return { added: 0, binary: true };
    }
    const text = buffer.toString("utf8");
    if (text.length === 0) {
      return { added: 0, binary: false };
    }
    return {
      added: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
      binary: false,
    };
  } catch {
    return { added: 0, binary: false };
  }
}

// --- filesystem snapshot fallback (non-git workspaces) -----------------------

interface Snapshot {
  files: Map<string, string>; // relativePath -> text content
  oversized: boolean;
}

const snapshots = new Map<string, Snapshot>();

async function captureSnapshot(root: string): Promise<Snapshot> {
  const shouldIgnore = createExplorerIgnore(root);
  const files = new Map<string, string>();
  let count = 0;
  let oversized = false;

  const walk = async (dir: string) => {
    if (oversized) {
      return;
    }
    let entries: ReturnType<typeof readDirents>;
    try {
      entries = readDirents(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (shouldIgnore(abs)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        if (++count > MAX_SNAPSHOT_FILES) {
          oversized = true;
          return;
        }
        files.set(relative(root, abs), readText(abs));
        if (count % YIELD_EVERY === 0) {
          await yieldToEventLoop();
        }
      }
      if (oversized) {
        return;
      }
    }
  };

  await walk(root);
  return { files, oversized };
}

function readDirents(dir: string) {
  return readdirSync(dir, { withFileTypes: true });
}

function readText(path: string): string {
  try {
    const stats = statSync(path);
    if (stats.size > MAX_SNAPSHOT_BYTES) {
      return "\u0000binary";
    }
    const buffer = readFileSync(path);
    if (buffer.includes(0)) {
      return "\u0000binary";
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

async function snapshotDiff(root: string): Promise<SessionDiff> {
  let snapshot = snapshots.get(root);
  if (!snapshot) {
    snapshot = await captureSnapshot(root);
    snapshots.set(root, snapshot);
    // First sighting is the baseline, so there is nothing to report yet.
    return {
      root,
      isGit: false,
      available: !snapshot.oversized,
      baseline: "session-start",
      files: [],
      totalAdded: 0,
      totalDeleted: 0,
      reason: snapshot.oversized
        ? "Workspace too large to diff without git"
        : undefined,
    };
  }
  if (snapshot.oversized) {
    return {
      root,
      isGit: false,
      available: false,
      baseline: "session-start",
      files: [],
      totalAdded: 0,
      totalDeleted: 0,
      reason: "Workspace too large to diff without git",
    };
  }

  const current = await captureSnapshot(root);
  const files: DiffFile[] = [];
  const seen = new Set<string>();

  for (const [rel, content] of current.files) {
    seen.add(rel);
    const before = snapshot.files.get(rel);
    if (before === undefined) {
      const binary = content.startsWith("\u0000");
      files.push({
        path: join(root, rel),
        relativePath: rel,
        added: binary ? 0 : lineCount(content),
        deleted: 0,
        binary,
        status: "added",
      });
    } else if (before !== content) {
      const binary =
        before.startsWith("\u0000") || content.startsWith("\u0000");
      const { added, deleted } = binary
        ? { added: 0, deleted: 0 }
        : countChanges(before, content);
      files.push({
        path: join(root, rel),
        relativePath: rel,
        added,
        deleted,
        binary,
        status: "modified",
      });
    }
  }
  for (const [rel, content] of snapshot.files) {
    if (seen.has(rel)) {
      continue;
    }
    const binary = content.startsWith("\u0000");
    files.push({
      path: join(root, rel),
      relativePath: rel,
      added: 0,
      deleted: binary ? 0 : lineCount(content),
      binary,
      status: "deleted",
    });
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    root,
    isGit: false,
    available: true,
    baseline: "session-start",
    files,
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalDeleted: files.reduce((sum, file) => sum + file.deleted, 0),
  };
}

function lineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function countChanges(
  before: string,
  after: string
): { added: number; deleted: number } {
  const ops = diffOps(splitLines(before), splitLines(after));
  let added = 0;
  let deleted = 0;
  for (const op of ops) {
    if (op.t === "add") {
      added++;
    } else if (op.t === "del") {
      deleted++;
    }
  }
  return { added, deleted };
}

// --- per-file patch ----------------------------------------------------------

export async function computeFilePatch(
  root: string,
  absPath: string
): Promise<FilePatch> {
  if (await isInsideGitWorkTree(root)) {
    const hasHead = await repoHasHead(root);
    const base = hasHead ? "HEAD" : EMPTY_TREE;
    const rel = relative(root, absPath) || absPath;
    const result = await runGit(root, [
      "diff",
      "--no-renames",
      "--relative",
      base,
      "--",
      rel,
    ]);
    if (result.stdout.trim()) {
      const lines = parseGitPatch(result.stdout);
      const binary = lines.some(
        (line) => line.kind === "meta" && line.text.startsWith("Binary files")
      );
      return finishPatch(absPath, lines, binary);
    }
    // No tracked diff: likely an untracked file (whole-file addition).
    return wholeFileAddition(absPath);
  }

  const snapshot = snapshots.get(root);
  const rel = relative(root, absPath);
  const before = snapshot?.files.get(rel);
  const exists = fileExists(absPath);
  if (before !== undefined && before.startsWith("\u0000")) {
    return { path: absPath, binary: true, truncated: false, lines: [] };
  }

  if (before === undefined && exists) {
    return wholeFileAddition(absPath);
  }
  if (before !== undefined && !exists) {
    // Deleted since baseline.
    const lines = splitLines(before).map(
      (text, index): DiffLine => ({ kind: "del", text, oldNo: index + 1 })
    );
    return finishPatch(
      absPath,
      [{ kind: "hunk", text: `@@ -1,${lines.length} +0,0 @@` }, ...lines],
      false
    );
  }

  const after = readText(absPath);
  if (after.startsWith("\u0000")) {
    return { path: absPath, binary: true, truncated: false, lines: [] };
  }
  const lines = groupHunks(
    diffOps(splitLines(before ?? ""), splitLines(after))
  );
  return finishPatch(absPath, lines, false);
}

function wholeFileAddition(absPath: string): FilePatch {
  try {
    if (statSync(absPath).size > MAX_FILE_BYTES) {
      return {
        path: absPath,
        binary: false,
        truncated: true,
        lines: [{ kind: "meta", text: "... file too large to preview ..." }],
      };
    }
    const buffer = readFileSync(absPath);
    if (buffer.includes(0)) {
      return { path: absPath, binary: true, truncated: false, lines: [] };
    }
    const text = buffer.toString("utf8");
    const lines = splitLines(text).map(
      (line, index): DiffLine => ({ kind: "add", text: line, newNo: index + 1 })
    );
    return finishPatch(
      absPath,
      [{ kind: "hunk", text: `@@ -0,0 +1,${lines.length} @@` }, ...lines],
      false
    );
  } catch (error) {
    return {
      path: absPath,
      binary: false,
      truncated: false,
      lines: [
        {
          kind: "meta",
          text: error instanceof Error ? error.message : "Could not read file",
        },
      ],
    };
  }
}

function finishPatch(
  path: string,
  lines: DiffLine[],
  binary: boolean
): FilePatch {
  if (lines.length <= MAX_PATCH_LINES) {
    return { path, binary, truncated: false, lines };
  }
  return {
    path,
    binary,
    truncated: true,
    lines: [
      ...lines.slice(0, MAX_PATCH_LINES),
      { kind: "meta", text: "... diff truncated ..." },
    ],
  };
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function parseGitPatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      }
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("Binary files")) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (
      raw.startsWith("+++") ||
      raw.startsWith("---") ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity") ||
      raw.startsWith("rename ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode")
    ) {
      continue;
    }
    if (raw.startsWith("\\")) {
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newNo });
      newNo++;
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo });
      oldNo++;
    } else if (raw.length > 0) {
      out.push({
        kind: "context",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldNo,
        newNo,
      });
      oldNo++;
      newNo++;
    }
  }
  return out;
}

interface Op {
  line: string;
  t: "eq" | "add" | "del";
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return b.map((line) => ({ t: "add", line }));
  }
  if (m === 0) {
    return a.map((line) => ({ t: "del", line }));
  }
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    return [
      ...a.map((line): Op => ({ t: "del", line })),
      ...b.map((line): Op => ({ t: "add", line })),
    ];
  }

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ t: "del", line: a[i] });
      i++;
    } else {
      ops.push({ t: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: "del", line: a[i++] });
  }
  while (j < m) {
    ops.push({ t: "add", line: b[j++] });
  }
  return ops;
}

function groupHunks(ops: Op[], context = 3): DiffLine[] {
  const n = ops.length;
  if (n === 0) {
    return [];
  }
  const keep = new Array<boolean>(n).fill(false);
  let anyChange = false;
  for (let k = 0; k < n; k++) {
    if (ops[k].t !== "eq") {
      anyChange = true;
      for (let d = -context; d <= context; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < n) {
          keep[idx] = true;
        }
      }
    }
  }
  if (!anyChange) {
    return [];
  }

  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let k = 0;
  while (k < n) {
    if (!keep[k]) {
      const op = ops[k];
      if (op.t === "eq" || op.t === "del") {
        oldNo++;
      }
      if (op.t === "eq" || op.t === "add") {
        newNo++;
      }
      k++;
      continue;
    }
    const hunkOldStart = oldNo;
    const hunkNewStart = newNo;
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (k < n && keep[k]) {
      const op = ops[k];
      if (op.t === "eq") {
        lines.push({ kind: "context", text: op.line, oldNo, newNo });
        oldNo++;
        newNo++;
        oldCount++;
        newCount++;
      } else if (op.t === "del") {
        lines.push({ kind: "del", text: op.line, oldNo });
        oldNo++;
        oldCount++;
      } else {
        lines.push({ kind: "add", text: op.line, newNo });
        newNo++;
        newCount++;
      }
      k++;
    }
    out.push({
      kind: "hunk",
      text: `@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`,
    });
    out.push(...lines);
  }
  return out;
}

export function diffSignature(diff: SessionDiff): string {
  return `${diff.available}:${diff.totalAdded}:${diff.totalDeleted}:${diff.files
    .map(
      (file) =>
        `${file.relativePath}|${file.added}|${file.deleted}|${file.status}`
    )
    .join(",")}`;
}
