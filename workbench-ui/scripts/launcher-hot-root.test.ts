import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// `work --hot` resolves through the installed checkout's launcher, whose hot
// runner would otherwise run and watch ITS OWN sources — edits in a dev
// checkout would neither run nor reload. These tests pin the launcher's
// hot-root detection by exec-ing the real bash launcher with a stub `bun`
// that prints the entry it would run.

const repoLauncher = join(import.meta.dir, "..", "..", "bin", "workbench-cli");

interface LauncherRun {
  exitCode: number;
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
    `#!/usr/bin/env bash
if [ "$#" -gt 0 ] && [ "$1" = "-e" ]; then exit 0; fi
echo "BUN-EXEC: $*"
echo "RESTART-SUPERVISOR: \${WORKBENCH_CLI_RESTART_SUPERVISOR:-0}"
if [[ -n "\${WORKBENCH_TEST_RESTART_FILE:-}" && ! -e "$WORKBENCH_TEST_RESTART_FILE" ]]; then
  touch "$WORKBENCH_TEST_RESTART_FILE"
  exit 75
fi
`
  );
  chmodSync(stub, 0o755);
  return {
    installed: realpathSync(installed),
    stubPath: realpathSync(stubDir),
  };
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
  return realpathSync(dev);
}

function runLauncher(
  installed: string,
  stubPath: string,
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  bash = "bash"
): LauncherRun {
  const result = Bun.spawnSync(
    [bash, join(installed, "bin", "workbench-cli"), ...args],
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
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

describe("workbench-cli shell compatibility", () => {
  test("launches with zero arguments under the system Bash", () => {
    const root = "/tmp/wb-launcher-test-system-bash-empty-args";
    const { installed, stubPath } = setup(root);

    const run = runLauncher(installed, stubPath, "/tmp", [], {}, "/bin/bash");
    expect(run.stderr).not.toContain("args[@]: unbound variable");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `BUN-EXEC: ${join(installed, "workbench-ui", "src", "index.ts")}`
    );
    rmSync(root, { force: true, recursive: true });
  });

  test("launches through its shebang with workspace arguments intact", () => {
    const root = "/tmp/wb-launcher-test-caller-shell";
    const { installed, stubPath } = setup(root);
    const launcher = join(installed, "bin", "workbench-cli");
    const workspace = join(root, "workspace with spaces");
    mkdirSync(workspace, { recursive: true });

    // zsh, fish, and Bash all launch `work` as an executable; the kernel then
    // honors its Bash shebang. Invoke it the same way here to ensure the caller
    // shell cannot affect parsing and forwarded arguments retain boundaries.
    const result = Bun.spawnSync([launcher, workspace], {
      cwd: "/tmp",
      env: {
        ...Bun.env,
        PATH: `${stubPath}:${Bun.env.PATH ?? ""}`,
      },
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      `BUN-EXEC: ${join(installed, "workbench-ui", "src", "index.ts")} ${workspace}`
    );
    rmSync(root, { force: true, recursive: true });
  });
});

describe("workbench-cli --hot source-checkout detection", () => {
  test("restarts the current Workbench after an in-app update handoff", () => {
    const root = "/tmp/wb-launcher-test-update-restart";
    const { installed, stubPath } = setup(root);
    const restartMarker = join(root, "restart-once");

    const run = runLauncher(installed, stubPath, "/tmp", [], {
      WORKBENCH_TEST_RESTART_FILE: restartMarker,
    });
    expect(run.stdout.match(/BUN-EXEC:/g)).toHaveLength(2);
    expect(run.stdout.match(/RESTART-SUPERVISOR: 1/g)).toHaveLength(2);
    rmSync(root, { force: true, recursive: true });
  });

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
