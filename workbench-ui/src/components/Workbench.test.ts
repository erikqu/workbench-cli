import { describe, expect, test } from "bun:test";
import { parseKey } from "silvery";
import { isThemeCycleKey } from "./Workbench";

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
