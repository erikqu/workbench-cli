import type { Key } from "silvery";
import { wrapForMultiplexer, writeRawStdout } from "../media/image-protocol";

export const CLIPBOARD_READ_QUERY = "\x1b]52;c;?\x07";

export function terminalClipboardShortcut(
  input: string,
  key: Key,
  hasSelection: boolean
): "copy" | "paste" | undefined {
  if (!key.ctrl) {
    return;
  }
  if (input.toLowerCase() === "c" && hasSelection) {
    return "copy";
  }
  if (input.toLowerCase() === "v") {
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
