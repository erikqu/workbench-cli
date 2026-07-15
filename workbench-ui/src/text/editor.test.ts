import { describe, expect, test } from "bun:test";
import { editorTabKind } from "./editor";

describe("editorTabKind", () => {
  test("opens animated GIFs in the frame player", () => {
    expect(editorTabKind("/tmp/preview.gif")).toBe("video");
    expect(editorTabKind("/tmp/preview.GIF")).toBe("video");
  });

  test("keeps still images in the image viewer", () => {
    expect(editorTabKind("/tmp/preview.png")).toBe("image");
    expect(editorTabKind("/tmp/preview.webp")).toBe("image");
  });
});
