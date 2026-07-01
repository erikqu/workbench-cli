import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKittyPlaceholder,
  buildKittyPlaceholderText,
  buildKittyTransmit,
  buildKittyVirtualTransmit,
  detectImageProtocol,
  graphicsAvailable,
  type ImageProtocol,
  imageIdFor,
  KITTY_PLACEHOLDER_MAX,
  kittyPlaceholderDesired,
  kittyPlaceholderId,
  wrapForMultiplexer,
} from "./image-protocol";

// Upper-half block: the cell's foreground paints the top pixel, the background
// paints the bottom pixel, so each terminal row encodes two image rows.
const UPPER_HALF = "\u2580";

// Terminal cells are taller than wide; this is the cell width/height ratio used
// to keep images from looking stretched. It defaults to 0.5 (cells 2:1 tall) but
// the true ratio is font/terminal dependent, so it can be overridden via env or
// auto-detected at startup (see detectCellAspect / setCellAspect).
const DEFAULT_CELL_ASPECT = 0.5;
let cellAspect =
  clampCellAspect(Number(Bun.env.WORKBENCH_UI_CELL_ASPECT)) ??
  DEFAULT_CELL_ASPECT;

function clampCellAspect(value: number): number | undefined {
  return Number.isFinite(value) && value > 0.2 && value < 1 ? value : undefined;
}

// Override the cell aspect (width/height). Ignored if out of a sane range.
export function setCellAspect(value: number): void {
  const clamped = clampCellAspect(value);
  if (clamped !== undefined) {
    cellAspect = clamped;
  }
}

export function getCellAspect(): number {
  return cellAspect;
}

// Real device pixels per terminal cell, learned from the startup terminal probe
// (CSI 14 t / 16 t / 18 t replies). On HiDPI/Retina displays this reflects the
// backing-store density, so callers that rasterize to a cell region (e.g. the
// PDF viewer) can target the monitor's native resolution instead of guessing.
// Undefined until the probe reports it (or on terminals that stay silent).
let cellPixelSize: { w: number; h: number } | undefined;

export function setCellPixelSize(value: { w: number; h: number }): void {
  if (
    Number.isFinite(value.w) &&
    Number.isFinite(value.h) &&
    value.w > 0 &&
    value.h > 0
  ) {
    cellPixelSize = { w: value.w, h: value.h };
  }
}

// Native device pixels per cell column, or undefined if unknown.
export function getCellPixelWidth(): number | undefined {
  return cellPixelSize?.w;
}

const MAX_ART_COLS = 100;
// Cap the pixel size we transmit/encode so escapes stay small.
const MAX_TRANSMIT_DIM = 720;

export type ImagePlacement =
  | { protocol: "halfblock"; styled: string; cols: number; rows: number }
  | {
      protocol: "kitty";
      styled: string;
      transmit: string;
      cols: number;
      rows: number;
    }
  | { protocol: "sixel"; sixel: string; cols: number; rows: number };

export type SilveryImagePlacement =
  // Real pixel graphics: src is either a PNG file path (fast path, no decode) or
  // a converted PNG buffer. Silvery's <Image protocol="auto"> picks kitty/sixel.
  | { protocol: "graphics"; src: Buffer | string; cols: number; rows: number }
  // Kitty graphics through a multiplexer (tmux): the image is transmitted
  // out-of-band (already wrapped for passthrough) and `placeholder` cells,
  // colored with `id`, are drawn in the cell buffer for the terminal to composite.
  | {
      protocol: "kitty-tmux";
      transmit: string;
      placeholder: string;
      id: number;
      cols: number;
      rows: number;
    }
  // ASCII upper-half-block art, used when the terminal can't render graphics.
  | { protocol: "halfblock"; fallback: string; cols: number; rows: number };

// `jimp` is a heavy module (~100ms to evaluate). Load it lazily on first image
// decode so it never sits on the cold-start path — the workbench renders text,
// terminals, and the explorer long before any image is opened.
type JimpModule = typeof import("jimp");
type DecodedImage = Awaited<ReturnType<JimpModule["Jimp"]["read"]>>;

