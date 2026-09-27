import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildExplorerEntries,
  createExplorerIgnore,
  ensureWorkspaceDirectory,
  isExistingDirectory,
} from "./file-tree";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function createTempRoot() {
  const root = mkdtempSync(join(import.meta.dir, ".file-tree-test-"));
  tempRoots.push(root);
  return root;
}

describe("buildExplorerEntries", () => {
  test.skipIf(process.platform === "win32")(
    "opens a workspace containing a literal backslash directory",
    () => {
      const root = createTempRoot();
      const folder = join(root, "\\");
      mkdirSync(folder);
      writeFileSync(join(folder, "notes.txt"), "hello");
      const entries = buildExplorerEntries(root, new Set([folder]));
      expect(entries.map((entry) => entry.path)).toEqual([
        folder,
        join(folder, "notes.txt"),
      ]);
    }
  );

  test("shows and expands gitignored directories", () => {
    const root = createTempRoot();
    const runs = join(root, "runs");
    mkdirSync(runs);
    writeFileSync(join(root, ".gitignore"), "runs/\n");
    writeFileSync(join(runs, "metrics.json"), "{}\n");

    const collapsed = buildExplorerEntries(root, new Set());
    expect(collapsed.some((entry) => entry.path === runs)).toBe(true);

    const expanded = buildExplorerEntries(root, new Set([runs]));
    expect(
      expanded.some((entry) => entry.path === join(runs, "metrics.json"))
    ).toBe(true);
  });

  test("keeps gitignore filtering available to diff scans", () => {
    const root = createTempRoot();
    const runs = join(root, "runs");
    const metrics = join(runs, "metrics.json");
    mkdirSync(runs);
    writeFileSync(join(root, ".gitignore"), "runs/\n");
    writeFileSync(metrics, "{}\n");

    expect(createExplorerIgnore(root)(metrics)).toBe(true);
    expect(
      createExplorerIgnore(root, { respectGitignore: false })(metrics)
    ).toBe(false);
  });
});

describe("createExplorerIgnore", () => {
  test.skipIf(process.platform === "win32")(
    "keeps backslashes literal while matching actual directory separators",
    () => {
      const root = createTempRoot();
      writeFileSync(join(root, ".gitignore"), "*.tmp\n");
      const shouldIgnore = createExplorerIgnore(root);
      for (const name of [
        "\\",
        "\\notes",
        "node_modules\\notes.txt",
        "notes\\node_modules",
      ]) {
        expect(shouldIgnore(name)).toBe(false);
        expect(shouldIgnore(join(root, name))).toBe(false);
      }
      expect(shouldIgnore(join(root, "\\", "notes.tmp"))).toBe(true);
      expect(
        shouldIgnore(join(root, "\\", "node_modules", "package.json"))
      ).toBe(true);
      expect(shouldIgnore(join(root, "node_modules", "package.json"))).toBe(
        true
      );
    }
  );

  test("allows watcher traversal paths outside the workspace root", () => {
    const shouldIgnore = createExplorerIgnore("/workspace/project", {
      respectGitignore: false,
    });

    expect(shouldIgnore("/workspace")).toBe(false);
    expect(shouldIgnore("/workspace/sibling")).toBe(false);
  });
});

describe("ensureWorkspaceDirectory", () => {
  test("creates a missing nested workspace path", () => {
    const root = createTempRoot();
    const workspace = join(root, "projects", "new-workspace");

    ensureWorkspaceDirectory(workspace);

    expect(isExistingDirectory(workspace)).toBe(true);
  });

  test("accepts an existing workspace directory", () => {
    const root = createTempRoot();

    expect(() => ensureWorkspaceDirectory(root)).not.toThrow();
  });

  test("rejects a workspace path occupied by a file", () => {
    const root = createTempRoot();
    const file = join(root, "not-a-directory");
    writeFileSync(file, "content\n");

    expect(() => ensureWorkspaceDirectory(file)).toThrow();
  });
});
