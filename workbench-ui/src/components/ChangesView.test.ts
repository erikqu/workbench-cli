import { expect, test } from "bun:test";
import type { DiffFile } from "../text/diff";
import { imageDiffPreviewPath } from "./ChangesView";

function diffFile(path: string, status: DiffFile["status"] = "modified") {
  return {
    added: 0,
    binary: true,
    deleted: 0,
    path,
    relativePath: path,
    status,
  } satisfies DiffFile;
}

test("previews current images in the diff detail", () => {
  expect(imageDiffPreviewPath(diffFile("/tmp/change.png"))).toBe(
    "/tmp/change.png"
  );
  expect(imageDiffPreviewPath(diffFile("/tmp/change.webp"))).toBe(
    "/tmp/change.webp"
  );
});

test("keeps text and deleted binary files in the normal diff detail", () => {
  expect(imageDiffPreviewPath(diffFile("/tmp/change.bin"))).toBeUndefined();
  expect(
    imageDiffPreviewPath(diffFile("/tmp/change.png", "deleted"))
  ).toBeUndefined();
});
