import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { getCellAspect, getCellPixelWidth } from "./image";

const previewDir = join(tmpdir(), "workbench-ui-model-previews");
const rendererScript = join(import.meta.dir, "model-render.py");
const renderTimeoutMs = 90_000;

export interface ModelCamera {
  azimuth: number;
  elevation: number;
  source: "orbit" | "scene";
  zoom: number;
}

export const DEFAULT_MODEL_CAMERA: ModelCamera = {
  azimuth: 315,
  elevation: 25,
  zoom: 1,
  source: "orbit",
};

export function normalizeModelCamera(camera: ModelCamera): ModelCamera {
  return {
    azimuth: ((finite(camera.azimuth, 315) % 360) + 360) % 360,
    elevation: Math.max(-80, Math.min(80, finite(camera.elevation, 25))),
    zoom: Math.max(0.25, Math.min(4, finite(camera.zoom, 1))),
    source: camera.source === "scene" ? "scene" : "orbit",
  };
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

export function modelPreviewSize(
  cols: number,
  rows: number,
  cellAspect = getCellAspect(),
  cellWidth = getCellPixelWidth() ?? 10
): { width: number; height: number } {
  const w = Math.max(1, finite(cols, 1)) * cellWidth;
  const h = (Math.max(1, finite(rows, 1)) * cellWidth) / cellAspect;
  const scale = Math.min(1280, Math.max(320, w, h)) / Math.max(w, h);
  return {
    width: Math.max(64, Math.min(1280, Math.ceil((w * scale) / 64) * 64)),
    height: Math.max(64, Math.min(1280, Math.ceil((h * scale) / 64) * 64)),
  };
}

export function blenderExecutable(): string | undefined {
  const override = Bun.env.WORKBENCH_BLENDER;
  if (override) {
    return Bun.which(override) ?? undefined;
  }
  return (
    Bun.which("blender") ??
    Bun.which("/Applications/Blender.app/Contents/MacOS/Blender") ??
    undefined
  );
}

// The source remains read-only. Every view is rendered in an isolated Blender
// process, and only a complete PNG is atomically promoted into the cache.
export async function prepareModelPreview(
  path: string,
  requestedCamera: ModelCamera,
  size: { width: number; height: number },
  signal?: AbortSignal,
  refresh = ""
): Promise<{ imagePath: string }> {
  signal?.throwIfAborted();
  if (![".blend", ".glb"].includes(extname(path).toLowerCase())) {
    throw new Error("Unsupported 3D file. Open a .blend or .glb file.");
  }
  const source = resolve(path);
  const stat = statSync(source);
  if (!stat.isFile()) {
    throw new Error("The 3D preview needs a file.");
  }
  const camera = normalizeModelCamera(requestedCamera);
  const dimensions = {
    width: Math.max(64, Math.min(1280, Math.floor(finite(size.width, 640)))),
    height: Math.max(64, Math.min(1280, Math.floor(finite(size.height, 480)))),
  };
  const digest = createHash("sha256")
    .update(readFileSync(rendererScript))
    .update(
      JSON.stringify({
        source,
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        camera,
        dimensions,
        refresh,
      })
    )
    .digest("hex");
  const imagePath = join(previewDir, `${digest}.png`);
  if (completePng(imagePath)) {
    return { imagePath };
  }
  const blender = blenderExecutable();
  if (!blender) {
    throw new Error(
      "Install Blender to preview .blend and .glb files, or set WORKBENCH_BLENDER to its executable."
    );
  }
  await waitForRender(signal);
  mkdirSync(previewDir, { recursive: true });
  const output = join(previewDir, `${digest}.${crypto.randomUUID()}.png`);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      // The renderer may have exited just before cancellation.
    }
  };
  try {
    signal?.throwIfAborted();
    child = Bun.spawn(
      [
        blender,
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--threads",
        "4",
        "--python-exit-code",
        "2",
        "--python",
        rendererScript,
        "--",
        "--input",
        source,
        "--output",
        output,
        "--width",
        String(dimensions.width),
        "--height",
        String(dimensions.height),
        "--azimuth",
        String(camera.azimuth),
        "--elevation",
        String(camera.elevation),
        "--zoom",
        String(camera.zoom),
        "--camera",
        camera.source,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    );
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) {
      stop();
    }
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, renderTimeoutMs);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    signal?.throwIfAborted();
    if (timedOut) {
      throw new Error(
        "3D preview timed out. This scene is too expensive to render as a quick preview."
      );
    }
    if (code !== 0 || !completePng(output)) {
      const detail = /WORKBENCH_MODEL_ERROR: ([^\r\n]+)/.exec(
        `${stdout}\n${stderr}`
      )?.[1];
      throw new Error(
        detail ??
          `Could not render 3D preview. ${stderr.trim().slice(-600) || "Check that Blender can open this file."}`
      );
    }
    renameSync(output, imagePath);
    return { imagePath };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    rmSync(output, { force: true });
  }
}

function completePng(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  const bytes = readFileSync(path);
  return (
    bytes.length > 32 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(-8, -4).toString("ascii") === "IEND"
  );
}

function waitForRender(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 150);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
