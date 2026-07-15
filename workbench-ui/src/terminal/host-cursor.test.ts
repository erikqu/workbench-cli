import { describe, expect, test } from "bun:test";
import {
  hostCursorAppearanceSequence,
  hostCursorColorSequence,
  hostCursorStyleSequence,
  resetHostCursorAppearanceSequence,
  resetHostCursorColorSequence,
  resetHostCursorStyleSequence,
} from "./host-cursor";

describe("host cursor style sequences", () => {
  test("emits DECSCUSR blinking and steady cursor shapes", () => {
    expect(hostCursorStyleSequence("block", true)).toBe("\x1b[1 q");
    expect(hostCursorStyleSequence("block", false)).toBe("\x1b[2 q");
    expect(hostCursorStyleSequence("underline", true)).toBe("\x1b[3 q");
    expect(hostCursorStyleSequence("underline", false)).toBe("\x1b[4 q");
    expect(hostCursorStyleSequence("bar", true)).toBe("\x1b[5 q");
    expect(hostCursorStyleSequence("bar", false)).toBe("\x1b[6 q");
  });

  test("emits the terminal default reset sequence", () => {
    expect(resetHostCursorStyleSequence()).toBe("\x1b[0 q");
  });

  test("sets and resets a contrasting cursor color", () => {
    expect(hostCursorColorSequence("#1f2328")).toBe("\x1b]12;#1f2328\x07");
    expect(resetHostCursorColorSequence()).toBe("\x1b]112\x07");
  });

  test("combines cursor shape and color into one write", () => {
    expect(hostCursorAppearanceSequence("bar", true, "#1f2328")).toBe(
      "\x1b[5 q\x1b]12;#1f2328\x07"
    );
    expect(resetHostCursorAppearanceSequence()).toBe("\x1b[0 q\x1b]112\x07");
  });
});
