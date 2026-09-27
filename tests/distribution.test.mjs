import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostInstaller = path.join(root, "install-host.sh");
const installer = path.join(root, "install.sh");

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "workbench distribution "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const bin = path.join(directory, "fake-bin");
  const downloads = path.join(directory, "downloads");
  for (const dir of [home, bin, downloads]) mkdirSync(dir);
  const script = (name, source) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\nset -euo pipefail\n${source}\n`, { mode: 0o755 });
  };
  script("tmux", "exit 0");
  script("bun", 'printf "%s\\n" "$*" >> "$BUN_CAPTURE"');
  script("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
  script("curl", `
url=""; output=""
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf "%s\\n" "$url" >> "$CURL_CAPTURE"
[[ -f "$FIXTURE_DOWNLOADS/\${url##*/}" ]] || exit 22
cp "$FIXTURE_DOWNLOADS/\${url##*/}" "$output"
`);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    WORKBENCH_HOST_HOME: path.join(home, "share", "remote"),
    WORKBENCH_HOST_BIN: path.join(home, "bin"),
    WORKBENCH_CLI_HOME: path.join(home, "share", "cli"),
    WORKBENCH_CLI_BIN: path.join(home, "bin"),
    WORKBENCH_CLI_REPO: "fixture/workbench",
    WORKBENCH_REPO: "fixture/workbench",
    WORKBENCH_VERSION: "v0.1.70",
    WORKBENCH_DOWNLOAD_BASE: "https://downloads.example.test/v0.1.70",
    FIXTURE_DOWNLOADS: downloads,
    CURL_CAPTURE: path.join(directory, "curl.log"),
    BUN_CAPTURE: path.join(directory, "bun.log"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (file, args = [], overrides = {}) => spawnSync("bash", [file, ...args], {
    env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000,
  });
  return { directory, downloads, home, env, run };
}

function makeHostArchive(f, marker = "version-one", prefix = "workbench-host-linux-x64") {
  const source = path.join(f.directory, marker);
  const bin = path.join(source, prefix, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["workbench-remote", "node"]) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${marker}'\n`, { mode: 0o755 });
  }
  const archive = path.join(f.downloads, "workbench-host-linux-x64.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, prefix]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  workbench-host-linux-x64.tar.gz\n`);
  return { archive, digest };
}

