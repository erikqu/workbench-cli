import { describe, expect, test } from "bun:test";
import {
  harnessAppearsRunning,
  parseRecentTmuxActivity,
  parseTmuxScrollPosition,
} from "./tmux-activity";

describe("parseTmuxScrollPosition", () => {
  test("reads a scrolled copy-mode pane", () => {
    expect(parseTmuxScrollPosition("1|2|482|40\n")).toEqual({
      historySize: 482,
      paneHeight: 40,
      scrollPosition: 2,
    });
  });

  test("ignores a pane that is not in a mode", () => {
    // tmux leaves scroll_position empty outside copy-mode.
    expect(parseTmuxScrollPosition("0||482|40")).toBeUndefined();
  });

  test("ignores a mode with no scroll offset yet", () => {
    expect(parseTmuxScrollPosition("1||482|40")).toBeUndefined();
  });

  test("ignores malformed or missing output", () => {
    expect(parseTmuxScrollPosition("")).toBeUndefined();
    expect(parseTmuxScrollPosition("no such pane")).toBeUndefined();
    expect(parseTmuxScrollPosition("1|abc|482|40")).toBeUndefined();
    expect(parseTmuxScrollPosition("1|2|abc|40")).toBeUndefined();
  });

  test("accepts a pane sitting at the bottom of its history", () => {
    expect(parseTmuxScrollPosition("1|0|900|30")?.scrollPosition).toBe(0);
  });
});

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
