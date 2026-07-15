import { describe, expect, test } from "bun:test";
import { frameExtractionFilter, gifPreviewWidth } from "./video";

describe("GIF preview quality", () => {
  test("targets the pane's native pixel width within PDF-quality bounds", () => {
    expect(gifPreviewWidth(40, 10)).toBe(720);
    expect(gifPreviewWidth(139, 10)).toBe(1408);
    expect(gifPreviewWidth(400, 10)).toBe(3072);
  });

  test("uses Lanczos without upscaling the GIF source", () => {
    expect(frameExtractionFilter(12, 1408)).toBe(
      "fps=12,scale=w='min(iw,1408)':h='min(ih,3072)':force_original_aspect_ratio=decrease:flags=lanczos"
    );
  });

  test("keeps ordinary video extraction on the lower-cost path", () => {
    expect(frameExtractionFilter(15)).toBe(
      "fps=15,scale=480:-2:flags=fast_bilinear"
    );
  });
});
