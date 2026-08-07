import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  restartServerIfPermissionStale,
  shellQuote,
  TerminalPanel,
} from "./terminal-panel";

const hasTmux = Bun.which("tmux") !== null;
const hasSandboxExec =
  process.platform === "darwin" && Bun.which("sandbox-exec") !== null;
const suiteRoot = mkdtempSync(join(tmpdir(), "workbench-tmux-integration-"));
const originalHome = Bun.env.HOME;

beforeAll(() => {
  Bun.env.HOME = suiteRoot;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete Bun.env.HOME;
  } else {
    Bun.env.HOME = originalHome;
  }
  rmSync(suiteRoot, { force: true, recursive: true });
});

describe.skipIf(!hasTmux)("TerminalPanel private tmux ownership", () => {
  test("starts a new pane in its requested workspace directory", async () => {
    const workspace = join(suiteRoot, "workspace 'quoted'");
    mkdirSync(workspace);
    const socketPath = join(suiteRoot, "cwd.sock");
    const cwdPath = join(suiteRoot, "pane-cwd.txt");
    const persist = { name: "cwd_test", socketPath };
    const command = `pwd -P > ${shellQuote(cwdPath)}; sleep 30`;
    const panel = new TerminalPanel(workspace, 80, 24, { command, persist });

    try {
      panel.start();
      await waitForFile(cwdPath);
      expect(readFileSync(cwdPath, "utf8").trim()).toBe(
        realpathSync(workspace)
      );
    } finally {
      panel.kill();
      killServer(socketPath);
    }
  });

  test("a new owner detaches the previous client", async () => {
    const socketPath = join(suiteRoot, "owner.sock");
    const persist = { name: "owner_test", socketPath };
    const first = new TerminalPanel(suiteRoot, 80, 24, {
      command: "sleep 30",
      persist,
    });
    const second = new TerminalPanel(suiteRoot, 100, 30, {
      command: "sleep 30",
      persist,
    });

    try {
      first.start();
      await waitForClients(socketPath, persist.name, 1);
      second.start();
      await Bun.sleep(250);

      expect(clientCount(socketPath, persist.name)).toBe(1);
    } finally {
      second.kill();
      first.detach();
      killServer(socketPath);
    }
  });

  test("new panes prefer tmux-256color when its terminfo exists", async () => {
    const terminfo = Bun.spawnSync(["infocmp", "tmux-256color"], {
      stderr: "ignore",
      stdout: "ignore",
    });
    if (terminfo.exitCode !== 0) {
      return;
    }

    const socketPath = join(suiteRoot, "term.sock");
    const termPath = join(suiteRoot, "pane-term.txt");
    const persist = { name: "term_test", socketPath };
    const command = `printf %s "$TERM" > ${shellQuote(termPath)}; sleep 30`;
    const panel = new TerminalPanel(suiteRoot, 80, 24, { command, persist });

    try {
      panel.start();
      await waitForFile(termPath);
      expect(readFileSync(termPath, "utf8")).toBe("tmux-256color");
    } finally {
      panel.kill();
      killServer(socketPath);
    }
  });

  test("upgrading the default TERM leaves an existing pane running", async () => {
    const terminfo = Bun.spawnSync(["infocmp", "tmux-256color"], {
      stderr: "ignore",
      stdout: "ignore",
    });
    if (terminfo.exitCode !== 0) {
      return;
    }

    const socketPath = join(suiteRoot, "preserve.sock");
    const oldTermPath = join(suiteRoot, "old-pane-term.txt");
    const newTermPath = join(suiteRoot, "new-pane-term.txt");
    const oldCommand = `printf %s "$TERM" > ${shellQuote(oldTermPath)}; sleep 30`;
    const created = Bun.spawnSync(
      [
        "tmux",
        "-S",
        socketPath,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "existing_session",
        oldCommand,
      ],
      { stderr: "pipe", stdout: "ignore" }
    );
    expect(created.exitCode).toBe(0);
    await waitForFile(oldTermPath);
    const existingTerm = readFileSync(oldTermPath, "utf8");
    const existingPanePid = panePid(socketPath, "existing_session");

    const newCommand = `printf %s "$TERM" > ${shellQuote(newTermPath)}; sleep 30`;
    const panel = new TerminalPanel(suiteRoot, 80, 24, {
      command: newCommand,
      persist: { name: "new_session", socketPath },
    });
    try {
      panel.start();
      await waitForFile(newTermPath);
      expect(readFileSync(oldTermPath, "utf8")).toBe(existingTerm);
      expect(panePid(socketPath, "existing_session")).toBe(existingPanePid);
      expect(readFileSync(newTermPath, "utf8")).toBe("tmux-256color");
      const existing = Bun.spawnSync(
        ["tmux", "-S", socketPath, "has-session", "-t", "existing_session"],
        { stderr: "ignore", stdout: "ignore" }
      );
      expect(existing.exitCode).toBe(0);
    } finally {
      panel.kill();
      killServer(socketPath);
    }
  });
  test("leaves a healthy server alone when checking permissions", async () => {
    const socketPath = join(suiteRoot, "healthy.sock");
    const workspace = join(suiteRoot, "healthy-workspace");
    mkdirSync(workspace);
    const created = Bun.spawnSync(
      [
        "tmux",
        "-S",
        socketPath,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "healthy_seed",
        "sleep 30",
      ],
      { stderr: "ignore", stdout: "ignore" }
    );
    expect(created.exitCode).toBe(0);

    try {
      expect(restartServerIfPermissionStale(socketPath, workspace)).toBe(false);
      const seed = Bun.spawnSync(
        ["tmux", "-S", socketPath, "has-session", "-t", "healthy_seed"],
        { stderr: "ignore", stdout: "ignore" }
      );
      expect(seed.exitCode).toBe(0);
    } finally {
      killServer(socketPath);
    }
  });
});