let jimpPromise: Promise<JimpModule["Jimp"]> | undefined;
function getJimp(): Promise<JimpModule["Jimp"]> {
  return (jimpPromise ??= import("jimp").then((m) => m.Jimp));
}

const decodeCache = new Map<string, Promise<DecodedImage | null>>();
const imageSizeCache = new Map<
  string,
  { width: number; height: number } | null
>();
const pngBase64Cache = new Map<string, Promise<string | null>>();

// Drop every cache entry for a path. Image previews are stable so paths are
// cached forever, but the video player feeds thousands of unique frame paths
// through this pipeline; without eviction the decode/size/base64 caches would
// grow without bound. The player calls this once a frame scrolls out of view.
export function forgetImage(path: string): void {
  decodeCache.delete(path);
  imageSizeCache.delete(path);
  const prefix = `${path}:`;
  for (const key of pngBase64Cache.keys()) {
    if (key.startsWith(prefix)) {
      pngBase64Cache.delete(key);
    }
  }
}

// Base64 PNG for kitty transmission, cached per path so repeated resizes of the
// preview pane don't re-encode the (potentially large) bitmap each time.
function pngBase64ForKitty(
  path: string,
  cols: number,
  rows: number
): Promise<string | null> {
  const key = `${path}:${cols}x${rows}`;
  let pending = pngBase64Cache.get(key);
  if (!pending) {
    pending = loadImage(path).then(async (source) => {
      if (!source) {
        return null;
      }
      // Scale to roughly the displayed cell area in pixels. A photo re-encoded
      // as lossless PNG at 720px is ~0.5MB; pushed through tmux passthrough as
      // hundreds of packets, tmux can drop chunks and the image never appears.
      // Matching the display resolution keeps the payload small without any
      // visible quality loss.
      const pw = Math.max(1, Math.min(cols * 8, MAX_TRANSMIT_DIM));
      const ph = Math.max(1, Math.min(rows * 16, MAX_TRANSMIT_DIM));
      const fit = fitToBox(source.bitmap.width, source.bitmap.height, pw, ph);
      const scaled = source.clone().resize({ w: fit.w, h: fit.h });
      return (await scaled.getBuffer("image/png")).toString("base64");
    });
    pngBase64Cache.set(key, pending);
  }
  return pending;
}

// Remote markdown images (READMEs commonly use http(s) screenshots/badges).
// Downloaded once into a temp cache and rendered through the normal pipeline.
const remoteImageDir = join(tmpdir(), "workbench-ui-remote-images");
const remoteImageCache = new Map<string, Promise<string | null>>();
const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;

export function cacheRemoteImage(url: string): Promise<string | null> {
  let pending = remoteImageCache.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(url, { redirect: "follow" });
        if (!response.ok) {
          return null;
        }
        const type = response.headers.get("content-type") ?? "";
        if (type && !type.startsWith("image/")) {
          return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0 || buffer.length > MAX_REMOTE_IMAGE_BYTES) {
          return null;
        }
        mkdirSync(remoteImageDir, { recursive: true });
        const file = join(
          remoteImageDir,
          createHash("sha1").update(url).digest("hex") + extForImageType(type)
        );
        if (!existsSync(file)) {
          writeFileSync(file, buffer);
        }
        return file;
      } catch {
        return null;
      }
    })();
    remoteImageCache.set(url, pending);
  }
  return pending;
}

function extForImageType(type: string): string {
  if (type.includes("png")) {
    return ".png";
  }
  if (type.includes("jpeg") || type.includes("jpg")) {
    return ".jpg";
  }
  if (type.includes("gif")) {
    return ".gif";
  }
  if (type.includes("webp")) {
    return ".webp";
  }
  if (type.includes("svg")) {
    return ".svg";
  }
  if (type.includes("bmp")) {
    return ".bmp";
  }
  return ".img";
}

