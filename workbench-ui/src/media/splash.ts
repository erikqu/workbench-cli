import { readFileSync } from "node:fs";
import { join } from "node:path";

const ASSET_DIR = join(import.meta.dir, "..", "..", "assets", "splash");

export const SPLASH_LOGO_PATH = join(ASSET_DIR, "logo.txt");

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

const README_LOGO = readFileSync(SPLASH_LOGO_PATH, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => line.trimEnd());
const README_LOGO_WIDTH = Math.max(...README_LOGO.map((line) => line.length));

const BRAILLE_DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export function buildReadmeSplashArt(
  availableColumns: number,
  availableRows: number
): string[] {
  if (availableColumns < 1 || availableRows < 1) {
    return [];
  }
  if (
    availableColumns < README_LOGO_WIDTH ||
    availableRows < README_LOGO.length
  ) {
    return ["Workbench"];
  }
  return README_LOGO;
}

// Rotate the same bitmap used by the splash counterclockwise, placing the W at
// the bottom, then pack its pixels into 2x4-dot terminal cells. This preserves
// the real wordmark at a fraction of the 84 rows a literal rotation would need.
export function buildVerticalWorkbenchArt(
  availableRows: number,
  scale = 1
): string[] {
  if (availableRows < 1 || scale <= 0) {
    return [];
  }
  const sourceHeight = README_LOGO.length;
  const pixelHeight = Math.min(
    Math.round(README_LOGO_WIDTH * scale),
    availableRows * 4
  );
  const pixelWidth = Math.max(1, Math.round(sourceHeight * scale));
  const cellRows = Math.ceil(pixelHeight / 4);
  const cellColumns = Math.ceil(pixelWidth / 2);
  const output: string[] = [];

  for (let cellY = 0; cellY < cellRows; cellY += 1) {
    let line = "";
    for (let cellX = 0; cellX < cellColumns; cellX += 1) {
      let mask = 0;
      for (let pixelY = 0; pixelY < 4; pixelY += 1) {
        for (let pixelX = 0; pixelX < 2; pixelX += 1) {
          const targetY = cellY * 4 + pixelY;
          const targetX = cellX * 2 + pixelX;
          if (targetY >= pixelHeight || targetX >= pixelWidth) {
            continue;
          }
          const sourceX =
            README_LOGO_WIDTH -
            1 -
            Math.min(
              README_LOGO_WIDTH - 1,
              Math.floor(((targetY + 0.5) * README_LOGO_WIDTH) / pixelHeight)
            );
          const sourceY = Math.min(
            sourceHeight - 1,
            Math.floor(((targetX + 0.5) * sourceHeight) / pixelWidth)
          );
          if ((README_LOGO[sourceY]?.[sourceX] ?? " ") !== " ") {
            mask |= BRAILLE_DOTS[pixelY]?.[pixelX] ?? 0;
          }
        }
      }
      line += mask === 0 ? " " : String.fromCodePoint(0x28_00 + mask);
    }
    output.push(line.trimEnd());
  }
  // At the enlarged sidebar scale, the narrow tip of the rotated `r` can land
  // in a cell by itself and read as punctuation: `Wor.kbench`. The remaining
  // rows retain the letterform, so omit only a truly solitary rendered cell.
  return output.map((line) => (line.trim().length === 1 ? "" : line));
}
