import { writeSync } from "node:fs";

// Terminal image rendering strategy, in descending fidelity.
export type ImageProtocol = "kitty" | "sixel" | "halfblock";

// Result of the startup active probe (terminal-probe.ts), if it ran. This is the
// most reliable signal — it reflects what the terminal actually answered, not a
// guess from env vars — so detection consults it first.
let probedGraphics: { kitty: boolean; sixel: boolean } | undefined;

export function setGraphicsSupport(support: {
  kitty: boolean;
  sixel: boolean;
}): void {
  probedGraphics = support;
}

export function probedGraphicsSupport():
  | { kitty: boolean; sixel: boolean }
  | undefined {
  return probedGraphics;
}

// Whether the terminal can render real pixel graphics (kitty or sixel). This is
// the single source of truth used to decide between Silvery's native <Image>
// renderer and our half-block ASCII fallback. We defer to Silvery's own
// detectors so our decision always matches what <Image protocol="auto"> will
// actually do — env-var guessing and icat probes drift from Silvery and were
// the reason images silently fell back to ASCII art.
export function graphicsAvailable(): boolean {
  const override = (Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL ?? "").toLowerCase();
  if (override === "halfblock") {
    return false;
  }
  if (override === "kitty" || override === "sixel") {
    return true;
  }
  if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
    return false;
  }
  // Kitty is the default: assume real graphics are available unless the user
  // explicitly opts out (handled above) or we're in the screenshot harness.
  // Terminals that truly can't render graphics will show garbage; those users
  // set WORKBENCH_UI_IMAGE_PROTOCOL=halfblock. (probedGraphics / env detectors are
  // intentionally not consulted here — they only refine *which* protocol below.)
  return true;
}

// Prefer the Kitty Unicode-placeholder path over the half-block fallback when in
// a multiplexer, unless the user explicitly forced sixel (which has no
// placeholder mechanism and so can't be passed through tmux this way).
export function kittyPlaceholderDesired(): boolean {
  return (
    inMultiplexer() &&
    (Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL ?? "").toLowerCase() !== "sixel"
  );
}

// Placeholder character for kitty Unicode-placeholder images (U+10EEEE).
const PLACEHOLDER = "\u{10EEEE}";

// kitty graphics escape framing.
const APC = "\x1b_G";
const ST = "\x1b\\";

// Row/column diacritics (kitty rowcolumn-diacritics.txt order). Index N maps to
// the Nth combining char; we only need one per image row (columns auto-increment
// via the left-inheritance rule), so this prefix is plenty for any terminal.
const ROWCOLUMN_DIACRITICS = [
  0x03_05, 0x03_0d, 0x03_0e, 0x03_10, 0x03_12, 0x03_3d, 0x03_3e, 0x03_3f,
  0x03_46, 0x03_4a, 0x03_4b, 0x03_4c, 0x03_50, 0x03_51, 0x03_52, 0x03_57,
  0x03_5b, 0x03_63, 0x03_64, 0x03_65, 0x03_66, 0x03_67, 0x03_68, 0x03_69,
  0x03_6a, 0x03_6b, 0x03_6c, 0x03_6d, 0x03_6e, 0x03_6f, 0x04_83, 0x04_84,
  0x04_85, 0x04_86, 0x04_87, 0x05_92, 0x05_93, 0x05_94, 0x05_95, 0x05_97,
  0x05_98, 0x05_99, 0x05_9c, 0x05_9d, 0x05_9e, 0x05_9f, 0x05_a0, 0x05_a1,
  0x05_a8, 0x05_a9, 0x05_ab, 0x05_ac, 0x05_af, 0x05_c4, 0x06_10, 0x06_11,
  0x06_12, 0x06_13, 0x06_14, 0x06_15, 0x06_16, 0x06_17, 0x06_57, 0x06_58,
  0x06_59, 0x06_5a, 0x06_5b, 0x06_5d, 0x06_5e, 0x06_d6, 0x06_d7, 0x06_d8,
  0x06_d9, 0x06_da, 0x06_db, 0x06_dc, 0x06_df, 0x06_e0, 0x06_e1, 0x06_e2,
  0x06_e4, 0x06_e7, 0x06_e8, 0x06_eb, 0x06_ec, 0x07_30, 0x07_32, 0x07_33,
  0x07_35, 0x07_36, 0x07_3a, 0x07_3d, 0x07_3f, 0x07_40, 0x07_41, 0x07_43,
  0x07_45, 0x07_47, 0x07_49, 0x07_4a, 0x07_eb, 0x07_ec, 0x07_ed, 0x07_ee,
  0x07_ef, 0x07_f0, 0x07_f1, 0x07_f3, 0x08_16, 0x08_17, 0x08_18, 0x08_19,
  0x08_1b, 0x08_1c, 0x08_1d, 0x08_1e, 0x08_1f, 0x08_20, 0x08_21, 0x08_22,
  0x08_23, 0x08_25, 0x08_26, 0x08_27, 0x08_29, 0x08_2a, 0x08_2b, 0x08_2c,
  0x08_2d, 0x09_51, 0x09_53, 0x09_54,
];

