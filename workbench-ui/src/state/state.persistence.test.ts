import { describe, expect, test } from "bun:test";
import { restoreSession } from "./state";
import type { PersistedSession } from "./types";

type PersistedWithIds = PersistedSession & {
  id: string;
  harnesses: Array<
    NonNullable<PersistedSession["harnesses"]>[number] & { id: string }
  >;
  terminals: Array<
    NonNullable<PersistedSession["terminals"]>[number] & { id: string }
  >;
};

function persisted(activeMainTab: string): PersistedWithIds {
  return {
    activeMainTab,
    cwd: process.cwd(),
    harnesses: [
      {
        cwd: process.cwd(),
        harnessId: "cursor",
        id: "harness-stable",
        name: "Cursor",
        tmux: "workbench_h_stable",
      },
    ],
    id: "session-stable",
    terminals: [
      {
        cwd: process.cwd(),
        id: "terminal-stable",
        name: "Terminal 1",
        tmux: "workbench_t_stable",
      },
    ],
  };
}

describe("persisted session identity", () => {
  test("restores the same harness, terminal, and session ids", () => {
    const restored = restoreSession(persisted("harness:harness-stable"), []);

    expect(restored.id).toBe("session-stable");
    expect(restored.harnesses[0]?.id).toBe("harness-stable");
    expect(restored.terminals[0]?.id).toBe("terminal-stable");
    expect(restored.activeMainTab).toBe("harness:harness-stable");
  });

  test("restores an active terminal instead of switching to the agent", () => {
    const restored = restoreSession(persisted("term:terminal-stable"), []);

    expect(restored.activeMainTab).toBe("term:terminal-stable");
  });
});
