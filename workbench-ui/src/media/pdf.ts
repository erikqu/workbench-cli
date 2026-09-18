import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCellPixelWidth } from "./image";

const previewDir = join(tmpdir(), "workbench-ui-pdf-previews");
// Ceiling on the rasterized page width. Sized for a HiDPI/Retina pane: a wide
// pane on a 2x display is ~2000-2600 device px, so 3072 leaves headroom without
// letting a huge monitor blow up decode/transmit cost.
const maxRasterWidth = 3072;
const minRasterWidth = 720;
// Fallback pixels-per-column when the terminal never reported its real cell
// geometry (see getCellPixelWidth). Matches the original heuristic.
const fallbackCellPxWidth = 10;
const pageCountCache = new Map<string, Promise<number | undefined>>();

export interface PdfPreview {
  imagePath: string;
  page: number;
  pageCount?: number;
}

export async function preparePdfPreview(
  path: string,
  page: number,
  maxCols: number,
  signal?: AbortSignal
): Promise<PdfPreview> {
  signal?.throwIfAborted();
  const metadata = fileMetadata(path);
  const pageCount = await pdfPageCount(path);
  signal?.throwIfAborted();
  const selectedPage = clamp(
    Math.floor(page),
    1,
    pageCount ?? Number.MAX_SAFE_INTEGER
  );
  // Target the pane's real device pixels: columns * native pixels-per-column, as
  // reported by the terminal probe. This makes the page as sharp as the monitor
  // it's shown on, instead of the old fixed 10px/column guess. Falls back to the
  // heuristic when the terminal never reported its cell geometry.
  const pixelWidth = pdfPreviewWidth(maxCols);
  const imagePath = cachePath(path, metadata, selectedPage, pixelWidth);

  if (existsSync(imagePath)) {
    return { imagePath, page: selectedPage, pageCount };
  }

  await renderPage(path, selectedPage, pixelWidth, imagePath, signal);
  return { imagePath, page: selectedPage, pageCount };
}

// Round upward so small pane drags reuse a raster without sacrificing detail.
export function pdfPreviewWidth(
  maxCols: number,
  perColumn = getCellPixelWidth() ?? fallbackCellPxWidth
): number {
  return Math.min(
    maxRasterWidth,
    Math.max(
      minRasterWidth,
      Math.ceil((Math.floor(maxCols) * perColumn) / 128) * 128
    )
  );
}

async function renderPage(
  path: string,
  page: number,
  pixelWidth: number,
  imagePath: string,
  signal?: AbortSignal
) {
  // Debounce only cold renders. Cached pages should appear immediately.
  await waitForRender(signal);
  mkdirSync(previewDir, { recursive: true });
  // Never expose a partially written (or cancelled) PNG as a cache hit.
  const outputPrefix = `${imagePath}.${crypto.randomUUID()}`;
  const temporaryPath = `${outputPrefix}.png`;
  try {
    const result = await runCommand(
      "pdftoppm",
      [
        "-png",
        "-singlefile",
        "-f",
        String(page),
        "-l",
        String(page),
        "-scale-to-x",
        String(pixelWidth),
        "-scale-to-y",
        "-1",
        path,
        outputPrefix,
      ],
      12_000,
      signal
    );
    signal?.throwIfAborted();
    if (!(result.ok && existsSync(temporaryPath))) {
      throw new Error(
        "Could not render PDF page (pdftoppm from poppler-utils is required)"
      );
    }
    renameSync(temporaryPath, imagePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
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
    }, 80);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function pdfPageCount(path: string): Promise<number | undefined> {
  const metadata = fileMetadata(path);
  const key = `${path}\0${metadata}`;
  let pending = pageCountCache.get(key);
  if (!pending) {
    pending = runCommand("pdfinfo", [path], 4000).then((result) => {
      if (!result.ok) {
        return;
      }
      const match = /^Pages:\s+(\d+)/m.exec(result.stdout);
      return match ? Number(match[1]) : undefined;
    });
    pageCountCache.set(key, pending);
  }
  return pending;
}

function cachePath(
  path: string,
  metadata: string,
  page: number,
  pixelWidth: number
) {
  const digest = createHash("sha1")
    .update(path)
    .update("\0")
    .update(metadata)
    .update("\0")
    .update(String(page))
    .update("\0")
    .update(String(pixelWidth))
    .digest("hex");
  return join(previewDir, `${digest}.png`);
}

function fileMetadata(path: string) {
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 12_000,
  signal?: AbortSignal
): Promise<{ ok: boolean; stdout: string }> {
  signal?.throwIfAborted();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { ok: false, stdout: "" };
  }

  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore races if the renderer exits as the timeout fires.
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);

  try {
    const stdoutPromise = new Response(
      child.stdout as ReadableStream<Uint8Array>
    ).text();
    const stderrPromise = new Response(
      child.stderr as ReadableStream<Uint8Array>
    ).text();
    const exitCode = await child.exited;
    const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
    return { ok: exitCode === 0, stdout };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
