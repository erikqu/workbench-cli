#!/usr/bin/env bun

import { renameSync, writeFileSync } from "node:fs";
import {
  initialSimulatedAgentState,
  renderSimulatedAgentFrame,
  type SimulatedAgentState,
} from "./simulated-agent-model";

const statePath = Bun.env.WORKBENCH_E2E_AGENT_STATE;
const chunkSeed = Number(Bun.env.WORKBENCH_E2E_CHUNK_SEED ?? "17");
const state = initialSimulatedAgentState();

let cols = terminalDimension("columns", "COLUMNS", 80);
let rows = terminalDimension("rows", "LINES", 24);
let inputBuffer = "";
let rendering = false;
let renderRequested = false;
let responseId = 0;
let runId = 0;
let statusTimer: ReturnType<typeof setInterval> | undefined;
let responseTimer: ReturnType<typeof setInterval> | undefined;
let finishTimer: ReturnType<typeof setTimeout> | undefined;

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l");

process.stdin.on("data", (data: string) => {
  inputBuffer += data;
  consumeInput();
});

process.on("SIGWINCH", () => {
  cols = terminalDimension("columns", "COLUMNS", cols);
  rows = terminalDimension("rows", "LINES", rows);
  state.scrollOffset = Math.min(state.scrollOffset, maxScrollOffset());
  requestRender();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(0));
}

requestRender();

