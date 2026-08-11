import { describe, expect, test } from "bun:test";
import { parseKey } from "silvery";
import { selectionClipboardShortcut } from "./clipboard";

function parsed(input: string) {
  return parseKey(input);
}

describe("selectionClipboardShortcut", () => {
  test("copies only when Ctrl+C has a selection", () => {
    const [input, key] = parsed("\x03");

    expect(selectionClipboardShortcut(input, key, "harness", true)).toBe(
      "copy"
    );
    expect(
      selectionClipboardShortcut(input, key, "harness", false)
    ).toBeUndefined();
  });

  test("maps Ctrl+V to a host clipboard paste request", () => {
    const [input, key] = parsed("\x16");

    expect(selectionClipboardShortcut(input, key, "harness", false)).toBe(
      "paste"
    );
  });

  test("copies selected text from every selectable Workbench surface", () => {
    const [input, key] = parsed("\x03");

    for (const focus of ["harness", "terminal", "editor"] as const) {
      expect(selectionClipboardShortcut(input, key, focus, true)).toBe("copy");
    }
  });

  test("consumes viewer Ctrl+C even when there is no selection", () => {
    const [input, key] = parsed("\x03");

    expect(selectionClipboardShortcut(input, key, "editor", false)).toBe(
      "consume"
    );
    expect(
      selectionClipboardShortcut(input, key, "terminal", false)
    ).toBeUndefined();
  });

  test("accepts Cmd+C for selected text", () => {
    const key = { ...parsed("c")[1], super: true };

    expect(selectionClipboardShortcut("c", key, "editor", true)).toBe("copy");
  });
});
