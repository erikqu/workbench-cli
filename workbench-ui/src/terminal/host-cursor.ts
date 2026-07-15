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

export function hostCursorColorSequence(color: string): string {
  return `\x1b]12;${color}\x07`;
}

export function resetHostCursorColorSequence(): string {
  return "\x1b]112\x07";
}

export function hostCursorAppearanceSequence(
  shape: HostCursorShape,
  blink: boolean,
  color: string
): string {
  return hostCursorStyleSequence(shape, blink) + hostCursorColorSequence(color);
}

export function resetHostCursorAppearanceSequence(): string {
  return resetHostCursorStyleSequence() + resetHostCursorColorSequence();
}
