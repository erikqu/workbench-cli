import { describe, expect, test } from "bun:test";
import {
  harnessAppearsRunning,
  parseRecentTmuxActivity,
} from "./tmux-activity";

describe("parseRecentTmuxActivity", () => {
  test("returns live tmux sessions with recent pane output", () => {
    const now = 1_800_000_000_000;
    const output = [
      "workbench_h_busy|1799999998|0",
      "workbench_h_idle|1799999980|0",
      "workbench_h_dead|1799999999|1",
    ].join("\n");

    expect([...parseRecentTmuxActivity(output, now)]).toEqual([
      "workbench_h_busy",
    ]);
  });

  test("ignores malformed tmux output", () => {
    expect([
      ...parseRecentTmuxActivity("garbage\nname|nope|0", 100_000),
    ]).toEqual([]);
  });
});

describe("harnessAppearsRunning", () => {
  test("keeps a quiet Codex pane running while its status marker is visible", () => {
    expect(
      harnessAppearsRunning(
        "codex",
        "• Working (18s • esc to interrupt)",
        false
      )
    ).toBe(true);
  });

  test("does not mistake an idle Codex redraw for active work", () => {
    expect(harnessAppearsRunning("codex", "> Ask Codex anything", true)).toBe(
      false
    );
  });

  test("falls back to recent output for other harnesses", () => {
    expect(harnessAppearsRunning("claude", "", true)).toBe(true);
    expect(harnessAppearsRunning("claude", "", false)).toBe(false);
  });
});
