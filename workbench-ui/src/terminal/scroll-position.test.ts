import { describe, expect, test } from "bun:test";
import {
  parseTranscriptPercent,
  sameScrollThumb,
  scrollThumb,
} from "./scroll-position";

describe("parseTranscriptPercent", () => {
  test("reads the verified live footer forms", () => {
    expect(parseTranscriptPercent(["──────── 100% ─"])).toBe(100);
    expect(parseTranscriptPercent([" 94% "])).toBe(94);
    expect(parseTranscriptPercent(["98%"])).toBe(98);
    expect(parseTranscriptPercent(["─── 83% ─"])).toBe(83);
    expect(parseTranscriptPercent(["── 50% ──"])).toBe(50);
  });

  test("prefers the bottom-most percentage", () => {
    // Conversation text can quote its own percentage; the pager footer is
    // always the last one on screen.
    expect(
      parseTranscriptPercent([
        "coverage rose to 91% this week",
        "─────── 42% ─",
      ])
    ).toBe(42);
  });

  test("prefers the last percentage within a row", () => {
    expect(parseTranscriptPercent(["12% done ─── 77% ─"])).toBe(77);
  });

  test("ignores rows without a percentage", () => {
    expect(parseTranscriptPercent(["no numbers here", ""])).toBeUndefined();
    expect(parseTranscriptPercent([])).toBeUndefined();
  });

  test("rejects out-of-range values", () => {
    expect(parseTranscriptPercent(["999%"])).toBeUndefined();
  });
});

describe("scrollThumb", () => {
  const position = (offsetRows: number, scrollableRows: number) => ({
    approximate: false,
    offsetRows,
    scrollableRows,
    source: "tmux" as const,
  });

  test("returns nothing without a position", () => {
    expect(scrollThumb(20, undefined)).toBeUndefined();
  });

  test("returns nothing when the content fits", () => {
    expect(scrollThumb(20, position(0, 0))).toBeUndefined();
  });

  test("returns nothing at the live edge", () => {
    expect(scrollThumb(20, position(80, 80))).toBeUndefined();
  });

  test("draws a nearly full thumb when there is barely any history", () => {
    // One row of scrollback in a 20-row track: 20²/21 = 19 rows, which
    // correctly reads as "almost nothing to scroll". The fills-the-track guard
    // is unreachable for integer inputs and exists only for parity with
    // silvery's own bar.
    const thumb = scrollThumb(20, position(0, 1));
    expect(thumb?.height).toBe(19);
    expect(thumb?.top).toBe(0);
  });

  test("pins the thumb to the top of the track at the oldest row", () => {
    const thumb = scrollThumb(20, position(0, 80));
    expect(thumb?.top).toBe(0);
    expect(thumb?.height).toBe(4);
    expect(thumb?.trackHeight).toBe(20);
  });

  test("moves the thumb down as the offset approaches the live edge", () => {
    const middle = scrollThumb(20, position(40, 80));
    const late = scrollThumb(20, position(79, 80));
    expect(middle?.top).toBe(8);
    expect(late?.top).toBe(16);
    // Never overflows the track.
    expect((late?.top ?? 0) + (late?.height ?? 0)).toBeLessThanOrEqual(20);
  });

  test("keeps at least one row of thumb on a huge history", () => {
    const thumb = scrollThumb(10, position(5000, 20_000));
    expect(thumb?.height).toBe(1);
    expect(thumb?.top).toBeGreaterThanOrEqual(0);
    expect(thumb?.top).toBeLessThanOrEqual(9);
  });

  test("clamps a negative or overlarge offset", () => {
    expect(scrollThumb(20, position(-5, 80))?.top).toBe(0);
    expect(scrollThumb(20, position(1000, 80))).toBeUndefined();
  });

  test("carries the approximate flag through", () => {
    const thumb = scrollThumb(20, {
      approximate: true,
      offsetRows: 50,
      scrollableRows: 100,
      source: "transcript",
    });
    expect(thumb?.approximate).toBe(true);
  });

  test("ignores a non-positive track", () => {
    expect(scrollThumb(0, position(10, 80))).toBeUndefined();
  });
});

describe("sameScrollThumb", () => {
  const thumb = {
    approximate: false,
    height: 4,
    top: 8,
    trackHeight: 20,
  };

  test("treats two absent thumbs as unchanged", () => {
    expect(sameScrollThumb(undefined, undefined)).toBe(true);
  });

  test("detects appearing and disappearing thumbs", () => {
    expect(sameScrollThumb(undefined, thumb)).toBe(false);
    expect(sameScrollThumb(thumb, undefined)).toBe(false);
  });

  test("compares the quantized geometry only", () => {
    expect(sameScrollThumb(thumb, { ...thumb })).toBe(true);
    expect(sameScrollThumb(thumb, { ...thumb, top: 9 })).toBe(false);
    expect(sameScrollThumb(thumb, { ...thumb, height: 5 })).toBe(false);
    expect(sameScrollThumb(thumb, { ...thumb, trackHeight: 21 })).toBe(false);
  });
});
