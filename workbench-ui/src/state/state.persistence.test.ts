import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPersistedStateFile,
  restoreSession,
  restoreSessions,
  writePersistedStateFile,
} from "./state";
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

  test("restores terminals in their owning workspace directory", () => {
    const saved = persisted("term:terminal-stable");
    saved.cwd = "/workspace/project";
    saved.terminals[0].cwd = "/stale/terminal/directory";

    const restored = restoreSession(saved, []);

    expect(restored.terminals[0]?.cwd).toBe("/workspace/project");
  });

  test("restores the file tree with every directory collapsed", () => {
    const saved = persisted("harness:harness-stable");
    saved.expandedDirs = ["/workspace/project/src"];

    const restored = restoreSession(saved, []);

    expect(restored.expandedDirs.size).toBe(0);
  });

  test("keeps a session whose workspace is temporarily unavailable", () => {
    const saved = persisted("harness:harness-stable");
    saved.cwd = "/definitely/not/mounted/workspace";

    const restored = restoreSessions([saved]);

    expect(restored).toHaveLength(1);
    expect(restored[0]?.cwd).toBe(saved.cwd);
    expect(restored[0]?.harnesses[0]?.tmux).toBe("workbench_h_stable");
  });
});

describe("persisted state files", () => {
  test("writes atomically and preserves the last different session set", () => {
    const directory = mkdtempSync(join(tmpdir(), "workbench-state-"));
    const path = join(directory, "state.json");
    const backup = `${path}.bak`;
    const first = {
      sessions: [
        { cwd: "/workspace/one", id: "one" },
        { cwd: "/workspace/two", id: "two" },
      ],
      themeName: "dark",
    };
    const reduced = {
      sessions: [{ cwd: "/workspace/one", id: "one" }],
      themeName: "dark",
    };

    writePersistedStateFile(path, backup, first);
    writePersistedStateFile(path, backup, reduced);
    writePersistedStateFile(path, backup, {
      ...reduced,
      themeName: "light",
    });

    expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(first);
    expect(readPersistedStateFile(path, backup).themeName).toBe("light");
  });

  test("falls back to the backup when the primary file is corrupt", () => {
    const directory = mkdtempSync(join(tmpdir(), "workbench-state-"));
    const path = join(directory, "state.json");
    const backup = `${path}.bak`;
    const saved = { sessions: [{ cwd: "/workspace", id: "saved" }] };
    writePersistedStateFile(backup, `${backup}.older`, saved);
    writeFileSync(path, "{not json");

    expect(readPersistedStateFile(path, backup)).toEqual(saved);
  });
});
