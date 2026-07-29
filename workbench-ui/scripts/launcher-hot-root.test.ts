import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `work --hot` resolves through the installed checkout's launcher, whose hot
// runner would otherwise run and watch ITS OWN sources — edits in a dev
// checkout would neither run nor reload. These tests pin the launcher's
// hot-root detection by exec-ing the real bash launcher with a stub `bun`
// that prints the entry it would run.

const repoLauncher = join(import.meta.dir, "..", "..", "bin", "workbench-cli");

interface LauncherRun {
  stderr: string;
  stdout: string;
}

function setup(root: string): { installed: string; stubPath: string } {
  rmSync(root, { force: true, recursive: true });
  const installed = join(root, "installed");
  mkdirSync(join(installed, "bin"), { recursive: true });
  mkdirSync(join(installed, "workbench-ui", "src"), { recursive: true });
  mkdirSync(join(installed, "workbench-ui", "scripts"), { recursive: true });
  writeFileSync(join(installed, "workbench-ui", "src", "index.ts"), "");
  writeFileSync(
    join(installed, "workbench-ui", "scripts", "hot-runner.ts"),
    ""
  );
  Bun.spawnSync(["cp", repoLauncher, join(installed, "bin", "workbench-cli")]);
  const stubDir = join(root, "stub");
  mkdirSync(stubDir, { recursive: true });
  const stub = join(stubDir, "bun");
  writeFileSync(
    stub,
    '#!/usr/bin/env bash\nif [ "$#" -gt 0 ] && [ "$1" = "-e" ]; then exit 0; fi\necho "BUN-EXEC: $*"\n'
  );
  chmodSync(stub, 0o755);
  return { installed, stubPath: stubDir };
}

function devCheckout(root: string, withDeps: boolean): string {
  const dev = join(root, "dev");
  mkdirSync(join(dev, "bin"), { recursive: true });
  mkdirSync(join(dev, "workbench-ui", "src"), { recursive: true });
  writeFileSync(join(dev, "workbench-ui", "src", "index.ts"), "");
  writeFileSync(join(dev, "bin", "workbench-cli"), "");
  if (withDeps) {
    mkdirSync(join(dev, "workbench-ui", "node_modules", "silvery"), {
      recursive: true,
    });
  }
  return dev;
}

function runLauncher(
  installed: string,
  stubPath: string,
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): LauncherRun {
  const result = Bun.spawnSync(
    ["bash", join(installed, "bin", "workbench-cli"), ...args],
    {
      cwd,
      env: {
        ...Bun.env,
        ...env,
        PATH: `${stubPath}:${Bun.env.PATH ?? ""}`,
      },
    }
  );
  return {
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

describe("workbench-cli --hot source-checkout detection", () => {
  test("runs and watches the dev checkout containing the cwd", () => {
    const root = "/tmp/wb-launcher-test-detect";
    const { installed, stubPath } = setup(root);
    const dev = devCheckout(root, true);
    const nested = join(dev, "workbench-ui", "src");

    const run = runLauncher(installed, stubPath, nested, ["--hot"]);
    expect(run.stderr).toContain(`running source checkout ${dev}`);
    expect(run.stdout).toContain(
      `BUN-EXEC: ${join(dev, "workbench-ui", "scripts", "hot-runner.ts")}`
    );
    rmSync(root, { force: true, recursive: true });
  });

  test("falls back to the installed checkout outside any dev checkout", () => {
    const root = "/tmp/wb-launcher-test-fallback";
    const { installed, stubPath } = setup(root);

    const run = runLauncher(installed, stubPath, "/tmp", ["--hot"]);
    expect(run.stderr).not.toContain("running source checkout");
    expect(run.stdout).toContain(
      `BUN-EXEC: ${join(installed, "workbench-ui", "scripts", "hot-runner.ts")}`
    );
    rmSync(root, { force: true, recursive: true });
  });

  test("warns and falls back when the dev checkout has no dependencies", () => {
    const root = "/tmp/wb-launcher-test-nodeps";
    const { installed, stubPath } = setup(root);
    const dev = devCheckout(root, false);

    const run = runLauncher(installed, stubPath, dev, ["--hot"]);
    expect(run.stderr).toContain("dependencies are missing");
    expect(run.stdout).toContain(
      `BUN-EXEC: ${join(installed, "workbench-ui", "scripts", "hot-runner.ts")}`
    );
    rmSync(root, { force: true, recursive: true });
  });

  test("honors an explicit WORKBENCH_CLI_HOT_ROOT override", () => {
    const root = "/tmp/wb-launcher-test-override";
    const { installed, stubPath } = setup(root);
    const dev = devCheckout(root, true);

    const run = runLauncher(installed, stubPath, "/tmp", ["--hot"], {
      WORKBENCH_CLI_HOT_ROOT: dev,
    });
    expect(run.stderr).toContain(`running source checkout ${dev}`);
    expect(run.stdout).toContain(
      `BUN-EXEC: ${join(dev, "workbench-ui", "scripts", "hot-runner.ts")}`
    );
    rmSync(root, { force: true, recursive: true });
  });

  test("does not affect non-hot launches", () => {
    const root = "/tmp/wb-launcher-test-nonhot";
    const { installed, stubPath } = setup(root);
    const dev = devCheckout(root, true);

    const run = runLauncher(installed, stubPath, dev, []);
    expect(run.stderr).not.toContain("running source checkout");
    expect(run.stdout).toContain(
      `BUN-EXEC: ${join(installed, "workbench-ui", "src", "index.ts")}`
    );
    rmSync(root, { force: true, recursive: true });
  });
});
