import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorTabKind, openEditorTab } from "./editor";

describe("editorTabKind", () => {
  test("opens animated GIFs in the frame player", () => {
    expect(editorTabKind("/tmp/preview.gif")).toBe("video");
    expect(editorTabKind("/tmp/preview.GIF")).toBe("video");
  });

  test("keeps still images in the image viewer", () => {
    expect(editorTabKind("/tmp/preview.png")).toBe("image");
    expect(editorTabKind("/tmp/preview.webp")).toBe("image");
  });

  test("opens Blender and glTF binaries lazily in the 3D viewer", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-model-tabs-"));
    try {
      for (const extension of ["blend", "BLEND", "glb", "GLB"]) {
        const path = join(dir, `model.${extension}`);
        writeFileSync(path, Buffer.alloc(128 * 1024));
        expect(editorTabKind(path)).toBe("model");
        expect(openEditorTab(path)).toMatchObject({
          kind: "model",
          binary: true,
          content: "",
          truncated: false,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