function fitToBox(w: number, h: number, maxW: number, maxH: number) {
  const scale = Math.min(maxW / w, maxH / h, 1);
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

function loadImage(path: string): Promise<DecodedImage | null> {
  let pending = decodeCache.get(path);
  if (!pending) {
    // Jimp's JPEG decoder rejects some real-world files (CMYK, certain
    // progressive/EXIF variants). Fall back to ImageMagick, then surface a
    // clear error so failures are visible instead of a blank pane.
    pending = getJimp().then((Jimp) =>
      Jimp.read(path).catch(async (err: unknown) => {
        const png = await transcodeToPng(path);
        if (png) {
          return Jimp.read(png);
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not decode image: ${reason} (install ImageMagick for unsupported formats)`
        );
      })
    );
    decodeCache.set(path, pending);
  }
  return pending;
}

// Last-resort transcode for images Jimp can't read. Returns a PNG buffer, or
// null if no system image tool is available / the conversion fails.
async function transcodeToPng(path: string): Promise<Buffer | null> {
  for (const bin of ["magick", "convert"]) {
    try {
      const proc = Bun.spawn([bin, path, "png:-"], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      const code = await proc.exited;
      if (code === 0 && buf.length > 0) {
        return buf;
      }
    } catch {
      // try next binary
    }
  }
  return null;
}

// Cell dimensions to show the image in a (maxCols x maxRows) area, preserving
// aspect ratio with the terminal cell-aspect correction.
export function fitCells(
  imgW: number,
  imgH: number,
  maxCols: number,
  maxRows: number,
  colLimit = MAX_ART_COLS
) {
  const aspect = imgH / imgW;
  let cols = Math.min(maxCols, colLimit);
  let rows = Math.round(cols * aspect * cellAspect);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.round(rows / (aspect * cellAspect));
  }
  cols = Math.max(1, Math.min(cols, maxCols));
  rows = Math.max(1, Math.min(rows, maxRows));
  return { cols, rows };
}

export async function prepareImage(
  path: string,
  maxCols: number,
  maxRows: number
): Promise<ImagePlacement | null> {
  if (maxCols < 1 || maxRows < 1) {
    return null;
  }
  const source = await loadImage(path);
  if (!source) {
    return null;
  }

  const protocol: ImageProtocol = detectImageProtocol();
  const { cols, rows } = fitCells(
    source.bitmap.width,
    source.bitmap.height,
    maxCols,
    maxRows
  );

  if (protocol === "kitty") {
    const scaled = scaleForTransmit(source);
    const base64 = (await scaled.getBuffer("image/png")).toString("base64");
    const id = imageIdFor(path);
    return {
      protocol: "kitty",
      styled: buildKittyPlaceholder(id, cols, rows),
      transmit: buildKittyTransmit(base64, id, cols, rows),
      cols,
      rows,
    };
  }

  if (protocol === "sixel") {
    // Roughly match the cell rectangle in pixels (typical cell ~ 8x16).
    const pw = Math.max(1, Math.min(cols * 8, MAX_TRANSMIT_DIM));
    const ph = Math.max(1, Math.min(rows * 16, MAX_TRANSMIT_DIM));
    const scaled = source.clone().resize({ w: pw, h: ph });
    return {
      protocol: "sixel",
      sixel: encodeSixel(scaled.bitmap.data, pw, ph),
      cols,
      rows,
    };
  }

  return {
    protocol: "halfblock",
    styled: buildHalfBlocks(source, cols, rows),
    cols,
    rows,
  };
}

export async function prepareSilveryImage(
  path: string,
  maxCols: number,
  maxRows: number
): Promise<SilveryImagePlacement | null> {
  if (maxCols < 1 || maxRows < 1) {
    return null;
  }

  // Terminal supports real graphics: hand Silvery a PNG and let it render. We
  // never build half-block art here, so the happy path stays cheap.
  if (graphicsAvailable()) {
    // Inside tmux: render Kitty graphics via the Unicode-placeholder protocol,
    // transmitting the image through tmux's passthrough envelope.
    if (kittyPlaceholderDesired()) {
      // Placeholders can only address up to KITTY_PLACEHOLDER_MAX cells per axis.
      const colCap = Math.min(maxCols, KITTY_PLACEHOLDER_MAX);
      const rowCap = Math.min(maxRows, KITTY_PLACEHOLDER_MAX);
      const size = readImageSize(path);
      let cols: number;
      let rows: number;
      if (size) {
        ({ cols, rows } = fitCells(
          size.width,
          size.height,
          colCap,
          rowCap,
          colCap
        ));
      } else {
        const source = await loadImage(path);
        if (!source) {
          return null;
        }
        ({ cols, rows } = fitCells(
          source.bitmap.width,
          source.bitmap.height,
          colCap,
          rowCap,
          colCap
        ));
      }
      const base64 = await pngBase64ForKitty(path, cols, rows);
      if (base64) {
        const id = kittyPlaceholderId(path);
        const transmit = buildKittyVirtualTransmit(base64, id, cols, rows)
          .map(wrapForMultiplexer)
          .join("");
        const placeholder = buildKittyPlaceholderText(cols, rows);
        return {
          protocol: "kitty-tmux",
          transmit,
          placeholder,
          id,
          cols,
          rows,
        };
      }
    }

    // PNG fast path: read just the header for dimensions and pass the file path
    // straight through (no decode, no re-encode).
    const size = readImageSize(path);
    if (size) {
      const { cols, rows } = fitCells(
        size.width,
        size.height,
        maxCols,
        maxRows,
        maxCols
      );
      return { protocol: "graphics", src: path, cols, rows };
    }
    // Non-PNG (JPEG/WebP/…): decode and convert to a capped PNG buffer.
    const source = await loadImage(path);
    if (!source) {
      return null;
    }
    const fit = fitCells(
      source.bitmap.width,
      source.bitmap.height,
      maxCols,
      maxRows,
      maxCols
    );
    const pw = Math.max(1, Math.min(fit.cols * 8, MAX_TRANSMIT_DIM));
    const ph = Math.max(1, Math.min(fit.rows * 16, MAX_TRANSMIT_DIM));
    const scaled = source.clone().resize({ w: pw, h: ph });
    return {
      protocol: "graphics",
      src: Buffer.from(await scaled.getBuffer("image/png")),
      cols: fit.cols,
      rows: fit.rows,
    };
  }

  // No graphics support: decode and render ASCII upper-half-block art.
  const source = await loadImage(path);
  if (!source) {
    return null;
  }
  const { cols, rows } = fitCells(
    source.bitmap.width,
    source.bitmap.height,
    maxCols,
    maxRows
  );
  return {
    protocol: "halfblock",
    fallback: buildHalfBlocks(source, cols, rows),
    cols,
    rows,
  };
}

export async function prepareHalfblockImage(
  path: string,
  maxCols: number,
  maxRows: number
): Promise<SilveryImagePlacement | null> {
  if (maxCols < 1 || maxRows < 1) {
    return null;
  }
  const source = await loadImage(path);
  if (!source) {
    return null;
  }
  const { cols, rows } = fitCells(
    source.bitmap.width,
    source.bitmap.height,
    maxCols,
    maxRows
  );
  return {
    protocol: "halfblock",
    fallback: buildHalfBlocks(source, cols, rows),
    cols,
    rows,
  };
}

function readImageSize(path: string): { width: number; height: number } | null {
  if (imageSizeCache.has(path)) {
    return imageSizeCache.get(path) ?? null;
  }

  let size: { width: number; height: number } | null = null;
  let fd: number | undefined;
  try {
    const header = Buffer.alloc(64);
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (
      bytes.length >= 24 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
  } catch {
    size = null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close races from disappearing files.
      }
    }
  }

  imageSizeCache.set(path, size);
  return size;
}

// Returns a fresh image scaled so its longest side fits MAX_TRANSMIT_DIM. The
// cast works around jimp's incompatible-overload typings for clone()/resize().
function scaleForTransmit(source: DecodedImage): DecodedImage {
  const { width, height } = source.bitmap;
  const longest = Math.max(width, height);
  const clone = source.clone();
  if (longest <= MAX_TRANSMIT_DIM) {
    return clone as DecodedImage;
  }
  const scale = MAX_TRANSMIT_DIM / longest;
  return clone.resize({
    w: Math.round(width * scale),
    h: Math.round(height * scale),
  }) as DecodedImage;
}

function buildHalfBlocks(
  source: DecodedImage,
  cols: number,
  rows: number
): string {
  const ph = rows * 2;
  const img = source.clone().resize({ w: cols, h: ph });
  const data = img.bitmap.data;
  const rowBytes = cols * 4;

  const at = (x: number, y: number) => {
    const i = y * rowBytes + x * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  };

  const lines: string[] = [];
  for (let cy = 0; cy < rows; cy++) {
    const topY = cy * 2;
    const bottomY = topY + 1;
    let line = "";
    let runFg: Rgb | null = null;
    let runBg: Rgb | null = null;
    let run = "";
    const flush = () => {
      if (!(run && runFg && runBg)) {
        return;
      }
      line += `\x1b[9999;38;2;${runFg.r};${runFg.g};${runFg.b};48;2;${runBg.r};${runBg.g};${runBg.b}m${run}\x1b[0m`;
      run = "";
    };
    for (let x = 0; x < cols; x++) {
      const fg = at(x, topY);
      const bg = at(x, bottomY);
      if (runFg && sameColor(runFg, fg) && runBg && sameColor(runBg, bg)) {
        run += UPPER_HALF;
      } else {
        flush();
        run = UPPER_HALF;
        runFg = fg;
        runBg = bg;
      }
    }
    flush();
    lines.push(line);
  }
  return lines.join("\n");
}

interface Rgb {
  b: number;
  g: number;
  r: number;
}

function sameColor(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

// Minimal sixel encoder: quantizes to a 6-level-per-channel palette (<=216
// colors) and emits 6-row bands. Good enough for previews on sixel terminals.
export function encodeSixel(data: Uint8Array, w: number, h: number): string {
  const quant = (v: number) => Math.round((v / 255) * 5);
  const toSixel = (level: number) => Math.round((level / 5) * 100);

  const palette = new Map<number, number>();
  const idx = new Int16Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    const key =
      quant(data[o]) * 36 + quant(data[o + 1]) * 6 + quant(data[o + 2]);
    let pi = palette.get(key);
    if (pi === undefined) {
      pi = palette.size;
      palette.set(key, pi);
    }
    idx[p] = pi;
  }

  let out = "\x1bPq";
  out += `"1;1;${w};${h}`;
  for (const [key, pi] of palette) {
    const r = Math.floor(key / 36);
    const g = Math.floor((key % 36) / 6);
    const b = key % 6;
    out += `#${pi};2;${toSixel(r)};${toSixel(g)};${toSixel(b)}`;
  }

  const bands = Math.ceil(h / 6);
  for (let band = 0; band < bands; band++) {
    const present = new Set<number>();
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 6; k++) {
        const y = band * 6 + k;
        if (y < h) {
          present.add(idx[y * w + x]);
        }
      }
    }
    let first = true;
    for (const pi of present) {
      if (!first) {
        out += "$";
      }
      first = false;
      out += `#${pi}`;
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let k = 0; k < 6; k++) {
          const y = band * 6 + k;
          if (y < h && idx[y * w + x] === pi) {
            bits |= 1 << k;
          }
        }
        out += String.fromCharCode(63 + bits);
      }
    }
    out += "-";
  }
  out += "\x1b\\";
  return out;
}
