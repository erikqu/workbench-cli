import { describe, expect, test } from "bun:test";
import { TerminalPanel } from "./terminal-panel";

// Reach the panel's internal xterm so tests can feed it raw bytes directly
// (the public `write` path only forwards to a child PTY).
function rawTerminal(panel: TerminalPanel) {
  return (
    panel as unknown as {
      terminal: { write(data: string, cb: () => void): void };
    }
  ).terminal;
}

function feed(panel: TerminalPanel, data: string): Promise<void> {
  return new Promise((resolve) => rawTerminal(panel).write(data, resolve));
}

describe("TerminalPanel.getCursor", () => {
  test("reports a visible caret at the cursor position", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    await feed(panel, "line1\r\nline2\r\nABC");
    expect(panel.getCursor()).toEqual({ x: 3, y: 2, visible: true });
  });

  test("honors DECTCEM hide/show (CSI ?25 l/h)", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    await feed(panel, "hello");
    await feed(panel, "\x1b[?25l");
    expect(panel.getCursor().visible).toBe(false);
    await feed(panel, "\x1b[?25h");
    expect(panel.getCursor().visible).toBe(true);
  });

  test("does not draw a stale caret parked bottom-left while hidden", async () => {
    // A full-screen CLI (or tmux) hides the cursor and parks it bottom-left
    // while redrawing. Without the visibility check we drew a caret there.
    const panel = new TerminalPanel("/tmp", 80, 24);
    await feed(panel, "\x1b[?25l\x1b[24;1H");
    expect(panel.getCursor()).toEqual({ x: 0, y: 23, visible: false });
  });
});
