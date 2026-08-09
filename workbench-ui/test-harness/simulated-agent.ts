#!/usr/bin/env bun

import { renameSync, writeFileSync } from "node:fs";
import {
  initialSimulatedAgentState,
  renderSimulatedAgentFrame,
  renderSimulatedInlineBlock,
  type SimulatedAgentState,
  simulatedConversationRows,
} from "./simulated-agent-model";

const statePath = Bun.env.WORKBENCH_E2E_AGENT_STATE;
const chunkSeed = Number(Bun.env.WORKBENCH_E2E_CHUNK_SEED ?? "17");
// Inline mode mimics Claude-Code-style agents: primary buffer (no alternate
// screen), no mouse tracking, conversation flowing into the host scrollback,
// and an Ink-style bottom block erased and repainted in place. Scrolling a
// pane like this is owned by tmux copy-mode, not by the agent.
const inline = Bun.env.WORKBENCH_E2E_AGENT_INLINE === "1";
const codexLike = Bun.env.WORKBENCH_E2E_AGENT_CODEX === "1";
const stickyCodexTranscript =
  Bun.env.WORKBENCH_E2E_CODEX_STICKY_TRANSCRIPT === "1";
// The Ghostty-WASM verifier replays every incremental frame against a fresh
// terminal and is intentionally expensive. Slow fixture feedback enough that
// verification can settle each generation instead of measuring queue lag.
const timingScale = Bun.env.SILVERY_STRICT_TERMINAL ? 6 : 1;
const streamedResponseRows = Bun.env.SILVERY_STRICT_TERMINAL ? 5 : 20;
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

let printedConversationRows = 0;
let blockCursorRow = 0;
let blockPainted = false;
let transcriptPainted = false;

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write(
  inline
    ? "\x1b[?2004h\x1b[?25l"
    : "\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l"
);

process.stdin.on("data", (data: string) => {
  inputBuffer += data;
  consumeInput();
});

process.on("SIGWINCH", () => {
  cols = terminalDimension("columns", "COLUMNS", cols);
  rows = terminalDimension("rows", "LINES", rows);
  state.scrollOffset = Math.min(state.scrollOffset, maxScrollOffset());
  if (inline) {
    // Old-width rows above the block would rewrap unpredictably. Start the
    // inline transcript over so the fixture stays byte-deterministic.
    printedConversationRows = 0;
    blockPainted = false;
  }
  requestRender();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(0));
}

requestRender();

