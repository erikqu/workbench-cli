import { wrapForMultiplexer } from "../media/image-protocol";

// Query the terminal for its cell pixel geometry and return the cell aspect
// ratio (width / height). Used to size Kitty images so they don't look
// stretched — the displayed cols x rows grid must match the image aspect using
// the *real* cell dimensions, which are font/terminal dependent.
//
// Strategy (responses parsed in any order, first usable wins):
//   - CSI 16 t  -> `CSI 6 ; <cellHeightPx> ; <cellWidthPx> t`  (direct, best)
//   - CSI 14 t  -> `CSI 4 ; <areaHeightPx> ; <areaWidthPx> t`  (text area px)
//     combined with CSI 18 t -> `CSI 8 ; <rows> ; <cols> t`    (size in cells)
//
// Inside tmux the pixel queries are also sent wrapped in passthrough so they
// reach the host terminal (Ghostty/Kitty), whose response routes back to us.
// Returns null on non-TTY, timeout, or if the terminal doesn't answer.
export async function detectCellAspect(
  timeoutMs = 180
): Promise<number | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (
    !(stdout.isTTY && stdin.isTTY) ||
    typeof stdin.setRawMode !== "function"
  ) {
    return null;
  }
  // Don't fight another reader (e.g. an already-running render loop).
  if (stdin.listenerCount("data") > 0) {
    return null;
  }

  const wasRaw = stdin.isRaw;
  return await new Promise<number | null>((resolve) => {
    let buffer = "";
    let settled = false;
    let areaPx: { w: number; h: number } | undefined;
    let cells: { cols: number; rows: number } | undefined;

    const finish = (value: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try {
        if (!wasRaw) {
          stdin.setRawMode(false);
        }
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const tryDerive = () => {
      if (
        areaPx &&
        cells &&
        areaPx.w > 0 &&
        areaPx.h > 0 &&
        cells.cols > 0 &&
        cells.rows > 0
      ) {
        finish(areaPx.w / cells.cols / (areaPx.h / cells.rows));
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const cell = buffer.match(/\x1b\[6;(\d+);(\d+)t/);
      if (cell) {
        const h = Number(cell[1]);
        const w = Number(cell[2]);
        if (h > 0 && w > 0) {
          return finish(w / h);
        }
      }
      const area = buffer.match(/\x1b\[4;(\d+);(\d+)t/);
      if (area) {
        areaPx = { h: Number(area[1]), w: Number(area[2]) };
      }
      const size = buffer.match(/\x1b\[8;(\d+);(\d+)t/);
      if (size) {
        cells = { rows: Number(size[1]), cols: Number(size[2]) };
      }
      tryDerive();
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      if (!wasRaw) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onData);
      const queries = "\x1b[16t\x1b[14t\x1b[18t";
      stdout.write(queries);
      // Also send pixel queries through tmux passthrough so the host terminal
      // (not tmux, which doesn't know pixel sizes) can answer.
      const wrapped = wrapForMultiplexer("\x1b[16t\x1b[14t");
      if (wrapped !== queries) {
        stdout.write(wrapped);
      }
    } catch {
      finish(null);
    }
  });
}
