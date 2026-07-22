import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  return new Proxy(stdout, {
    get(target, property, receiver) {
      if (property !== "write") {
        return Reflect.get(target, property, receiver);
      }
      return (chunk: unknown, ...args: unknown[]) => {
        const output = outputString(chunk);
        terminalTrace("outer-write", {
          bytes: Buffer.byteLength(output),
          clearScreen: count(output, "\x1b[2J"),
          scrollDown: countMatches(output, /\x1b\[\d*T/g),
          scrollRegion: countMatches(output, /\x1b\[\d+;\d+r/g),
          scrollUp: countMatches(output, /\x1b\[\d*S/g),
          syncClose: count(output, "\x1b[?2026l"),
          syncOpen: count(output, "\x1b[?2026h"),
        });
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
