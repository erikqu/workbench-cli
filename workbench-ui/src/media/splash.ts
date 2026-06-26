import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCellAspect } from "./image";

// Splash art ported from the Rust TUI's `widgets/splash.rs`: the embedded hero
// image is converted to binary (0/1) ASCII art on the fly to fit the terminal,
// with three luminance tiers. Falls back to a static wordmark when the area is
// too small or the image can't be decoded.

const ASSET_DIR = join(import.meta.dir, "..", "..", "assets", "splash");
const IMAGE_PATH = join(ASSET_DIR, "og-image.jpg");
const LOGO_PATH = join(ASSET_DIR, "logo.txt");

// Luminance threshold below which a pixel renders as empty background.
const DARK_CUTOFF = 32;
// Don't let the art get absurdly wide on ultrawide terminals.
const MAX_ART_COLS = 100;
// Below this available size, fall back to the static text logo.
const MIN_ART_COLS = 40;
const MIN_ART_ROWS = 10;

// Luminance tier colors (match the Rust theme: muted -> emphasized).
const TIER_DARK = "#5c5c64";
const TIER_MUTED = "#a1a1aa";
const TIER_BRIGHT = "#faf9f7";
const LOGO_COLOR = "#5fa8a8";

export interface ArtRun {
  bold?: boolean;
  color: string;
  text: string;
}
export type ArtRow = ArtRun[];
export interface SplashArt {
  fallback: boolean;
  rows: ArtRow[];
}

export const SPLASH_VERSION: string = (() => {
  try {
    return (
      JSON.parse(
        readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")
      ).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
})();

// Load jimp lazily so its ~100ms module evaluation stays off the cold-start
// path; the splash art is built asynchronously and pops in a frame later.
type DecodedImage = Awaited<ReturnType<typeof import("jimp")["Jimp"]["read"]>>;
let sourcePromise: Promise<DecodedImage | null> | undefined;
function sourceImage(): Promise<DecodedImage | null> {
  if (!sourcePromise) {
    sourcePromise = import("jimp")
      .then(({ Jimp }) => Jimp.read(IMAGE_PATH))
      .then((img) => img.greyscale() as DecodedImage)
      .catch(() => null);
  }
  return sourcePromise;
}

// Pick the ASCII art size (cols, rows) for the available cell area, keeping the
// image aspect ratio after correcting for the terminal cell aspect. Returns
// null when the area is too small to render the image legibly.
function artSize(
  availCols: number,
  availRows: number,
  imgW: number,
  imgH: number
): { cols: number; rows: number } | null {
  if (
    availCols < MIN_ART_COLS ||
    availRows < MIN_ART_ROWS ||
    imgW === 0 ||
    imgH === 0
  ) {
    return null;
  }
  const cellAspect = getCellAspect();
  const maxCols = Math.min(availCols, MAX_ART_COLS);
  const pixelAspect = imgH / imgW;

  let cols = maxCols;
  let rows = cols * pixelAspect * cellAspect;
  if (rows > availRows) {
    rows = availRows;
    cols = rows / (pixelAspect * cellAspect);
  }
  cols = clamp(Math.round(cols), 1, availCols);
  rows = clamp(Math.round(rows), 1, availRows);
  if (cols < MIN_ART_COLS || rows < MIN_ART_ROWS) {
    return null;
  }
  return { cols, rows };
}

// Binary-art glyph: dark pixels are blank, lit pixels become a 0 or 1 chosen by
// a position hash so the pattern is stable across renders.
function glyphAt(x: number, y: number, v: number): string {
  if (v < DARK_CUTOFF) {
    return " ";
  }
  const h = (Math.imul(x, 0x9e_37_79_b9) + Math.imul(y, 0x85_eb_ca_6b)) >>> 0;
  return ((h >>> 16) & 1) === 0 ? "0" : "1";
}

function tierFor(v: number): { color: string; bold: boolean } {
  if (v < 96) {
    return { color: TIER_DARK, bold: false };
  }
  if (v < 180) {
    return { color: TIER_MUTED, bold: false };
  }
  return { color: TIER_BRIGHT, bold: true };
}

function imageToRows(img: DecodedImage): ArtRow[] {
  const { data, width, height } = img.bitmap;
  const rows: ArtRow[] = [];
  for (let y = 0; y < height; y++) {
    const runs: ArtRow = [];
    let runText = "";
    let runColor = "";
    let runBold = false;
    for (let x = 0; x < width; x++) {
      const v = data[(y * width + x) * 4];
      const tier = tierFor(v);
      if (runText && (tier.color !== runColor || tier.bold !== runBold)) {
        runs.push({ text: runText, color: runColor, bold: runBold });
        runText = "";
      }
      runColor = tier.color;
      runBold = tier.bold;
      runText += glyphAt(x, y, v);
    }
    if (runText) {
      runs.push({ text: runText, color: runColor, bold: runBold });
    }
    rows.push(runs);
  }
  return rows;
}

let logoRows: ArtRow[] | undefined;
function fallbackLogo(): SplashArt {
  if (!logoRows) {
    try {
      logoRows = readFileSync(LOGO_PATH, "utf8")
        .split("\n")
        .map((line) => [{ text: line, color: LOGO_COLOR, bold: true }]);
    } catch {
      logoRows = [[{ text: "WORKBENCH", color: LOGO_COLOR, bold: true }]];
    }
  }
  return { rows: logoRows, fallback: true };
}

const cache = new Map<string, SplashArt>();

export async function buildSplashArt(
  availCols: number,
  availRows: number
): Promise<SplashArt> {
  const source = await sourceImage();
  if (!source) {
    return fallbackLogo();
  }
  const size = artSize(
    availCols,
    availRows,
    source.bitmap.width,
    source.bitmap.height
  );
  if (!size) {
    return fallbackLogo();
  }

  const key = `${size.cols}x${size.rows}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const resized = source
    .clone()
    .resize({ w: size.cols, h: size.rows }) as DecodedImage;
  const art: SplashArt = { rows: imageToRows(resized), fallback: false };
  cache.set(key, art);
  return art;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
