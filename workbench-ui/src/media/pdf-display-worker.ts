import { prepareSilveryImage, setCellAspect } from "./image";

declare const self: Worker;

self.onmessage = async (
  event: MessageEvent<{
    path: string;
    cols: number;
    rows: number;
    aspect: number;
  }>
) => {
  try {
    const { path, cols, rows, aspect } = event.data;
    setCellAspect(aspect);
    const placement = await prepareSilveryImage(path, cols, rows);
    if (!placement) {
      throw new Error("Could not decode PDF page");
    }
    if (
      placement.protocol === "graphics" &&
      typeof placement.src === "string"
    ) {
      placement.src = Buffer.from(await Bun.file(placement.src).arrayBuffer());
    }
    self.postMessage({ placement });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