function consumeInput() {
  while (inputBuffer.length > 0) {
    if (inputBuffer.startsWith("\x1b[200~")) {
      const end = inputBuffer.indexOf("\x1b[201~", 6);
      if (end === -1) {
        return;
      }
      const pasted = inputBuffer.slice(6, end).replace(/\r\n?|\n/g, "\n");
      inputBuffer = inputBuffer.slice(end + 6);
      state.composer += pasted;
      state.scrollOffset = 0;
      requestRender();
      continue;
    }

    const pageKey = /^\x1b\[(5|6)~/.exec(inputBuffer);
    if (pageKey) {
      inputBuffer = inputBuffer.slice(pageKey[0].length);
      scroll(
        pageKey[1] === "5" ? Math.max(1, rows - 8) : -Math.max(1, rows - 8)
      );
      continue;
    }

    const mouse = /^\x1b\[<(64|65);\d+;\d+[mM]/.exec(inputBuffer);
    if (mouse) {
      inputBuffer = inputBuffer.slice(mouse[0].length);
      scroll(mouse[1] === "64" ? 3 : -3);
      continue;
    }

    if (isIncompleteEscape(inputBuffer)) {
      return;
    }

    const char = inputBuffer[0] ?? "";
    inputBuffer = inputBuffer.slice(1);
    if (char === "\r" || char === "\n") {
      submitPrompt();
    } else if (char === "\x7f" || char === "\b") {
      state.composer = state.composer.slice(0, -1);
      state.scrollOffset = 0;
      requestRender();
    } else if (char === "\x1b") {
      state.composer = "";
      state.scrollOffset = 0;
      requestRender();
    } else if (char >= " ") {
      state.composer += char;
      state.scrollOffset = 0;
      requestRender();
    }
  }
}

function isIncompleteEscape(value: string): boolean {
  if (value === "\x1b") {
    return false;
  }
  const known = ["\x1b[200~", "\x1b[201~", "\x1b[5~", "\x1b[6~", "\x1b[<"];
  return known.some((sequence) => sequence.startsWith(value));
}

function scroll(delta: number) {
  state.scrollOffset = Math.max(
    0,
    Math.min(maxScrollOffset(), state.scrollOffset + delta)
  );
  requestRender();
}

function maxScrollOffset(): number {
  return Math.max(0, 120 + state.responses.length - Math.max(1, rows - 6));
}

function submitPrompt() {
  const prompt = state.composer;
  state.composer = "";
  state.scrollOffset = 0;
  state.submittedPrompts += 1;
  state.working = true;
  state.workingTick = 0;
  const thisRun = ++runId;
  const rowBase = responseId;
  clearRunTimers();
  state.responses.push({
    id: ++responseId,
    text: `accepted prompt ${state.submittedPrompts}: ${printable(prompt)}`,
  });
  requestRender();

  statusTimer = setInterval(() => {
    if (thisRun !== runId) {
      return;
    }
    state.workingTick += 1;
    requestRender();
  }, 140);
  statusTimer.unref?.();

  let streamed = 0;
  responseTimer = setInterval(() => {
    if (thisRun !== runId) {
      return;
    }
    streamed += 1;
    state.responses.push({
      id: ++responseId,
      text: `stream ${state.submittedPrompts}.${String(streamed).padStart(2, "0")} source=${rowBase + 1}`,
    });
    requestRender();
    if (streamed < 20) {
      return;
    }
    if (responseTimer) {
      clearInterval(responseTimer);
      responseTimer = undefined;
    }
    finishTimer = setTimeout(() => {
      if (thisRun !== runId) {
        return;
      }
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = undefined;
      }
      state.working = false;
      requestRender();
    }, 300);
    finishTimer.unref?.();
  }, 90);
  responseTimer.unref?.();
}

function requestRender() {
  state.generation += 1;
  renderRequested = true;
  if (!rendering) {
    void renderLoop();
  }
}

async function renderLoop() {
  rendering = true;
  while (renderRequested) {
    renderRequested = false;
    const snapshot = structuredClone(state) as SimulatedAgentState;
    const frame = renderSimulatedAgentFrame(snapshot, cols, rows);
    const body = frame.lines.join("\r\n");
    const cursorRow = Math.max(1, frame.cursor.y + 1);
    const cursorCol = Math.max(1, frame.cursor.x + 1);
    const ansi =
      "\x1b[?2026h" +
      "\x1b[?25l" +
      "\x1b[2J" +
      "\x1b[H" +
      body +
      `\x1b[${cursorRow};${cursorCol}H` +
      "\x1b[?25h" +
      "\x1b[?2026l";
    await writeChunked(ansi, chunkSeed + snapshot.generation);
    writeState(snapshot, frame.cursor);
  }
  rendering = false;
}

async function writeChunked(value: string, seed: number) {
  const forced = [2, 1, 3, 2, 4, 1, 5];
  let offset = 0;
  let index = 0;
  let random = seed >>> 0;
  while (offset < value.length) {
    random = (random * 1_664_525 + 1_013_904_223) >>> 0;
    const randomSize = 1 + (random % 23);
    const size = index < forced.length ? (forced[index] ?? 1) : randomSize;
    process.stdout.write(value.slice(offset, offset + size));
    offset += size;
    index += 1;
    if (index < 10 || index % 7 === 0) {
      await Bun.sleep(1);
    }
  }
}

function writeState(
  snapshot: SimulatedAgentState,
  cursor: { x: number; y: number; visible: boolean }
) {
  if (!statePath) {
    return;
  }
  const tempPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(
    tempPath,
    JSON.stringify({
      cols,
      cursor,
      rows,
      state: snapshot,
      term: Bun.env.TERM ?? "",
    })
  );
  renameSync(tempPath, statePath);
}

function terminalDimension(
  property: "columns" | "rows",
  envName: "COLUMNS" | "LINES",
  fallback: number
): number {
  const streamValue = process.stdout[property];
  const envValue = Number(Bun.env[envName]);
  if (typeof streamValue === "number" && streamValue > 0) {
    return streamValue;
  }
  return Number.isFinite(envValue) && envValue > 0 ? envValue : fallback;
}

function printable(value: string): string {
  return value.replaceAll("\n", "\\n").slice(0, 48) || "(empty)";
}

function clearRunTimers() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = undefined;
  }
  if (responseTimer) {
    clearInterval(responseTimer);
    responseTimer = undefined;
  }
  if (finishTimer) {
    clearTimeout(finishTimer);
    finishTimer = undefined;
  }
}

function shutdown(code: number) {
  clearRunTimers();
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l");
  process.exit(code);
}
