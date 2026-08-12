import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { buildBinarySplashArt, SPLASH_IMAGE_PATH } from "./splash";

test("splash converts the park-bench image to monochrome binary ASCII", async () => {
  expect(existsSync(SPLASH_IMAGE_PATH)).toBe(true);

  const lines = await buildBinarySplashArt(48, 14);
  const art = lines.join("\n");

  expect(lines.length).toBeGreaterThan(0);
  expect(art).toMatch(/[01]{8}/);
  expect(art).toMatch(/^[01 \n]+$/);
  expect(art).not.toContain("▀");
  expect(art).not.toContain("\x1b");
});
