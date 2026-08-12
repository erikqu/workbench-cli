import { readFileSync } from "node:fs";
import { join } from "node:path";

const ASSET_DIR = join(import.meta.dir, "..", "..", "assets", "splash");

// The splash decodes this image into colored terminal-cell art. It must never
// use a native graphics protocol, which can flash above the TUI during redraws.
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
