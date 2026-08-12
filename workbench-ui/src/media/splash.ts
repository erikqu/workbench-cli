import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCellAspect } from "./image";

const ASSET_DIR = join(import.meta.dir, "..", "..", "assets", "splash");
const DARK_GLYPH_CUTOFF = 96;
const LIGHT_GLYPH_CUTOFF = 192;

export const SPLASH_IMAGE_PATH = join(ASSET_DIR, "og-image.jpg");
export const SPLASH_MAX_COLS = 100;

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

type DecodedImage = Awaited<ReturnType<typeof import("jimp")["Jimp"]["read"]>>;
let sourcePromise: Promise<DecodedImage | null> | undefined;

function sourceImage(): Promise<DecodedImage | null> {
  if (!sourcePromise) {
    sourcePromise = import("jimp")
      .then(({ Jimp }) => Jimp.read(SPLASH_IMAGE_PATH))
      .then((image) => image.greyscale() as DecodedImage)
      .catch(() => null);
  }
  return sourcePromise;
}

export async function buildBinarySplashArt(
  availableColumns: number,
  availableRows: number
): Promise<string[]> {
  const source = await sourceImage();
  if (!source || availableColumns < 1 || availableRows < 1) {
    return [];
  }
  const { columns, rows } = binaryArtSize(
    availableColumns,
    availableRows,
    source.bitmap.width,
    source.bitmap.height
  );
  const image = source.clone().resize({ h: rows, w: columns });
  const lines: string[] = [];
  for (let y = 0; y < image.bitmap.height; y++) {
    let line = "";
    for (let x = 0; x < image.bitmap.width; x++) {
      const luminance = image.bitmap.data[(y * image.bitmap.width + x) * 4];
      line += binaryGlyph(luminance);
    }
    lines.push(line);
  }
  return lines;
}

function binaryArtSize(
  availableColumns: number,
  availableRows: number,
  imageWidth: number,
  imageHeight: number
) {
  const maxColumns = Math.max(
    1,
    Math.min(SPLASH_MAX_COLS, Math.floor(availableColumns))
  );
  const maxRows = Math.max(1, Math.floor(availableRows));
  const correctedAspect = (imageHeight / imageWidth) * getCellAspect();
  let columns = maxColumns;
  let rows = columns * correctedAspect;
  if (rows > maxRows) {
    rows = maxRows;
    columns = rows / correctedAspect;
  }
  return {
    columns: Math.max(1, Math.min(maxColumns, Math.round(columns))),
    rows: Math.max(1, Math.min(maxRows, Math.round(rows))),
  };
}

function binaryGlyph(luminance: number): string {
  if (luminance < DARK_GLYPH_CUTOFF) {
    return "0";
  }
  if (luminance < LIGHT_GLYPH_CUTOFF) {
    return "1";
  }
  return " ";
}
