import type { Key } from "silvery";
import { wrapForMultiplexer, writeRawStdout } from "../media/image-protocol";

export const CLIPBOARD_READ_QUERY = "\x1b]52;c;?\x07";

export type ClipboardFocus = "editor" | "harness" | "terminal";

export function selectionClipboardShortcut(
  input: string,
  key: Key,
  focus: ClipboardFocus,
  hasSelection: boolean
): "copy" | "paste" | "consume" | undefined {
  if (!(key.ctrl || key.super)) {
    return;
  }
  const character = input.toLowerCase();
  if (character === "c") {
    if (hasSelection) {
      return "copy";
    }
    // Ctrl+C remains SIGINT in an interactive terminal. In a viewer it is a
    // clipboard shortcut only and must never fall through to app shutdown.
    if (focus === "editor" || key.super) {
      return "consume";
    }
    return;
  }
  if (character === "v" && focus !== "editor") {
    return "paste";
  }
}

// OSC 52 clipboard reads are asynchronous: the host terminal answers this
// query on stdin, and Silvery turns that response into the same paste event as
// a native bracketed paste. Workbench's existing onPaste path then forwards it
// to the focused harness with the inner program's bracketed-paste mode intact.
export function requestClipboardPaste(): void {
  writeRawStdout(wrapForMultiplexer(CLIPBOARD_READ_QUERY));
}
