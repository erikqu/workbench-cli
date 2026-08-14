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
