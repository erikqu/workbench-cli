import { expect, test } from "bun:test";
import { prepareHalfblockImage, prepareSilveryImage } from "../../media/image";
import { imagePreparer } from "./ImageViewer";

test("terminal-art image surfaces cannot select native graphics", () => {
  expect(imagePreparer(true)).toBe(prepareHalfblockImage);
  expect(imagePreparer(false)).toBe(prepareSilveryImage);
});
