import { describe, expect, test } from "bun:test";

// workbench-paths resolves its namespace once at module load from the
// environment, so each case runs a fresh child process with a controlled env.
async function resolvePaths(env: Record<string, string>): Promise<{
  attachesRealSessions: boolean;
  dir: string;
  isolated: boolean;
  socket: string;
  state: string;
}> {
  const script = `
    const m = await import("${import.meta.dir}/workbench-paths.ts");
    console.log(JSON.stringify({
      attachesRealSessions: m.hotAttachesRealSessions(),
      dir: m.workbenchDir(),
      isolated: m.isolatedInstance(),
      socket: m.tmuxSocketPath(),
      state: m.persistedStatePath(),
    }));
  `;
  const child = Bun.spawn(["bun", "-e", script], {
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `resolver failed: ${await new Response(child.stderr).text()}`
    );
  }
  return JSON.parse(out);
}

describe("workbench namespace selection", () => {
  test("an ordinary launch uses the real ~/.workbench namespace", async () => {
    const paths = await resolvePaths({
      HOME: "/tmp/wb-paths-home",
      WORKBENCH_CLI_HOT: "0",
    });
    expect(paths.dir).toBe("/tmp/wb-paths-home/.workbench");
    expect(paths.socket).toBe("/tmp/wb-paths-home/.workbench/tmux-ui.sock");
    expect(paths.state).toBe(
      "/tmp/wb-paths-home/.workbench/workbench-ui-state.json"
    );
    expect(paths.isolated).toBe(false);
    expect(paths.attachesRealSessions).toBe(false);
  });

  test("a hot launch reuses the real socket and state file", async () => {
    const real = await resolvePaths({
      HOME: "/tmp/wb-paths-home",
      WORKBENCH_CLI_HOT: "0",
    });
    const hot = await resolvePaths({
      HOME: "/tmp/wb-paths-home",
      WORKBENCH_CLI_HOT: "1",
      WORKBENCH_CLI_HOT_ROOT: "/mnt/nvme/programs/workbench-cli",
    });
    expect(hot.socket).toBe(real.socket);
    expect(hot.state).toBe(real.state);
    expect(hot.isolated).toBe(false);
    expect(hot.attachesRealSessions).toBe(true);
  });

  test("an explicitly isolated hot namespace is stable across restarts", async () => {
    const env = {
      HOME: "/tmp/wb-paths-home",
      WORKBENCH_CLI_HOT: "1",
      WORKBENCH_CLI_HOT_ISOLATED: "1",
      WORKBENCH_CLI_HOT_ROOT: "/mnt/nvme/programs/workbench-cli",
    };
    const first = await resolvePaths(env);
    const second = await resolvePaths(env);
    // Hot reload must reattach the same running agents after every restart, so
    // the namespace cannot be randomised per launch.
    expect(second.dir).toBe(first.dir);
    expect(first.isolated).toBe(true);
    expect(first.attachesRealSessions).toBe(false);
  });

  test("isolated hot checkouts get different namespaces", async () => {
    const a = await resolvePaths({
      HOME: "/tmp/wb-paths-home",
      WORKBENCH_CLI_HOT: "1",
      WORKBENCH_CLI_HOT_ISOLATED: "1",
      WORKBENCH_CLI_HOT_ROOT: "/mnt/nvme/programs/workbench-cli",
    });
    const b = await resolvePaths({
      HOME: "/tmp/wb-paths-home",
      WORKBENCH_CLI_HOT: "1",
      WORKBENCH_CLI_HOT_ISOLATED: "1",
      WORKBENCH_CLI_HOT_ROOT: "/home/someone/other-checkout",
    });
    expect(a.dir).not.toBe(b.dir);
  });
});
