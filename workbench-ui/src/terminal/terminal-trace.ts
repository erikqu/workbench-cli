import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";

const requested = Bun.env.WORKBENCH_TERMINAL_TRACE;
const enabled = Boolean(
  requested && requested !== "0" && requested !== "false"
);
const tracePath = enabled
  ? requested === "1" || requested === "true"
    ? join(Bun.env.HOME ?? ".", ".workbench", "terminal-trace.ndjson")
    : resolve(requested as string)
  : undefined;
let sequence = 0;
let pending = "";
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let nextRowId = 0;
const rowIds = new Map<string, number>();
let gridLayout:
  | { cols: number; rows: number; screenX: number; screenY: number }
  | undefined;
interface PresentedPanel {
  panel: number;
  revision: number;
  rowIds: readonly number[];
}
let presentedPanel: PresentedPanel | undefined;

if (tracePath) {
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(
    tracePath,
    `${JSON.stringify({
      at: performance.now(),
      event: "trace-start",
      pid: process.pid,
      version: 1,
    })}\n`
  );
  process.once("exit", flushTerminalTrace);
}

export function terminalTraceEnabled() {
  return enabled;
}

export function terminalTrace(
  event: string,
  metadata: Record<string, unknown> = {}
) {
  if (!tracePath) {
    return;
  }
  if (event === "grid-layout") {
    const { cols, rows, screenX, screenY } = metadata;
    if (
      typeof cols === "number" &&
      typeof rows === "number" &&
      typeof screenX === "number" &&
      typeof screenY === "number"
    ) {
      gridLayout = { cols, rows, screenX, screenY };
    }
  }
  pending += `${JSON.stringify({
    at: performance.now(),
    event,
    sequence: ++sequence,
    ...metadata,
  })}\n`;
  if (!flushTimer) {
    flushTimer = setTimeout(flushTerminalTrace, 50);
    flushTimer.unref?.();
  }
}

export function terminalTraceRowId(fingerprint: string): number {
  let id = rowIds.get(fingerprint);
  if (id === undefined) {
    id = ++nextRowId;
    rowIds.set(fingerprint, id);
  }
  return id;
}

export function terminalTracePresentedPanel(
  panel: number,
  revision: number,
  rowIds: readonly number[]
) {
  if (!enabled) {
    return;
  }
  presentedPanel = { panel, revision, rowIds: [...rowIds] };
  terminalTrace("panel-presented", { panel, revision, rowIds });
}

export function flushTerminalTrace() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!(tracePath && pending)) {
    return;
  }
  const output = pending;
  pending = "";
  appendFileSync(tracePath, output);
}

export function tracedStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  if (!enabled) {
    return stdout;
  }
  const outer = new HeadlessTerminal({
    allowProposedApi: true,
    cols: Math.max(1, stdout.columns ?? 120),
    convertEol: false,
    rows: Math.max(1, stdout.rows ?? 36),
    scrollback: 0,
  });
  const snapshot = (expected?: PresentedPanel) => {
    const layout = gridLayout;
    if (!layout || layout.cols < 1 || layout.rows < 1) {
      return;
    }
    const buffer = outer.buffer.active;
    const ids: number[] = [];
    for (let row = 0; row < layout.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + layout.screenY + row);
      const fingerprint =
        line?.translateToString(
          false,
          layout.screenX,
          layout.screenX + layout.cols
        ) ?? "";
      ids.push(terminalTraceRowId(fingerprint));
    }
    terminalTrace("outer-grid", {
      cols: layout.cols,
      expectedPanel: expected?.panel,
      expectedRevision: expected?.revision,
      matchesExpected:
        expected?.rowIds.length === ids.length &&
        expected.rowIds.every((id, index) => id === ids[index]),
      mismatchRows: expected
        ? ids
            .map((id, index) => (expected.rowIds[index] === id ? -1 : index))
            .filter((index) => index >= 0)
        : [],
      rowIds: ids,
      rows: layout.rows,
      screenX: layout.screenX,
      screenY: layout.screenY,
    });
  };
  const resizeOuter = () => {
    const cols = Math.max(1, stdout.columns ?? outer.cols);
    const rows = Math.max(1, stdout.rows ?? outer.rows);
    if (cols !== outer.cols || rows !== outer.rows) {
      outer.resize(cols, rows);
    }
  };
  stdout.on("resize", resizeOuter);
  return new Proxy(stdout, {
    get(target, property, receiver) {
      if (property !== "write") {
        return Reflect.get(target, property, receiver);
      }
      return (chunk: unknown, ...args: unknown[]) => {
        const output = outputString(chunk);
        const expected = presentedPanel
          ? { ...presentedPanel, rowIds: [...presentedPanel.rowIds] }
          : undefined;
        terminalTrace("outer-write", {
          bytes: Buffer.byteLength(output),
          clearScreen: count(output, "\x1b[2J"),
          scrollDown: countMatches(output, /\x1b\[\d*T/g),
          scrollRegion: countMatches(output, /\x1b\[\d+;\d+r/g),
          scrollUp: countMatches(output, /\x1b\[\d*S/g),
          syncClose: count(output, "\x1b[?2026l"),
          syncOpen: count(output, "\x1b[?2026h"),
          expectedPanel: expected?.panel,
          expectedRevision: expected?.revision,
        });
        outer.write(output, () => snapshot(expected));
        return Reflect.apply(target.write, target, [chunk, ...args]);
      };
    },
  });
}

function outputString(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return new TextDecoder().decode(chunk);
  }
  return String(chunk ?? "");
}

function count(value: string, needle: string) {
  return value.split(needle).length - 1;
}

function countMatches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}
