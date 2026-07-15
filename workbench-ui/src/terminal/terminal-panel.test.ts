import { describe, expect, test } from "bun:test";
import { TerminalPanel } from "./terminal-panel";

// Reach the panel's internal xterm so tests can feed it raw bytes directly
// (the public `write` path only forwards to a child PTY).
function rawTerminal(panel: TerminalPanel) {
  return (
    panel as unknown as {
      terminal: {
        modes: { synchronizedOutputMode: boolean };
        write(data: string, cb?: () => void): void;
      };
    }
  ).terminal;
}

function feed(panel: TerminalPanel, data: string): Promise<void> {
  return new Promise((resolve) => rawTerminal(panel).write(data, resolve));
}

describe("TerminalPanel synchronized output", () => {
  test("publishes only the completed TUI frame", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    const initialRevision = panel.getSnapshot();

    await feed(panel, "\x1b[?2026hfirst");
    expect(panel.getSnapshot()).toBe(initialRevision);

    await feed(panel, " second");
    expect(panel.getSnapshot()).toBe(initialRevision);

    await feed(panel, "\x1b[?2026l");
    expect(panel.getSnapshot()).toBeGreaterThan(initialRevision);
  });

  test("publishes a complete-enough frame when the closing marker is lost", async () => {
    const panel = new TerminalPanel("/tmp", 80, 8);
    const initialRevision = panel.getSnapshot();

    await feed(panel, "\x1b[?2026hWorking\r\n\r\n> prompt");
    expect(panel.getSnapshot()).toBe(initialRevision);

    await Bun.sleep(300);

    expect(panel.getSnapshot()).toBeGreaterThan(initialRevision);
    expect(rawTerminal(panel).modes.synchronizedOutputMode).toBe(false);
    const text = panel
      .getLines()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(text).toContain("> prompt");

    const recoveredRevision = panel.getSnapshot();
    await feed(panel, " ready");
    expect(panel.getSnapshot()).toBeGreaterThan(recoveredRevision);
  });

  test("does not publish a synchronized redraw while chunks are still arriving", async () => {
    const panel = new TerminalPanel("/tmp", 80, 8);
    await feed(panel, "old composer");
    const initialRevision = panel.getSnapshot();

    await feed(panel, "\x1b[?2026h\rpartial redraw");
    await Bun.sleep(160);
    await feed(panel, "\r\nmore redraw");
    await Bun.sleep(140);

    // More than 250 ms has elapsed since the redraw began, but not since its
    // latest chunk. Publishing here would expose duplicated composer rows.
    expect(panel.getSnapshot()).toBe(initialRevision);

    await feed(panel, "\x1b[?2026l");
    expect(panel.getSnapshot()).toBeGreaterThan(initialRevision);
  });
});

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

describe("TerminalPanel input re-anchors the viewport", () => {
  // The scrollback buffer behind the public write/paste path.
  function activeBuffer(panel: TerminalPanel) {
    return (
      panel as unknown as {
        terminal: {
          buffer: {
            active: { baseY: number; viewportY: number };
          };
        };
      }
    ).terminal.buffer.active;
  }

  // Mark the panel as already started so the public write/paste path doesn't
  // spawn a real PTY in the test; writeToChild is a no-op without a pty.
  function markStarted(panel: TerminalPanel) {
    (panel as unknown as { child: unknown }).child = {};
  }

  test("typing snaps a scrolled-up viewport back to the prompt", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    // Fill scrollback so baseY advances past the visible page.
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj");
    const buffer = activeBuffer(panel);
    expect(buffer.baseY).toBeGreaterThan(0);

    // Scroll up: the prompt is now below the visible viewport.
    panel.scrollLines(-3);
    expect(buffer.viewportY).toBeLessThan(buffer.baseY);

    markStarted(panel);
    panel.write("x");
    // User input must re-anchor to the bottom so the prompt stops drifting.
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  test("pasting snaps a scrolled-up viewport back to the prompt", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
    const buffer = activeBuffer(panel);
    expect(buffer.baseY).toBeGreaterThan(0);

    panel.scrollLines(-2);
    expect(buffer.viewportY).toBeLessThan(buffer.baseY);

    markStarted(panel);
    panel.paste("hi");
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  test("is a no-op when already at the bottom", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
    const buffer = activeBuffer(panel);
    expect(buffer.viewportY).toBe(buffer.baseY);

    markStarted(panel);
    panel.write("x");
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  test("repairs viewport drift while output following is active", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
    const buffer = activeBuffer(panel);

    // Bypass the panel's explicit-scroll path to model an xterm viewport that
    // drifted during a resize or redraw while it was still following output.
    (
      rawTerminal(panel) as unknown as { scrollLines(lines: number): void }
    ).scrollLines(-2);
    expect(buffer.viewportY).toBeLessThan(buffer.baseY);

    await feed(panel, "\r\ni");
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  test("preserves intentional scrollback while new output arrives", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
    const buffer = activeBuffer(panel);

    panel.scrollLines(-2);
    expect(buffer.viewportY).toBeLessThan(buffer.baseY);

    await feed(panel, "\r\ni");
    expect(buffer.viewportY).toBeLessThan(buffer.baseY);
  });
});
