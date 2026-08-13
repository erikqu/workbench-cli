import { describe, expect, test } from "bun:test";
import { parseKey } from "silvery";
import {
  isHelpShortcut,
  isThemeCycleKey,
  terminalGridSize,
  wheelGesture,
} from "./Workbench";

function parsed(input: string) {
  return parseKey(input);
}

describe("isThemeCycleKey", () => {
  test("matches kitty and modifyOtherKeys Alt+Tab encodings", () => {
    for (const raw of ["\x1b[9;3u", "\x1b[27;3;9~"]) {
      const [input, key] = parsed(raw);
      expect(isThemeCycleKey(input, key)).toBe(true);
    }
  });

  test("matches legacy ESC+Tab encoding", () => {
    const [input, key] = parsed("\x1b\t");
    expect(input).toBe("\t");
    expect(key.tab).toBe(false);
    expect(isThemeCycleKey(input, key)).toBe(true);
  });

  test("does not match plain Tab", () => {
    const [input, key] = parsed("\t");
    expect(isThemeCycleKey(input, key)).toBe(false);
  });
});

describe("isHelpShortcut", () => {
  test("matches enhanced Ctrl+? encodings", () => {
    for (const raw of ["\x1b[63;6u", "\x1b[47;6u"]) {
      const [input, key] = parsed(raw);
      expect(isHelpShortcut(input, key)).toBe(true);
    }
  });

  test("never mistakes legacy DEL for Help", () => {
    const [input, key] = parsed("\x7f");
    expect(key.backspace).toBe(true);
    expect(isHelpShortcut(input, key)).toBe(false);
  });
});

describe("wheelGesture", () => {
  test("maps a single wheel report to one step", () => {
    expect(wheelGesture(-1)).toEqual({ direction: "up", steps: 1 });
    expect(wheelGesture(1)).toEqual({ direction: "down", steps: 1 });
  });

  test("preserves the coalesced magnitude of a wheel burst", () => {
    // Silvery merges same-direction wheel bursts into one event whose deltaY
    // sums the reports. Collapsing it to one step strands tmux copy-mode
    // panes in scrollback because up and down streams shrink unevenly.
    expect(wheelGesture(-12)).toEqual({ direction: "up", steps: 12 });
    expect(wheelGesture(40)).toEqual({ direction: "down", steps: 40 });
  });

  test("ignores empty or malformed deltas", () => {
    expect(wheelGesture(0)).toBeUndefined();
    expect(wheelGesture(Number.NaN)).toBeUndefined();
    expect(wheelGesture(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("never rounds a fractional delta down to zero steps", () => {
    expect(wheelGesture(-0.2)).toEqual({ direction: "up", steps: 1 });
  });
});

describe("terminalGridSize", () => {
  // Every pane reserves unused rows at the bottom so an agent's bottom-anchored
  // composer can never be pushed under the frame by a stale measurement or an
  // off-by-a-row reflow. 48 measured rows -> 43 for the PTY.
  test("uses the measured pane size minus the bottom safety margin", () => {
    expect(
      terminalGridSize(
        { x: 57, y: 5, width: 130, height: 48 },
        { columns: 188, rows: 54 }
      )
    ).toEqual({ cols: 130, rows: 43 });
  });

  test("clamps runaway layout measurements to visible cells", () => {
    expect(
      terminalGridSize(
        { x: 57, y: 5, width: 500, height: 3102 },
        { columns: 188, rows: 54 }
      )
    ).toEqual({ cols: 130, rows: 43 });
  });

  test("keeps the grid usable on panes shorter than the margin", () => {
    expect(
      terminalGridSize(
        { x: 0, y: 0, width: 40, height: 2 },
        { columns: 80, rows: 24 }
      ).rows
    ).toBe(1);
  });

  test("never returns more rows than the window can show", () => {
    const { rows } = terminalGridSize(
      { x: 0, y: 20, width: 80, height: 400 },
      { columns: 80, rows: 24 }
    );
    expect(rows).toBeLessThanOrEqual(24 - 20 - 1);
  });
});
