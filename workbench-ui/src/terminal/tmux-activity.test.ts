import { describe, expect, test } from "bun:test";
import {
  harnessAppearsRunning,
  paneHasAgentBusyMarker,
  parseRecentTmuxActivity,
  parseTmuxScrollPosition,
  sessionAppearsRunning,
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

  test("does not mistake transcript prose quoting a Codex marker for work", () => {
    expect(
      paneHasAgentBusyMarker(
        "The detector matched an old visible Working (4s • esc to interrupt) line.\n" +
          "› Ask Codex to do anything"
      )
    ).toBe(false);
  });

  test("preserves a busy Codex harness at the session level", () => {
    const codexRunning = harnessAppearsRunning(
      "codex",
      "• Working (18s • esc to interrupt)",
      false
    );
    expect(sessionAppearsRunning([codexRunning], ["$ idle shell"])).toBe(true);
  });

  test("falls back to recent output for other harnesses", () => {
    expect(harnessAppearsRunning("claude", "", true)).toBe(true);
    expect(harnessAppearsRunning("claude", "", false)).toBe(false);
  });

  test("recognizes Claude Code working inside a regular terminal tab", () => {
    const claudePane =
      "· Improvising… (56s · thinking)\n" +
      "⏵⏵ bypass permissions on · esc to interrupt · ← 1 agent · ↓ to manage";
    expect(paneHasAgentBusyMarker(claudePane)).toBe(true);
    expect(sessionAppearsRunning([false], [claudePane])).toBe(true);
  });

  test("does not treat an idle Claude Code prompt as busy", () => {
    expect(
      paneHasAgentBusyMarker(
        "✻ Crunched for 1m 18s · done 5:30 AM\n❯ \n" +
          "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent"
      )
    ).toBe(false);
  });

  test("does not count ordinary terminal output as agent work", () => {
    expect(sessionAppearsRunning([false], ["$ bun test\n23 pass\n$ "])).toBe(
      false
    );
  });
});
