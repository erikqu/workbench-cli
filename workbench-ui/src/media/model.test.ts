import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blenderExecutable,
  DEFAULT_MODEL_CAMERA,
  modelPreviewSize,
  normalizeModelCamera,
  prepareModelPreview,
} from "./model";

describe("3D previews", () => {
  test("bounds camera motion and buckets raster sizes without changing the aspect significantly", () => {
    expect(
      normalizeModelCamera({
        azimuth: -15,
        elevation: 120,
        zoom: 99,
        source: "orbit",
      })
    ).toEqual({ azimuth: 345, elevation: 80, zoom: 4, source: "orbit" });
    expect(
      normalizeModelCamera({
        azimuth: Number.NaN,
        elevation: Number.NaN,
        zoom: -1,
        source: "scene",
      })
    ).toEqual({ azimuth: 315, elevation: 25, zoom: 0.25, source: "scene" });
    expect(modelPreviewSize(80, 20, 0.5, 10)).toEqual({
      width: 832,
      height: 448,
    });
    expect(modelPreviewSize(79, 20, 0.5, 10)).toEqual(
      modelPreviewSize(80, 20, 0.5, 10)
    );
    const wide = modelPreviewSize(400, 100, 0.5, 20);
    expect(wide.width).toBe(1280);
    expect(wide.width / wide.height).toBe(2);
  });

  test("cancels obsolete renders, rejects partial PNGs, and invalidates changed files and views", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-model-test-"));
    const path = join(dir, "model 'quoted' $(no-shell).glb");
    const renderer = join(dir, "blender");
    writeFileSync(path, "fake GLB");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVxkAAAAASUVORK5CYII=";
    writeFileSync(
      renderer,
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const image = args[args.indexOf("--output") + 1];
appendFileSync(process.env.MODEL_TEST_LOG, JSON.stringify({pid:process.pid,image,args})+"\\n");
writeFileSync(image,"partial");
await Bun.sleep(200);
if (args[args.indexOf("--camera")+1] === "scene") process.exit(0);
writeFileSync(image,Buffer.from(${JSON.stringify(png)},"base64"));
`,
      { mode: 0o755 }
    );
    const script = join(dir, "check.ts");
    writeFileSync(
      script,
      `
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_MODEL_CAMERA as view, prepareModelPreview } from ${JSON.stringify(join(import.meta.dir, "model.ts"))};
const path=${JSON.stringify(path)}, log=${JSON.stringify(join(dir, "renders"))};
const events=()=>existsSync(log)?readFileSync(log,"utf8").trim().split("\\n").map(JSON.parse):[];
const size={width:320,height:240};
const controller=new AbortController();
const pending=prepareModelPreview(path,view,size,controller.signal);
const rejected=assert.rejects(pending,{name:"AbortError"});
const deadline=Date.now()+4000;
while(!events().length && Date.now()<deadline) await Bun.sleep(5);
assert.equal(events().length,1);
const first=events()[0];
controller.abort(); await rejected;
assert.throws(()=>process.kill(first.pid,0));
assert.equal(existsSync(first.image),false);
const render=await prepareModelPreview(path,view,size);
assert.equal(readFileSync(render.imagePath)[0],137);
assert.equal((await prepareModelPreview(path,view,size)).imagePath,render.imagePath);
assert.equal(events().length,2);
assert(events()[1].args.includes("--disable-autoexec"));
assert(events()[1].args.includes("--factory-startup"));
assert(events()[1].args.includes(path));
assert.notEqual((await prepareModelPreview(path,{...view,azimuth:90},size)).imagePath,render.imagePath);
writeFileSync(path,"changed GLB file");
assert.notEqual((await prepareModelPreview(path,view,size)).imagePath,render.imagePath);
assert.notEqual((await prepareModelPreview(path,view,size,undefined,"refresh")).imagePath,render.imagePath);
await assert.rejects(prepareModelPreview(path,{...view,source:"scene"},size),/Could not render/);
assert.equal(existsSync(events().at(-1).image),false);
const skipped=new AbortController(); skipped.abort();
const count=events().length;
await assert.rejects(prepareModelPreview(path,view,size,skipped.signal),{name:"AbortError"});
assert.equal(events().length,count);
`
    );
    try {
      const child = Bun.spawn([process.execPath, script], {
        env: {
          ...Bun.env,
          WORKBENCH_BLENDER: renderer,
          MODEL_TEST_LOG: join(dir, "renders"),
          TMPDIR: dir,
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const testWithBlender = blenderExecutable() ? test : test.skip;
  testWithBlender(
    "renders actual Blender and GLB geometry and preserves the source files",
    async () => {
      const blender = blenderExecutable();
      if (!blender) {
        return;
      }
      const dir = mkdtempSync(join(tmpdir(), "wb-model-real-"));
      const hash = (path: string) =>
        createHash("sha256").update(readFileSync(path)).digest("hex");
      try {
        const child = Bun.spawn(
          [
            blender,
            "--background",
            "--factory-startup",
            "--python-exit-code",
            "2",
            "--python",
            join(
              import.meta.dir,
              "../../test-harness/create-model-fixtures.py"
            ),
            "--",
            dir,
          ],
          { stdout: "pipe", stderr: "pipe" }
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
        expect(code, stderr).toBe(0);
        for (const extension of ["blend", "glb"]) {
          const path = join(dir, `sample.${extension}`);
          const original = hash(path);
          const preview = await prepareModelPreview(
            path,
            DEFAULT_MODEL_CAMERA,
            {
              width: 320,
              height: 240,
            }
          );
          expect(existsSync(preview.imagePath)).toBe(true);
          expect(readFileSync(preview.imagePath).length).toBeGreaterThan(5000);
          const rotated = await prepareModelPreview(
            path,
            { ...DEFAULT_MODEL_CAMERA, azimuth: 135 },
            { width: 320, height: 240 }
          );
          expect(hash(rotated.imagePath)).not.toBe(hash(preview.imagePath));
          if (extension === "blend") {
            const scene = await prepareModelPreview(
              path,
              { ...DEFAULT_MODEL_CAMERA, source: "scene" },
              { width: 320, height: 240 }
            );
            expect(hash(scene.imagePath)).not.toBe(hash(preview.imagePath));
          }
          expect(hash(path)).toBe(original);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000
  );
});
