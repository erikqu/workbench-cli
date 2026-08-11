import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { prepareHalfblockImage } from "./image";
import { SPLASH_IMAGE_PATH } from "./splash";

test("splash renders the park-bench image instead of binary glyph art", async () => {
  expect(existsSync(SPLASH_IMAGE_PATH)).toBe(true);

  const placement = await prepareHalfblockImage(SPLASH_IMAGE_PATH, 48, 14);

  expect(placement?.protocol).toBe("halfblock");
  if (placement?.protocol !== "halfblock") {
    throw new Error("park-bench splash did not produce an image fallback");
  }
  expect(placement.fallback).toContain("▀");
  expect(placement.fallback).not.toMatch(/[01]{8}/);
});