function consumeInput() {
  while (inputBuffer.length > 0) {
    if (codexLike && inputBuffer.startsWith("\x14")) {
      inputBuffer = inputBuffer.slice(1);
      state.transcriptOpen = !state.transcriptOpen;
      state.transcriptOffset = 0;
      requestRender();
      continue;
    }

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

    // The outer terminal answers mode probes issued by Workbench. A real TUI
    // consumes these protocol replies; keep the deterministic fixture from
    // mistaking a deliberately split DECRPM response for composer text.
    const modeReply = /^\x1b\[\?[0-9;]*\$y/.exec(inputBuffer);
    if (modeReply) {
      inputBuffer = inputBuffer.slice(modeReply[0].length);
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

    const transcriptArrow = /^\x1b\[([AB])/.exec(inputBuffer);
    if (codexLike && state.transcriptOpen && transcriptArrow) {
      inputBuffer = inputBuffer.slice(transcriptArrow[0].length);
      if (transcriptArrow[1] === "A") {
        state.transcriptOffset += 1;
      } else {
        // Resumed Codex transcripts can settle short of their rendered 100%
        // edge even after receiving more down navigation than up navigation.
        // Model that timing-dependent state deterministically: Workbench must
        // honor net wheel intent instead of requiring an exact 100% frame.
        const floor = stickyCodexTranscript
          ? Math.max(1, Math.floor(maxTranscriptOffset() * 0.17))
          : 0;
        state.transcriptOffset = Math.max(
          state.transcriptOffset > floor ? floor : state.transcriptOffset,
          state.transcriptOffset - 1
        );
      }
      requestRender();
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
    } else if (char === "\x03") {
      state.controlCCount += 1;
      requestRender();
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

function maxTranscriptOffset() {
  return Math.max(
    0,
    simulatedConversationRows(state, cols).length - Math.max(1, rows - 2)
  );
}

function isIncompleteEscape(value: string): boolean {
  if (value === "\x1b") {
    return false;
  }
  if (/^\x1b\[\?[0-9;]*\$?$/.test(value)) {
    return true;
  }
  const known = [
    "\x1b[200~",
    "\x1b[201~",
    "\x1b[5~",
    "\x1b[6~",
    "\x1b[A",
    "\x1b[B",
    "\x1b[<",
  ];
  return known.some((sequence) => sequence.startsWith(value));
}

function scroll(delta: number) {
  if (inline) {
    // Inline agents own no scroll state; tmux copy-mode does the scrolling.
    requestRender();
    return;
  }
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
  }, 140 * timingScale);
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
    if (streamed < streamedResponseRows) {
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
    }, 300 * timingScale);
    finishTimer.unref?.();
  }, 90 * timingScale);
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
    if (inline) {
      await renderInlineFrame(snapshot);
      continue;
    }
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

// Ink-style repaint: return to the block's first row, erase to the end of the
// screen, append any newly completed conversation rows (pushing older rows
// into the pane's natural scrollback), then repaint the block and park the
// cursor inside the composer. Nothing above the block is ever rewritten.
async function renderInlineFrame(snapshot: SimulatedAgentState) {
  const conversation = simulatedConversationRows(snapshot, cols);
  const fresh = conversation.slice(printedConversationRows);
  const block = renderSimulatedInlineBlock(snapshot, cols);
  if (codexLike && snapshot.transcriptOpen) {
    const contentRows = Math.max(1, rows - 2);
    const maxOffset = Math.max(0, conversation.length - contentRows);
    const offset = Math.min(snapshot.transcriptOffset, maxOffset);
    const end = conversation.length - offset;
    const visible = conversation.slice(Math.max(0, end - contentRows), end);
    const percent =
      maxOffset === 0
        ? 100
        : Math.round(((maxOffset - offset) / maxOffset) * 100);
    const ansi =
      "\x1b[?2026h\x1b[?25l" +
      (transcriptPainted ? "" : "\x1b[?1049h") +
      "\x1b[2J\x1b[HT R A N S C R I P T\r\n" +
      visible.join("\r\n") +
      `\r\n ${percent}% ` +
      "\x1b[?2026l";
    transcriptPainted = true;
    await writeChunked(ansi, chunkSeed + snapshot.generation);
    writeState(snapshot, { x: 0, y: 0, visible: false });
    return;
  }
  let conversationToPaint = fresh;
  let ansi = "\x1b[?2026h\x1b[?25l" + (transcriptPainted ? "\x1b[?1049l" : "");
  transcriptPainted = false;
  if (blockPainted) {
    if (codexLike) {
      // Codex's inline transcript keeps differential footer redraws in the
      // primary-buffer history. Keep the live viewport clean while retaining
      // those stale blocks above it so the Workbench test detects tmux
      // copy-mode exposing duplicated composers after a wheel gesture.
      const rowsBelowCursor = block.lines.length - 1 - blockCursorRow;
      if (rowsBelowCursor > 0) {
        ansi += `\x1b[${rowsBelowCursor}B`;
      }
      ansi += "\r\n".repeat(block.lines.length);
      // A full differential redraw restores one clean live viewport, but ED2
      // deliberately leaves the primary-buffer scrollback intact. Scrolling
      // through tmux would therefore reveal the stale footer copies above;
      // application-owned transcript navigation never enters that history.
      ansi += "\x1b[2J\x1b[H";
      conversationToPaint = conversation.slice(
        -Math.max(0, rows - block.lines.length)
      );
    } else {
      ansi +=
        blockCursorRow > 0 ? `\x1b[${blockCursorRow}A\r\x1b[0J` : "\r\x1b[0J";
    }
  } else {
    // First paint (or a resize restart): wipe the screen and pane history so
    // the transcript above the block is exactly the conversation rows.
    ansi += "\x1b[2J\x1b[3J\x1b[H";
  }
  for (const row of conversationToPaint) {
    ansi += `${row}\r\n`;
  }
  ansi += block.lines.join("\r\n");
  const cursorUp = block.lines.length - 1 - block.cursor.y;
  if (cursorUp > 0) {
    ansi += `\x1b[${cursorUp}A`;
  }
  ansi += "\r";
  if (block.cursor.x > 0) {
    ansi += `\x1b[${block.cursor.x}C`;
  }
  ansi += "\x1b[?25h\x1b[?2026l";
  printedConversationRows = conversation.length;
  blockCursorRow = block.cursor.y;
  blockPainted = true;
  await writeChunked(ansi, chunkSeed + snapshot.generation);
  writeState(snapshot, block.cursor);
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
      pid: process.pid,
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
  process.stdout.write(
    inline
      ? "\x1b[?2004l\x1b[?25h"
      : "\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l"
  );
  process.exit(code);
}
