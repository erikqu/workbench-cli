import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

describe("workbench-cli update", () => {
  test("updates the resolved installation and preserves its symlink directory", () => {
    const fixture = createFixture();
    const result = Bun.spawnSync([fixture.launcher, "update"], {
      env: {
        HOME: fixture.home,
        PATH: "/usr/bin:/bin",
        UPDATE_CAPTURE: fixture.capture,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.capture, "utf8")).toBe(
      `${realpathSync(fixture.packageRoot)}\n${realpathSync(dirname(fixture.launcher))}\n`
    );
  });

  test("automatically installs a newer revision before startup", () => {
    const fixture = createFixture();
    const fakeBin = join(fixture.home, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == "ls-remote" ]]; then
  printf '%s\\t%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'refs/heads/main'
  exit 0
fi
exec ${resolveGit()} "$@"
`
    );
    writeFileSync(join(fakeBin, "bun"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(fakeBin, "git"), 0o755);
    chmodSync(join(fakeBin, "bun"), 0o755);

    const result = Bun.spawnSync([fixture.launcher], {
      env: {
        HOME: fixture.home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        UPDATE_CAPTURE: fixture.capture,
        WORKBENCH_CLI_HOME: realpathSync(fixture.packageRoot),
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.capture, "utf8")).toBe(
      `${realpathSync(fixture.packageRoot)}\n${realpathSync(dirname(fixture.launcher))}\n`
    );
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "A Workbench update is available"
    );
  });

  test("refuses to overwrite local checkout changes", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.packageRoot, "local-change.txt"), "mine\n");

    const result = Bun.spawnSync([fixture.launcher, "update"], {
      env: {
        HOME: fixture.home,
        PATH: "/usr/bin:/bin",
        UPDATE_CAPTURE: fixture.capture,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("local changes");
    expect(existsSync(fixture.capture)).toBe(false);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-update-"));
  const packageRoot = join(root, "share", "workbench-cli");
  const packageBin = join(packageRoot, "bin");
  const userBin = join(root, "bin");
  const home = join(root, "home");
  const capture = join(root, "update-capture.txt");
  mkdirSync(packageBin, { recursive: true });
  mkdirSync(join(packageRoot, "workbench-ui"), { recursive: true });
  mkdirSync(userBin, { recursive: true });
  mkdirSync(home, { recursive: true });
  cpSync(
    join(repositoryRoot, "bin", "workbench-cli"),
    join(packageBin, "workbench-cli")
  );
  chmodSync(join(packageBin, "workbench-cli"), 0o755);
  writeFileSync(
    join(packageRoot, "install.sh"),
    '#!/usr/bin/env bash\nprintf "%s\\n%s\\n" "$WORKBENCH_CLI_HOME" "$WORKBENCH_CLI_BIN" > "$UPDATE_CAPTURE"\n'
  );
  chmodSync(join(packageRoot, "install.sh"), 0o755);
  git(packageRoot, ["init", "-q"]);
  git(packageRoot, ["config", "user.email", "fixture@example.com"]);
  git(packageRoot, ["config", "user.name", "Fixture"]);
  git(packageRoot, ["add", "."]);
  git(packageRoot, ["commit", "-qm", "fixture"]);
  const launcher = join(userBin, "workbench-cli");
  symlinkSync(join(packageBin, "workbench-cli"), launcher);
  return { capture, home, launcher, packageRoot };
}

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function resolveGit(): string {
  const result = Bun.spawnSync(["bash", "-lc", "command -v git"], {
    stdout: "pipe",
  });
  return new TextDecoder().decode(result.stdout).trim();
}
