import { writeSync } from "node:fs";

export type HostCursorShape = "block" | "underline" | "bar";

const CURSOR_CODES: Record<
  HostCursorShape,
  { blinking: number; steady: number }
> = {
  block: { blinking: 1, steady: 2 },
  underline: { blinking: 3, steady: 4 },
  bar: { blinking: 5, steady: 6 },
};

export function hostCursorStyleSequence(
  shape: HostCursorShape,
  blink: boolean
): string {
  const code = blink
    ? CURSOR_CODES[shape].blinking
    : CURSOR_CODES[shape].steady;
  return `\x1b[${code} q`;
}

export function resetHostCursorStyleSequence(): string {
  return "\x1b[0 q";
}

export function writeHostCursorStyle(
  shape: HostCursorShape,
  blink: boolean
): void {
  writeRaw(hostCursorStyleSequence(shape, blink));
}

export function resetHostCursorStyle(): void {
  writeRaw(resetHostCursorStyleSequence());
}

function writeRaw(sequence: string): void {
  try {
    writeSync(1, sequence);
  } catch {
    // Best effort: cursor styling should never crash the workbench.
  }
}