// End-to-end reproduction of the macOS folder-privacy (TCC) failure: a
// persistent tmux server whose grant went stale is denied access to the pane's
// workspace, so every agent it spawns there dies instantly with EPERM and the
// pane shows "[exited]". sandbox-exec stands in for TCC by starting the server
// with the workspace directory unreadable. A new panel pointed at that
// workspace must replace the stale server and run its command in a fresh one.
describe.skipIf(!(hasTmux && hasSandboxExec))(
  "TerminalPanel stale-permission server recovery",
  () => {
    test("restarts a server that cannot read the pane workspace", async () => {
      const socketPath = join(suiteRoot, "stale.sock");
      const workspace = join(suiteRoot, "denied-workspace");
      mkdirSync(workspace);
      const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(
        realpathSync(workspace)
      )}))`;
      const created = Bun.spawnSync(
        [
          "sandbox-exec",
          "-p",
          profile,
          "tmux",
          "-S",
          socketPath,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "stale_seed",
          "sleep 300",
        ],
        { stderr: "pipe", stdout: "ignore" }
      );
      expect(created.exitCode).toBe(0);
      // The simulated TCC denial is real: the server cannot list the
      // workspace even though this test process can.
      const denied = Bun.spawnSync(
        [
          "tmux",
          "-S",
          socketPath,
          "run-shell",
          `ls ${shellQuote(workspace)} >/dev/null 2>&1`,
        ],
        { stderr: "ignore", stdout: "ignore" }
      );
      expect(denied.exitCode).not.toBe(0);

      const provePath = join(workspace, "pane-alive.txt");
      const command = `ls . && pwd -P > ${shellQuote(provePath)}; sleep 30`;
      const panel = new TerminalPanel(workspace, 80, 24, {
        command,
        persist: { name: "recovered_session", socketPath },
      });
      try {
        panel.start();
        await waitForFile(provePath);
        expect(readFileSync(provePath, "utf8").trim()).toBe(
          realpathSync(workspace)
        );
        // The stale server (and its seed session) was replaced, not reused.
        const seed = Bun.spawnSync(
          ["tmux", "-S", socketPath, "has-session", "-t", "stale_seed"],
          { stderr: "ignore", stdout: "ignore" }
        );
        expect(seed.exitCode).not.toBe(0);
      } finally {
        panel.kill();
        killServer(socketPath);
      }
    });
  }
);

async function waitForClients(
  socketPath: string,
  session: string,
  expected: number
) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (clientCount(socketPath, session) >= expected) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`tmux session ${session} never gained ${expected} client(s)`);
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`fixture did not write ${path}`);
}

function clientCount(socketPath: string, session: string): number {
  const result = Bun.spawnSync(
    [
      "tmux",
      "-S",
      socketPath,
      "list-clients",
      "-t",
      session,
      "-F",
      "#{client_pid}",
    ],
    { stderr: "ignore", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return 0;
  }
  return new TextDecoder().decode(result.stdout).split("\n").filter(Boolean)
    .length;
}

function panePid(socketPath: string, session: string): string {
  const result = Bun.spawnSync(
    [
      "tmux",
      "-S",
      socketPath,
      "list-panes",
      "-t",
      session,
      "-F",
      "#{pane_pid}",
    ],
    { stderr: "ignore", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return "";
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function killServer(socketPath: string) {
  Bun.spawnSync(["tmux", "-S", socketPath, "kill-server"], {
    stderr: "ignore",
    stdout: "ignore",
  });
}
