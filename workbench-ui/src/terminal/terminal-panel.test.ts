import { describe, expect, test } from "bun:test";
import {
  TerminalPanel,
  transcriptBurstCap,
  transcriptBurstRows,
} from "./terminal-panel";

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

    await Bun.sleep(1100);

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

    // Time has elapsed since the redraw began, but not one recovery period
    // since its latest chunk. Publishing here would expose duplicate rows.
    expect(panel.getSnapshot()).toBe(initialRevision);

    await feed(panel, "\x1b[?2026l");
    expect(panel.getSnapshot()).toBeGreaterThan(initialRevision);
  });

  test("does not recover a quiet synchronized frame before one second", async () => {
    const panel = new TerminalPanel("/tmp", 80, 8);
    const initialRevision = panel.getSnapshot();

    await feed(panel, "\x1b[?2026h\x1b[2J\x1b[Hpaused redraw");
    await Bun.sleep(350);

    expect(panel.getSnapshot()).toBe(initialRevision);
    expect(rawTerminal(panel).modes.synchronizedOutputMode).toBe(true);

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

describe("TerminalPanel.sendMouseWheel", () => {
  function capturePty(panel: TerminalPanel) {
    const writes: string[] = [];
    (panel as unknown as { child: unknown }).child = {};
    (panel as unknown as { pty: { write(data: string): void } }).pty = {
      write(data) {
        writes.push(data);
      },
    };
    return writes;
  }

  test("returns false when the inner program is not tracking the mouse", () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    const writes = capturePty(panel);
    expect(panel.sendMouseWheel(5, 5, "up")).toBe(false);
    expect(writes).toEqual([]);
  });

  test("forwards one SGR report per step in a single write", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    const writes = capturePty(panel);
    await feed(panel, "\x1b[?1000h\x1b[?1006h");

    // Silvery coalesces a wheel burst into one event carrying the step count.
    // Every step must reach the child, or tmux copy-mode scrolls up further
    // than later wheel-down streams can recover and the pane strands in
    // scrollback.
    expect(panel.sendMouseWheel(4, 9, "up", 3)).toBe(true);
    expect(writes).toEqual(["\x1b[<64;5;10M".repeat(3)]);

    writes.length = 0;
    expect(panel.sendMouseWheel(4, 9, "down", 5)).toBe(true);
    expect(writes).toEqual(["\x1b[<65;5;10M".repeat(5)]);
  });

  test("defaults to a single step and clamps bad counts", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    const writes = capturePty(panel);
    await feed(panel, "\x1b[?1000h\x1b[?1006h");

    expect(panel.sendMouseWheel(0, 0, "up")).toBe(true);
    expect(panel.sendMouseWheel(0, 0, "up", 0)).toBe(true);
    expect(writes).toEqual(["\x1b[<64;1;1M", "\x1b[<64;1;1M"]);
  });

  test("uses the transcript fallback when an application is not tracking the mouse", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    // Opening writes Ctrl+T ALONE: the pager discards keys that arrive during
    // its startup window, so the scroll rows flush once the header paints.
    expect(panel.sendMouseWheel(4, 9, "up", 2)).toBe(true);
    expect(writes).toEqual(["\x14"]);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    expect(writes).toEqual(["\x14", "\x1b[A".repeat(6)]);

    expect(panel.sendMouseWheel(4, 9, "down", 1)).toBe(true);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(3));
    expect(panel.sendMouseWheel(4, 9, "down", 1)).toBe(true);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(3));
    // Balancing synthetic wheel debt must not discard the final movement or
    // close early. Codex's footer is the source of truth for the live edge.
    await Bun.sleep(450);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(3));
    await feed(panel, "\x1b[2J\x1b[HT R A N S C R I P T\r\n 100% ");
    await Bun.sleep(450);
    expect(writes.at(-1)).toBe("\x14");

    await feed(panel, "\x1b[?1049l");
    expect(panel.sendMouseWheel(4, 9, "up", 1)).toBe(true);
    expect(writes.at(-1)).toBe("\x14");
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    expect(writes.at(-1)).toBe("\x1b[A".repeat(3));
    expect(panel.sendViewportKey("x")).toBe(true);
    expect(writes.at(-1)).toBe("\x14");
    await feed(panel, "\x1b[?1049l");
    expect(writes.at(-1)).toBe("x");
  });

  test("bounds a large transcript wheel burst to one screenful", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    // 26 steps would ask for 78 rows; a 24-row pane caps the burst at a
    // screenful (22). The pager repaints once per burst either way, so the cap
    // exists to keep the jump comprehensible, not to save the agent work.
    expect(panel.sendMouseWheel(4, 9, "up", 26)).toBe(true);
    expect(writes).toEqual(["\x14"]);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    expect(writes).toEqual(["\x14", "\x1b[A".repeat(22)]);
  });

  test("folds wheel gestures into the queue while the pager starts", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    expect(panel.sendMouseWheel(4, 9, "up", 1)).toBe(true);
    expect(panel.sendMouseWheel(4, 9, "up", 2)).toBe(true);
    expect(panel.sendMouseWheel(4, 9, "down", 1)).toBe(true);
    expect(writes).toEqual(["\x14"]);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    // 3 + 6 - 3 queued rows flush in one write once the header paints.
    expect(writes).toEqual(["\x14", "\x1b[A".repeat(6)]);
  });

  test("a wheel-up during the pager close reopens instead of vanishing", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    expect(panel.sendMouseWheel(4, 9, "up", 1)).toBe(true);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 99% ");
    expect(panel.sendMouseWheel(4, 9, "down", 1)).toBe(true);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(3));
    await feed(panel, "\x1b[2J\x1b[HT R A N S C R I P T\r\n 100% ");
    await Bun.sleep(450);
    expect(writes.at(-1)).toBe("\x14");

    // Reversal while the pager is closing: queued, then reopened.
    expect(panel.sendMouseWheel(4, 9, "up", 2)).toBe(true);
    await feed(panel, "\x1b[?1049l");
    expect(writes.at(-1)).toBe("\x14");
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    expect(writes.at(-1)).toBe("\x1b[A".repeat(6));
  });

  test("holds the presented frame across pager transitions", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    capturePty(panel);
    await feed(panel, "composer");
    const beforeOpen = panel.getSnapshot();

    expect(panel.sendMouseWheel(4, 9, "up", 1)).toBe(true);
    // The cleared alternate screen must not be presented: no new revision
    // until the pager header has painted.
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[H");
    expect(panel.getSnapshot()).toBe(beforeOpen);
    await feed(panel, "T R A N S C R I P T\r\n 50% ");
    expect(panel.getSnapshot()).toBeGreaterThan(beforeOpen);
  });

  test("a wedged pager close cannot swallow input forever", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    expect(panel.sendMouseWheel(4, 9, "up", 1)).toBe(true);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    expect(panel.sendViewportKey("x")).toBe(true);
    expect(writes.at(-1)).toBe("\x14");
    // The pager never leaves the screen (marker keeps matching). The bounded
    // transition hold must still flush the queued keystroke.
    await feed(panel, "T R A N S C R I P T\r\n 50% ");
    await Bun.sleep(600);
    expect(writes.at(-1)).toBe("x");
  });

  test("honors native wheel tracking before the transcript fallback", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);
    await feed(panel, "\x1b[?1049h\x1b[?1000h\x1b[?1006h");

    expect(panel.sendMouseWheel(4, 9, "up", 2)).toBe(true);
    expect(panel.sendMouseWheel(4, 9, "down", 1)).toBe(true);
    expect(writes).toEqual(["\x1b[<64;5;10M".repeat(2), "\x1b[<65;5;10M"]);
  });

  test("returns to the composer when the transcript reaches the live edge", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    expect(panel.sendMouseWheel(4, 9, "up", 4)).toBe(true);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 83% ");
    expect(panel.sendMouseWheel(4, 9, "down", 4)).toBe(true);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(12));
    await feed(panel, "\x1b[2J\x1b[HT R A N S C R I P T\r\n 100% ");
    await Bun.sleep(450);

    expect(writes).toEqual([
      "\x14",
      "\x1b[A".repeat(12),
      "\x1b[B".repeat(12),
      "\x14",
    ]);
  });

  test("does not mistake message content containing 100% for the live edge", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    const writes = capturePty(panel);

    expect(panel.sendMouseWheel(4, 9, "up", 2)).toBe(true);
    await feed(
      panel,
      "\x1b[?1049h\x1b[2J\x1b[H100% test coverage\r\nT R A N S C R I P T\r\n 50% "
    );
    expect(panel.sendMouseWheel(4, 9, "down", 2)).toBe(true);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(6));
    await Bun.sleep(450);
    expect(writes.at(-1)).toBe("\x1b[B".repeat(6));
  });
});

