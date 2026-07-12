import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import ignore from "ignore";
import type { FileTreeEntry } from "../state/types";

const ignored = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  ".next",
  ".turbo",
]);
const maxExplorerDepth = 8;

// Lazily read only the directories that are actually visible: the root plus any
// expanded folder. This avoids walking/stat-ing the entire repo (the previous
// full-tree glob was the main startup cost).
export function buildExplorerEntries(
  rootPath: string,
  expandedDirs: Set<string>,
  maxEntries = 500
): FileTreeEntry[] {
  // A file explorer should expose local outputs such as gitignored `runs/` and
  // `data/` directories. Keep only the built-in heavyweight exclusions here;
  // diff/snapshot code uses the default matcher, which still respects gitignore.
  const shouldIgnore = createExplorerIgnore(rootPath, {
    respectGitignore: false,
  });
  const entries: FileTreeEntry[] = [];

  const readDir = (dirPath: string) => {
    let dirents;
    try {
      dirents = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [] as { name: string; path: string; isDirectory: boolean }[];
    }
    const list: { name: string; path: string; isDirectory: boolean }[] = [];
    for (const dirent of dirents) {
      if (ignored.has(dirent.name)) {
        continue;
      }
      const full = join(dirPath, dirent.name);
      if (shouldIgnore(full)) {
        continue;
      }
      list.push({
        name: dirent.name,
        path: full,
        isDirectory: dirent.isDirectory(),
      });
    }
    list.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    return list;
  };

  const visit = (dirPath: string, depth: number) => {
    if (depth > maxExplorerDepth) {
      return;
    }
    for (const node of readDir(dirPath)) {
      if (entries.length >= maxEntries) {
        return;
      }
      const expanded = node.isDirectory && expandedDirs.has(node.path);
      entries.push({
        // Width-1 BMP triangles for folders (collapsed/expanded) and two leading
        // spaces for files. Astral-plane emoji icons (U+1F4C1/2) were dropped:
        // their cell width is terminal-dependent, which shifted/clipped the name
        // next to them and left some entries looking nameless.
        label: `${"  ".repeat(depth)}${node.isDirectory ? (expanded ? "\u25be " : "\u25b8 ") : "  "}${node.name}`,
        name: node.name,
        path: node.path,
        relativePath: relative(rootPath, node.path) || node.name,
        depth,
        isDirectory: node.isDirectory,
        expanded,
      });
      if (expanded) {
        visit(node.path, depth + 1);
      }
    }
  };

  visit(rootPath, 0);
  return entries;
}

export function describeEntry(rootPath: string, entry: FileTreeEntry) {
  if (entry.isDirectory) {
    return "directory";
  }
  const rel = relative(rootPath, entry.path);
  return rel === "" ? basename(entry.path) : rel;
}

export function toggleDirectory(expandedDirs: Set<string>, path: string) {
  if (expandedDirs.has(path)) {
    expandedDirs.delete(path);
  } else {
    expandedDirs.add(path);
  }
}

// Expand `~` and resolve relative input against `base` so the new-agent
// dialog accepts the same path shorthands a shell would.
export function expandPathInput(value: string, base: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return base;
  }
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Directory suggestions for a partially typed path. The value is split into
// parent directory + partial leaf name; matching child directories of the
// parent are returned as absolute paths.
export function completeDirectories(
  value: string,
  base: string,
  limit = 8
): string[] {
  const expanded = expandPathInput(value, base);
  let parent: string;
  let partial: string;
  if (value.endsWith("/") || isExistingDirectory(expanded)) {
    parent = expanded;
    partial = "";
  } else {
    parent = dirname(expanded);
    partial = basename(expanded);
  }

  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name.startsWith(partial) &&
          (partial.startsWith(".") || !name.startsWith("."))
      )
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit)
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

// Caches the gitignore matcher per root so repeated explorer rebuilds don't
// re-read and re-parse .gitignore each time.
const ignoreCache = new Map<
  string,
  { mtimeMs: number; matcher: (path: string) => boolean }
>();

export function createExplorerIgnore(
  rootPath: string,
  options: { respectGitignore?: boolean } = {}
) {
  const respectGitignore = options.respectGitignore ?? true;
  const gitignorePath = resolve(rootPath, ".gitignore");
  let mtimeMs = 0;
  if (respectGitignore) {
    try {
      mtimeMs = statSync(gitignorePath).mtimeMs;
    } catch {
      // No .gitignore; mtimeMs stays 0.
    }
  }
  const cacheKey = `${rootPath}\0${respectGitignore ? "gitignore" : "builtin"}`;
  const cached = ignoreCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.matcher;
  }

  const ig = ignore();
  for (const name of ignored) {
    ig.add([`${name}/`, `${name}/**`, `**/${name}/`, `**/${name}/**`]);
  }
  if (respectGitignore && mtimeMs > 0) {
    ig.add(readFileSync(gitignorePath, "utf8"));
  }

  const matcher = (path: string) => {
    const relPath = normalizeRelativePath(
      isAbsolute(path) ? relative(rootPath, path) : path
    );
    if (!relPath || relPath === ".") {
      return false;
    }
    if (relPath.split("/").some((part) => ignored.has(part))) {
      return true;
    }
    return ig.ignores(relPath);
  };
  ignoreCache.set(cacheKey, { mtimeMs, matcher });
  return matcher;
}

function normalizeRelativePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
