import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  killPersistentTmuxSession,
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
  test("shows an unavailable persisted workspace without crashing", async () => {
    const workspace = join(suiteRoot, "missing-workspace");
    const panel = new TerminalPanel(workspace, 80, 24, {
      command: "exit 1",
      persist: {
        name: "missing_workspace_test",
        socketPath: join(suiteRoot, "missing-workspace.sock"),
      },
    });

    expect(() => panel.start()).not.toThrow();
    await Bun.sleep(10);
    expect(
      panel
        .getLines()
        .map((row) => row.map((cell) => cell.char).join(""))
        .join("\n")
    ).toContain("Workspace unavailable:");
    panel.kill();
  });

  test("kills an unopened persisted pane by identity", () => {
    const socketPath = join(suiteRoot, "unopened-close.sock");
    const persist = { name: "unopened_close_test", socketPath };
    const created = Bun.spawnSync([
      "tmux",
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      persist.name,
      "sleep 30",
    ]);
    expect(created.exitCode).toBe(0);

    try {
      expect(killPersistentTmuxSession(persist)).toBe(true);
      const remaining = Bun.spawnSync(
        ["tmux", "-S", socketPath, "has-session", "-t", persist.name],
        { stderr: "ignore", stdout: "ignore" }
      );
      expect(remaining.exitCode).not.toBe(0);
    } finally {
      killServer(socketPath);
    }
  });

  test("interactive shell startup cannot leave the workspace", async () => {
    const workspace = join(suiteRoot, "shell-workspace");
    const startupDirectory = join(suiteRoot, "shell-startup-directory");
    mkdirSync(workspace);
    mkdirSync(startupDirectory);
    writeFileSync(join(suiteRoot, ".bash_profile"), 'source "$HOME/.bashrc"\n');
    writeFileSync(
      join(suiteRoot, ".bashrc"),
      `cd ${shellQuote(startupDirectory)}\n`
    );
    const socketPath = join(suiteRoot, "interactive-cwd.sock");
    const persist = { name: "interactive_cwd_test", socketPath };
    const previousShell = Bun.env.SHELL;
    Bun.env.SHELL = "/bin/bash";
    const panel = new TerminalPanel(workspace, 80, 24, { persist });

    try {
      panel.start();
      expect(await waitForPanePath(socketPath, persist.name)).toBe(
        realpathSync(workspace)
      );
    } finally {
      if (previousShell === undefined) {
        delete Bun.env.SHELL;
      } else {
        Bun.env.SHELL = previousShell;
      }
      panel.kill();
      killServer(socketPath);
    }
  });

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

  test("re-signals a dormant TUI after attaching it at a new size", async () => {
    const socketPath = join(suiteRoot, "reattach-redraw.sock");
    const persist = { name: "reattach_redraw_test", socketPath };
    const redrawPath = join(suiteRoot, "reattach-redraw-rows.txt");
    const armedPath = join(suiteRoot, "reattach-redraw-armed");
    const fixturePath = join(suiteRoot, "reattach-redraw.sh");
    writeFileSync(
      fixturePath,
      [
        "#!/bin/bash",
        "redraw() {",
        "  set -- $(stty size)",
        `  printf %s "$1" > ${shellQuote(redrawPath)}`,
        '  printf "\\033[2J\\033[%s;1HCOMPOSER" "$(( $1 - 2 ))"',
        "}",
        `trap '[ -f ${shellQuote(armedPath)} ] && redraw' WINCH`,
        "redraw",
        "while :; do sleep 1 & wait $!; done",
      ].join("\n")
    );
    const created = Bun.spawnSync([
      "tmux",
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-x",
      "100",
      "-y",
      "24",
      "-s",
      persist.name,
      `/bin/bash ${shellQuote(fixturePath)}`,
    ]);
    expect(created.exitCode).toBe(0);
    await waitForFileContent(redrawPath, "24");

    const panel = new TerminalPanel(suiteRoot, 80, 30, {
      command: "sleep 30",
      persist,
    });
    try {
      panel.start();
      await waitForClients(socketPath, persist.name, 1);
      // Arm only after tmux's attach-time resize has settled. Workbench must
      // send a second redraw signal once ownership and geometry are stable.
      await Bun.sleep(150);
      const expectedRows = String(paneHeight(socketPath, persist.name));
      expect(expectedRows).not.toBe("24");
      writeFileSync(armedPath, "ready");
      await waitForFileContent(redrawPath, expectedRows);
    } finally {
      panel.kill();
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

async function waitForFileContent(path: string, expected: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8") === expected) {
      return;
    }
    await Bun.sleep(25);
  }
  const actual = existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
  throw new Error(
    `fixture ${path} remained ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`
  );
}

async function waitForPanePath(socketPath: string, sessionName: string) {
  let current = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = Bun.spawnSync(
      [
        "tmux",
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        sessionName,
        "#{pane_current_path}",
      ],
      { stderr: "ignore", stdout: "pipe" }
    );
    if (result.exitCode === 0) {
      current = new TextDecoder().decode(result.stdout).trim();
      if (current) {
        return current;
      }
    }
    await Bun.sleep(20);
  }
  return current;
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

function paneHeight(socketPath: string, session: string): number {
  const result = Bun.spawnSync(
    [
      "tmux",
      "-S",
      socketPath,
      "display-message",
      "-p",
      "-t",
      session,
      "#{pane_height}",
    ],
    { stderr: "ignore", stdout: "pipe" }
  );
  return Number(new TextDecoder().decode(result.stdout).trim());
}

function killServer(socketPath: string) {
  Bun.spawnSync(["tmux", "-S", socketPath, "kill-server"], {
    stderr: "ignore",
    stdout: "ignore",
  });
}