describe("transcriptBurstRows", () => {
  test("moves three rows per wheel tick for fine control", () => {
    expect(transcriptBurstRows(1, 40)).toBe(3);
    expect(transcriptBurstRows(2, 40)).toBe(6);
  });

  test("lets a fast flick travel a screenful instead of a fixed 12 rows", () => {
    // A 40-row pane allows 38; the old fixed cap throttled every flick to 12.
    expect(transcriptBurstRows(20, 40)).toBe(38);
    expect(transcriptBurstRows(100, 70)).toBe(68);
  });

  test("keeps a usable floor on short panes", () => {
    expect(transcriptBurstRows(20, 8)).toBe(12);
    expect(transcriptBurstCap(8)).toBe(12);
  });

  test("clamps nonsense step counts to at least one tick", () => {
    expect(transcriptBurstRows(0, 40)).toBe(3);
    expect(transcriptBurstRows(-5, 40)).toBe(3);
  });
});

describe("TerminalPanel.scrollIndicator", () => {
  function capturePty(panel: TerminalPanel) {
    const writes: string[] = [];
    (panel as unknown as { child: unknown }).child = {};
    (panel as unknown as { pty: { write(data: string): void } }).pty = {
      write(data) {
        writes.push(data);
      },
    };
    return writes;
  }

  test("has nothing to show on a pane sitting at the live edge", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh");
    expect(panel.scrollIndicator()).toBeUndefined();
  });

  test("tracks the local mirror once the pane is scrolled", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj");

    panel.scrollLines(-3);
    const thumb = panel.scrollIndicator();
    expect(thumb).toBeDefined();
    expect(thumb?.approximate).toBe(false);
    // A fresh gesture highlights the thumb.
    expect(thumb?.active).toBe(true);
    expect(thumb?.trackHeight).toBe(6);

    panel.scrollToBottom();
    expect(panel.scrollIndicator()).toBeUndefined();
  });

  test("derives an approximate thumb from the Codex pager footer", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24, {
      wheelNavigation: "transcript",
    });
    capturePty(panel);

    expect(panel.sendMouseWheel(4, 9, "up", 2)).toBe(true);
    await feed(panel, "\x1b[?1049h\x1b[2J\x1b[HT R A N S C R I P T\r\n 50% ");
    const thumb = panel.scrollIndicator();
    expect(thumb?.approximate).toBe(true);
    expect(thumb?.trackHeight).toBe(24);

    // The footer reporting the live edge retires the indicator.
    await feed(panel, "\x1b[2J\x1b[HT R A N S C R I P T\r\n 100% ");
    expect(panel.scrollIndicator()).toBeUndefined();
  });

  test("clears scroll state on detach", async () => {
    const panel = new TerminalPanel("/tmp", 80, 6);
    await feed(panel, "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj");
    panel.scrollLines(-3);
    expect(panel.scrollIndicator()).toBeDefined();

    panel.detach();
    // followOutput is restored, so nothing lingers for the next attach.
    expect(panel.scrollIndicator()).toBeUndefined();
  });
});

describe("TerminalPanel resize generations", () => {
  test("coalesces a resize burst and sends only the newest size to the PTY", async () => {
    const panel = new TerminalPanel("/tmp", 80, 24);
    const calls: [number, number][] = [];
    (
      panel as unknown as { pty: { resize(cols: number, rows: number): void } }
    ).pty = {
      resize(cols, rows) {
        calls.push([cols, rows]);
      },
    };

    panel.resize(90, 25);
    panel.resize(100, 30);
    panel.resize(120, 40);

    expect(calls).toEqual([]);
    await Bun.sleep(0);
    expect(calls).toEqual([[120, 40]]);
    expect([panel.cols, panel.rows]).toEqual([120, 40]);
  });
});
