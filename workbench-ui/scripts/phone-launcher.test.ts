import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("phone dependency failures report a safe JSON error instead of hiding the cause", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-phone-launcher-"));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "apps", "remote"), { recursive: true });
    copyFileSync(
      join(import.meta.dir, "..", "..", "bin", "workbench-phone"),
      join(root, "bin", "workbench-phone")
    );
    writeFileSync(join(root, "apps", "remote", "package-lock.json"), "{}");
    const node = Bun.spawnSync(["which", "node"]).stdout.toString().trim();
    symlinkSync(node, join(root, "bin", "node"));
    writeFileSync(
      join(root, "bin", "npm"),
      '#!/bin/sh\necho "private-registry-token" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    const run = Bun.spawnSync(
      ["bash", join(root, "bin", "workbench-phone"), "pair", "--json"],
      { env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}` } }
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("private-registry-token");
    const event = JSON.parse(run.stdout.toString());
    expect(event.type).toBe("error");
    expect(event.message).toContain("Installing phone dependencies failed");
    expect(event.message).toContain("containers");
    expect(run.stdout.toString()).not.toContain("private-registry-token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
