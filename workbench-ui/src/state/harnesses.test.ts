import { describe, expect, test } from "bun:test";
import {
  codexCommand,
  codexNeedsHistoryReplayWorkaround,
  harnessSpec,
  selectDefaultHarnessId,
} from "./harnesses";

describe("default harness selection", () => {
  test("prefers Codex when multiple harnesses are installed", () => {
    const installed = new Set(["codex", "cursor-agent", "claude"]);

    expect(selectDefaultHarnessId((bin) => installed.has(bin))).toBe("codex");
  });

  test("uses the next installed preference when Codex is unavailable", () => {
    expect(selectDefaultHarnessId((bin) => bin === "cursor-agent")).toBe(
      "cursor"
    );
  });

  test("falls back to Codex when no harness can be detected", () => {
    expect(selectDefaultHarnessId(() => false)).toBe("codex");
    expect(harnessSpec("unknown").id).toBe("codex");
  });
});

describe("Codex resumed history compatibility", () => {
  test("identifies releases with capped replay corruption", () => {
    expect(codexNeedsHistoryReplayWorkaround("codex-cli 0.144.1")).toBe(true);
    expect(codexNeedsHistoryReplayWorkaround("codex-cli 0.144.4")).toBe(true);
    expect(
      codexNeedsHistoryReplayWorkaround("codex-cli 0.145.0-alpha.11")
    ).toBe(true);
  });

  test("leaves repaired and unknown releases unchanged", () => {
    expect(
      codexNeedsHistoryReplayWorkaround("codex-cli 0.145.0-alpha.12")
    ).toBe(false);
    expect(codexNeedsHistoryReplayWorkaround("codex-cli 0.145.0")).toBe(false);
    expect(codexNeedsHistoryReplayWorkaround("not a version")).toBe(false);
  });

  test("disables the row cap only for affected resumed chats", () => {
    const affected = codexCommand("codex-cli 0.144.4").command;
    expect(affected).toContain(
      "codex resume --last -c tui.terminal_resize_reflow_max_rows=0"
    );
    expect(affected).toContain(
      "|| codex -c tui.animations=false --dangerously-bypass-approvals-and-sandbox"
    );

    const repaired = codexCommand("codex-cli 0.145.0-alpha.12").command;
    expect(repaired).not.toContain("terminal_resize_reflow_max_rows");
  });

  test("disables animated status redraws for embedded Codex panes", () => {
    const command = codexCommand("codex-cli 0.144.6").command;

    expect(command.match(/-c tui\.animations=false/g)).toHaveLength(2);
  });
});
