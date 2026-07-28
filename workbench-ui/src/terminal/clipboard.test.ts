import { describe, expect, test } from "bun:test";
import { parseKey } from "silvery";
import { terminalClipboardShortcut } from "./clipboard";

function parsed(input: string) {
  return parseKey(input);
}

describe("terminalClipboardShortcut", () => {
  test("copies only when Ctrl+C has a selection", () => {
    const [input, key] = parsed("\x03");

    expect(terminalClipboardShortcut(input, key, true)).toBe("copy");
    expect(terminalClipboardShortcut(input, key, false)).toBeUndefined();
  });

  test("maps Ctrl+V to a host clipboard paste request", () => {
    const [input, key] = parsed("\x16");

    expect(terminalClipboardShortcut(input, key, false)).toBe("paste");
  });
});