export function detectImageProtocol(): ImageProtocol {
  const override = (Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL ?? "").toLowerCase();
  if (
    override === "kitty" ||
    override === "sixel" ||
    override === "halfblock"
  ) {
    return override;
  }
  // The screenshot harness renders through xterm.js, which supports neither
  // kitty graphics nor sixel; force the universally renderable path.
  if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
    return "halfblock";
  }
  // Sixel only when the terminal positively advertised it and not Kitty;
  // otherwise Kitty is the default.
  if (probedGraphics?.sixel && !probedGraphics.kitty) {
    return "sixel";
  }
  return "kitty";
}

// Write raw bytes straight to fd 1, bypassing the renderer's stdout buffer.
// Used for graphics-protocol escapes that must reach the terminal verbatim.
export function writeRawStdout(payload: string): void {
  try {
    writeSync(1, Buffer.from(payload, "binary"));
  } catch {
    // Best effort: a failed graphics write should never crash the UI.
  }
}

// True when running inside a terminal multiplexer that intercepts escape
// sequences (tmux). Graphics escapes must be wrapped in the multiplexer's
// passthrough envelope or they get swallowed before reaching the host terminal.
export function inMultiplexer(): boolean {
  return Boolean(Bun.env.TMUX);
}

// Wrap a raw escape sequence in tmux's DCS passthrough envelope so it reaches
// the outer terminal: `ESC P tmux ; <payload, every ESC doubled> ESC \`.
// Requires `set -g allow-passthrough on` on tmux >= 3.3 (older tmux passes it
// through by default). Returns the sequence unchanged when not in a multiplexer.
export function wrapForMultiplexer(seq: string): string {
  if (!inMultiplexer()) {
    return seq;
  }
  return `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

// Stable image id per path (kitty ids share a global namespace; reusing one id
// per file avoids leaking placements across re-renders). Kept within 24 bits so
// the id fits entirely in the placeholder foreground color.
const imageIds = new Map<string, number>();
let nextId = 1;
export function imageIdFor(path: string): number {
  let id = imageIds.get(path);
  if (id === undefined) {
    id = nextId++;
    if (nextId > 0xff_ff_ff) {
      nextId = 1;
    }
    imageIds.set(path, id);
  }
  return id;
}

// Stable small image id (1..255) per path for the Unicode-placeholder protocol,
// where the id must fit in a single 256-color foreground index. Distinct from
// imageIdFor (24-bit), which is used for direct (non-placeholder) placements.
const smallImageIds = new Map<string, number>();
let nextSmallId = 1;
export function kittyPlaceholderId(path: string): number {
  let id = smallImageIds.get(path);
  if (id === undefined) {
    id = nextSmallId++;
    if (nextSmallId > 255) {
      nextSmallId = 1;
    }
    smallImageIds.set(path, id);
  }
  return id;
}

// Transmit a PNG and create a *virtual* placement (U=1) referenced by Unicode
// placeholder cells. `cols`/`rows` (c=/r=) scale the whole image into that cell
// rectangle so it matches the placeholder grid — without them Kitty maps the
// placeholders onto the image's native cell grid, showing only a crop. Returns
// each packet separately so callers can wrap them individually for tmux
// passthrough (one giant DCS can be truncated).
export function buildKittyVirtualTransmit(
  pngBase64: string,
  id: number,
  cols: number,
  rows: number
): string[] {
  const chunkSize = 4096;
  const base = `a=T,U=1,i=${id},c=${cols},r=${rows},f=100,q=2`;
  if (pngBase64.length <= chunkSize) {
    return [`${APC}${base};${pngBase64}${ST}`];
  }

  const parts: string[] = [];
  for (let offset = 0; offset < pngBase64.length; offset += chunkSize) {
    const piece = pngBase64.slice(offset, offset + chunkSize);
    const more = offset + chunkSize < pngBase64.length ? 1 : 0;
    parts.push(
      offset === 0
        ? `${APC}${base},m=1;${piece}${ST}`
        : `${APC}m=${more};${piece}${ST}`
    );
  }
  return parts;
}

// Max image cells encodable as placeholders (one diacritic per row/column).
export const KITTY_PLACEHOLDER_MAX = ROWCOLUMN_DIACRITICS.length;

// Placeholder grid WITHOUT color codes — the caller applies the image id via the
// renderer's own foreground color (ansi256(id)) so it survives the cell buffer.
// Every cell carries an explicit (row, column) diacritic pair: relying on
// column auto-increment breaks across newlines and distorts the image.
export function buildKittyPlaceholderText(cols: number, rows: number): string {
  const maxIdx = ROWCOLUMN_DIACRITICS.length - 1;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const rd = String.fromCodePoint(
      ROWCOLUMN_DIACRITICS[Math.min(row, maxIdx)]
    );
    let line = "";
    for (let col = 0; col < cols; col++) {
      const cd = String.fromCodePoint(
        ROWCOLUMN_DIACRITICS[Math.min(col, maxIdx)]
      );
      line += PLACEHOLDER + rd + cd;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// Delete a stored kitty image (and all its placements) by id.
export function buildKittyDelete(id: number): string {
  return `${APC}a=d,d=i,i=${id},q=2${ST}`;
}

// Build the kitty transmit + virtual-placement escape(s) for a PNG payload,
// chunked to the protocol's 4096 base64-char limit.
export function buildKittyTransmit(
  pngBase64: string,
  id: number,
  cols: number,
  rows: number
): string {
  const chunkSize = 4096;
  if (pngBase64.length <= chunkSize) {
    return `${APC}a=T,U=1,i=${id},c=${cols},r=${rows},f=100,q=2;${pngBase64}${ST}`;
  }

  const parts: string[] = [];
  for (let offset = 0; offset < pngBase64.length; offset += chunkSize) {
    const piece = pngBase64.slice(offset, offset + chunkSize);
    const more = offset + chunkSize < pngBase64.length ? 1 : 0;
    if (offset === 0) {
      parts.push(
        `${APC}a=T,U=1,i=${id},c=${cols},r=${rows},f=100,q=2,m=1;${piece}${ST}`
      );
    } else {
      parts.push(`${APC}m=${more};${piece}${ST}`);
    }
  }
  return parts.join("");
}

// Styled placeholder grid: each cell is U+10EEEE with the image id encoded in
// the (true-color) foreground; the first cell of each row carries that row's
// diacritic, the rest inherit row/column from the left.
export function buildKittyPlaceholder(
  id: number,
  cols: number,
  rows: number
): string {
  const r = (id >> 16) & 0xff;
  const g = (id >> 8) & 0xff;
  const b = id & 0xff;
  const fg = `\x1b[38;2;${r};${g};${b}m`;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const diacritic = String.fromCodePoint(
      ROWCOLUMN_DIACRITICS[Math.min(r, ROWCOLUMN_DIACRITICS.length - 1)]
    );
    const line =
      PLACEHOLDER + diacritic + PLACEHOLDER.repeat(Math.max(0, cols - 1));
    lines.push(`${fg}${line}\x1b[0m`);
  }
  return lines.join("\n");
}

// Move the cursor to an absolute cell (1-based) and emit a sixel payload there.
// Sixel has no placeholder mechanism, so this is best-effort: it is re-emitted
// on each layout change and may flicker under heavy redraws.
export function buildSixelAt(sixel: string, x: number, y: number): string {
  const save = "\x1b7";
  const restore = "\x1b8";
  const move = `\x1b[${y + 1};${x + 1}H`;
  return `${save}${move}${sixel}${restore}`;
}

export { PLACEHOLDER, ROWCOLUMN_DIACRITICS };