function makeCliSource(f) {
  const source = path.join(f.directory, "source");
  mkdirSync(path.join(source, "workbench-ui"), { recursive: true });
  mkdirSync(path.join(source, "bin"));
  copyFileSync(path.join(root, "bin/workbench-cli"), path.join(source, "bin/workbench-cli"));
  copyFileSync(installer, path.join(source, "install.sh"));
  writeFileSync(path.join(source, "workbench-ui/package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  const git = (args) => execFileSync("git", ["-C", source, ...args], {
    env: f.env, stdio: "pipe",
  });
  git(["init", "-q", "--initial-branch=main"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${source}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/fixture/workbench.git",
  };
}

test("CLI install, normal launch, and an old launcher's update survive the monorepo", (t) => {
  const f = fixture(t);
  const gitEnv = makeCliSource(f);
  const installed = f.run(installer, [], gitEnv);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const launcher = path.join(f.env.WORKBENCH_CLI_BIN, "work");
  assert.equal(readlinkSync(launcher), path.join(f.env.WORKBENCH_CLI_HOME, "bin/workbench-cli"));
  assert.match(readFileSync(f.env.BUN_CAPTURE, "utf8"), /install --frozen-lockfile/);
  const launched = f.run(launcher, [], { ...gitEnv, WORKBENCH_CLI_AUTO_UPDATE: "0" });
  assert.equal(launched.status, 0, launched.stderr);
  const updated = f.run(launcher, ["update"], gitEnv);
  assert.equal(updated.status, 0, updated.stderr + updated.stdout);
  assert.ok(existsSync(launcher));
});

test("rerunning the CLI installer refuses a dirty checkout before fetching", (t) => {
  const f = fixture(t);
  const gitEnv = makeCliSource(f);
  assert.equal(f.run(installer, [], gitEnv).status, 0);
  const personal = path.join(f.env.WORKBENCH_CLI_HOME, "personal.txt");
  writeFileSync(personal, "keep me");
  const result = f.run(installer, [], gitEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local changes/);
  assert.equal(readFileSync(personal, "utf8"), "keep me");
});

test("host installs and updates verified binaries while preserving configuration and older versions", (t) => {
  const f = fixture(t);
  const first = makeHostArchive(f);
  const installed = f.run(hostInstaller, ["--relay", "https://relay.example.test"]);
  assert.equal(installed.status, 0, installed.stderr);
  const link = path.join(f.env.WORKBENCH_HOST_BIN, "workbench-remote");
  const original = readlinkSync(link);
  assert.match(original, new RegExp(first.digest.slice(0, 12)));
  const credentials = path.join(f.home, "host.json");
  writeFileSync(credentials, "private config fixture");
  const second = makeHostArchive(f, "version-two");
  assert.equal(f.run(hostInstaller).status, 0);
  assert.match(readlinkSync(link), new RegExp(second.digest.slice(0, 12)));
  assert.ok(existsSync(original));
  assert.equal(readFileSync(credentials, "utf8"), "private config fixture");
  assert.equal(f.run(hostInstaller).status, 0, "reinstall should be idempotent");
});

test("a checksum mismatch cannot replace an existing host", (t) => {
  const f = fixture(t);
  makeHostArchive(f);
  assert.equal(f.run(hostInstaller).status, 0);
  const link = path.join(f.env.WORKBENCH_HOST_BIN, "workbench-remote");
  const original = readlinkSync(link);
  const second = makeHostArchive(f, "tampered");
  writeFileSync(`${second.archive}.sha256`, "0".repeat(64) + "\n");
  const result = f.run(hostInstaller);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(readlinkSync(link), original);
});

test("host refuses unrelated files and symlinks on PATH", (t) => {
  const f = fixture(t);
  makeHostArchive(f);
  mkdirSync(f.env.WORKBENCH_HOST_BIN, { recursive: true });
  const link = path.join(f.env.WORKBENCH_HOST_BIN, "workbench-remote");
  writeFileSync(link, "unrelated");
  assert.match(f.run(hostInstaller).stderr, /unrelated file/);
  assert.equal(readFileSync(link, "utf8"), "unrelated");
  rmSync(link);
  symlinkSync("/unrelated/tool", link);
  assert.match(f.run(hostInstaller).stderr, /unrelated symlink/);
  assert.equal(readlinkSync(link), "/unrelated/tool");
});

test("host rejects an archive whose layout does not match the selected platform", (t) => {
  const f = fixture(t);
  makeHostArchive(f, "wrong-platform", "workbench-host-darwin-arm64");
  const result = f.run(hostInstaller);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected archive layout/);
  assert.equal(existsSync(path.join(f.env.WORKBENCH_HOST_BIN, "workbench-remote")), false);
});

test("shared installer dispatches to the released host installer", (t) => {
  const f = fixture(t);
  makeHostArchive(f);
  copyFileSync(hostInstaller, path.join(f.downloads, "install-host.sh"));
  const result = f.run(installer, ["host", "--relay", "https://relay.example.test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setup --relay https:\/\/relay\.example\.test/);
  assert.ok(existsSync(path.join(f.env.WORKBENCH_HOST_BIN, "workbench-remote")));
});

test("iPhone installer shows a published Apple install link and refuses other URLs", (t) => {
  const f = fixture(t);
  const file = path.join(f.downloads, "iphone-install-url.txt");
  writeFileSync(file, "https://testflight.apple.com/join/Fixture1\n");
  const result = f.run(installer, ["app"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/testflight\.apple\.com\/join\/Fixture1/);
  writeFileSync(file, "https://unrelated.example.test/download");
  assert.equal(f.run(installer, ["app"]).status, 1);
  rmSync(file);
  const missing = f.run(installer, ["app"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not published/);
});

test("release check rejects a tag that disagrees with product versions", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/version.mjs"), "--check"], {
    env: { ...process.env, RELEASE_TAG: "v999.0.0" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version/);
});
