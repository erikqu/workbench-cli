import { inMultiplexer, wrapForMultiplexer } from "../media/image-protocol";

// Result of a single startup terminal capability probe.
export interface TerminalProbe {
  // Cell width/height ratio derived from pixel-geometry replies, or null.
  aspect: number | null;
  // Terminal answered the Kitty graphics query positively.
  kitty: boolean;
  // DA1 reply advertised Sixel (attribute "4").
  sixel: boolean;
}

// Actively query the terminal for everything we need before the renderer grabs
// stdin: cell pixel geometry (for image aspect) and graphics-protocol support.
//
// Env-var sniffing (TERM/TERM_PROGRAM) misses many capable setups — Kitty/Ghostty
// over SSH, custom TERM values, terminals reached through tmux — so we do what
// `kitty +kitten icat` and `timg` do: ask the terminal directly and read the
// answer. The DA1 (`CSI c`) reply is the fence: every VT terminal answers it, in
// order, so once we see it the earlier replies (or their absence) are final.
//
// Returns null on a non-TTY, when another reader already owns stdin, or on error.
export async function probeTerminal(
  timeoutMs = 220
): Promise<TerminalProbe | null> {
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
  return await new Promise<TerminalProbe | null>((resolve) => {
    let buffer = "";
    let settled = false;
    let kitty = false;
    let aspect: number | null = null;
    let areaPx: { w: number; h: number } | undefined;
    let cells: { cols: number; rows: number } | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const sixelFromBuffer = (): boolean => {
      const m = buffer.match(/\x1b\[\?([0-9;]+)c/);
      return m ? m[1].split(";").includes("4") : false;
    };

    const finish = (value: TerminalProbe | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (grace) {
        clearTimeout(grace);
      }
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

    const deriveAspect = () => {
      if (aspect !== null) {
        return;
      }
      if (
        areaPx &&
        cells &&
        areaPx.w > 0 &&
        areaPx.h > 0 &&
        cells.cols > 0 &&
        cells.rows > 0
      ) {
        aspect = areaPx.w / cells.cols / (areaPx.h / cells.rows);
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");

      // Cell pixel geometry (CSI 16 t -> CSI 6 ; h ; w t is the direct answer).
      const cell = buffer.match(/\x1b\[6;(\d+);(\d+)t/);
      if (cell && aspect === null) {
        const h = Number(cell[1]);
        const w = Number(cell[2]);
        if (h > 0 && w > 0) {
          aspect = w / h;
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
      deriveAspect();

      // Kitty graphics: a supporting terminal echoes `_Gi=31;OK`.
      if (/\x1b_Gi=31;OK/.test(buffer)) {
        kitty = true;
      }

      // DA1 reply is the fence. Inside a multiplexer the Kitty reply (sent via
      // passthrough to the host) can lag tmux's own DA1, so wait a short grace.
      if (/\x1b\[\?[0-9;]+c/.test(buffer)) {
        const sixel = sixelFromBuffer();
        if (kitty || !inMultiplexer()) {
          return finish({ aspect, kitty, sixel });
        }
        if (!grace) {
          grace = setTimeout(
            () => finish({ aspect, kitty, sixel: sixelFromBuffer() }),
            90
          );
        }
      }
    };

    const timer = setTimeout(
      () => finish({ aspect, kitty, sixel: sixelFromBuffer() }),
      timeoutMs
    );

    try {
      if (!wasRaw) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onData);

      // Pixel-geometry queries (direct + tmux-passthrough so the host answers).
      const geometry = "\x1b[16t\x1b[14t\x1b[18t";
      stdout.write(geometry);
      const wrappedGeometry = wrapForMultiplexer("\x1b[16t\x1b[14t");
      if (wrappedGeometry !== "\x1b[16t\x1b[14t") {
        stdout.write(wrappedGeometry);
      }

      // Kitty graphics support query (1x1 RGB pixel, action=query). Unknown APC
      // is silently ignored by terminals without Kitty graphics.
      const kittyQuery = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
      stdout.write(wrapForMultiplexer(kittyQuery));

      // DA1 fence (also reports Sixel via attribute "4").
      stdout.write("\x1b[c");
    } catch {
      finish(null);
    }
  });
}
