import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfPreviewWidth } from "./pdf";

describe("PDF previews", () => {
  test("reuses nearby widths without undersampling the pane", () => {
    expect(pdfPreviewWidth(40, 10)).toBe(720);
    expect(pdfPreviewWidth(139, 10)).toBe(1408);
    expect(pdfPreviewWidth(140, 10)).toBe(1408);
    expect(pdfPreviewWidth(400, 10)).toBe(3072);
    expect(pdfPreviewWidth(139, 20)).toBe(2816);
  });

  test("cancels obsolete rasterizers and only caches completed pages", async () => {
    // Isolated binaries avoid changing PATH or mocking spawn in other tests.
    const root = mkdtempSync(join(tmpdir(), "wb-pdf-test-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const document = join(root, "large.pdf");
    writeFileSync(document, "fake PDF");
    writeFileSync(
      join(bin, "pdfinfo"),
      `#!${process.execPath}\nconsole.log("Pages: 1000");\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(bin, "pdftoppm"),
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const image = process.argv.at(-1) + ".png";
writeFileSync(image, "partial");
appendFileSync(process.env.PDF_TEST_LOG, JSON.stringify({ pid: process.pid, image }) + "\\n");
await Bun.sleep(250);
writeFileSync(image, "complete");
`,
      { mode: 0o755 }
    );
    const script = join(root, "check.ts");
    writeFileSync(
      script,
      `
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { preparePdfPreview } from ${JSON.stringify(join(import.meta.dir, "pdf.ts"))};
const path = ${JSON.stringify(document)};
const log = ${JSON.stringify(join(root, "renders"))};
const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").map(JSON.parse) : [];
const controller = new AbortController();
const pending = preparePdfPreview(path, 1, 139, controller.signal);
const rejected = assert.rejects(pending, { name: "AbortError" });
const deadline = Date.now() + 3000;
while (!events().length && Date.now() < deadline) await Bun.sleep(5);
assert.equal(events().length, 1);
const first = events()[0];
controller.abort();
await rejected;
assert.throws(() => process.kill(first.pid, 0));
assert.equal(existsSync(first.image), false);
const preview = await preparePdfPreview(path, 1, 139);
assert.equal(readFileSync(preview.imagePath, "utf8"), "complete");
assert.equal(preview.pageCount, 1000);
const cached = await preparePdfPreview(path, 1, 140);
assert.equal(cached.imagePath, preview.imagePath);
assert.equal(events().length, 2);
const skipped = new AbortController();
const skipping = preparePdfPreview(path, 2, 139, skipped.signal);
const skipRejected = assert.rejects(skipping, { name: "AbortError" });
skipped.abort();
await skipRejected;
assert.equal(events().length, 2);
const final = await preparePdfPreview(path, 1001, 139);
assert.equal(final.page, 1000);
assert.equal(readFileSync(final.imagePath, "utf8"), "complete");
`
    );
    try {
      const child = Bun.spawn([process.execPath, script], {
        env: {
          ...Bun.env,
          PATH: `${bin}:${Bun.env.PATH}`,
          TMPDIR: root,
          PDF_TEST_LOG: join(root, "renders"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
