import { getCellAspect, type SilveryImagePlacement } from "./image";

// Decoding/resizing PNGs is synchronous CPU work, even behind an async API.
// Isolate it so the UI can process page turns and abort speculative work.
export function preparePdfDisplay(
  path: string,
  cols: number,
  rows: number,
  signal: AbortSignal
): Promise<SilveryImagePlacement> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./pdf-display-worker.ts", import.meta.url).href
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("PDF image preparation timed out"));
    }, 15_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ placement?: SilveryImagePlacement; error?: string }>
    ) => {
      cleanup();
      const placement = event.data.placement;
      if (!placement) {
        reject(new Error(event.data.error ?? "Could not decode PDF page"));
        return;
      }
      // Structured cloning turns a Buffer into a Uint8Array.
      if (
        placement.protocol === "graphics" &&
        typeof placement.src !== "string"
      ) {
        placement.src = Buffer.from(placement.src);
      }
      resolve(placement);
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message));
    };
    worker.postMessage({ path, cols, rows, aspect: getCellAspect() });
  });
}
