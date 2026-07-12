import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildExplorerEntries, createExplorerIgnore } from "./file-tree";

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
