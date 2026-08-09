export interface SimulatedResponseRow {
  id: number;
  text: string;
}

export interface SimulatedAgentState {
  composer: string;
  controlCCount: number;
  generation: number;
  responses: SimulatedResponseRow[];
  scrollOffset: number;
  submittedPrompts: number;
  transcriptOffset: number;
  transcriptOpen: boolean;
  working: boolean;
  workingTick: number;
}

export interface SimulatedAgentFrame {
  cursor: { x: number; y: number; visible: boolean };
  lines: string[];
}

export const SIMULATED_HISTORY_ROWS = 120;

const COMPOSER_ROWS = 4;
const FIXED_ROWS = 2 + COMPOSER_ROWS;

// Rows in the inline agent's repainted bottom block: [META], status, composer.
export const INLINE_BLOCK_ROWS = FIXED_ROWS;

export function initialSimulatedAgentState(): SimulatedAgentState {
  return {
    composer: "",
    controlCCount: 0,
    generation: 0,
    responses: [],
    scrollOffset: 0,
    submittedPrompts: 0,
    transcriptOffset: 0,
    transcriptOpen: false,
    working: false,
    workingTick: 0,
  };
}

export function renderSimulatedAgentFrame(
  state: SimulatedAgentState,
  cols: number,
  rows: number
): SimulatedAgentFrame {
  const width = Math.max(1, Math.floor(cols));
  const height = Math.max(FIXED_ROWS, Math.floor(rows));
  const conversationRows = Math.max(0, height - FIXED_ROWS);
  const conversation = historyRows(width).concat(
    state.responses.map((row) =>
      fixtureRow(`[R${pad(row.id)}]`, row.text, width)
    )
  );
  const end = Math.max(
    0,
    conversation.length - Math.max(0, state.scrollOffset)
  );
  const start = Math.max(0, end - conversationRows);
  const visibleConversation = conversation.slice(start, end);
  const missing = conversationRows - visibleConversation.length;
  const paddedConversation = Array.from({ length: missing }, (_, index) =>
    fixtureRow(`[P${pad(index + 1)}]`, "reference padding", width)
  ).concat(visibleConversation);

  const mode =
    state.scrollOffset > 0 ? `scroll-${state.scrollOffset}` : "bottom";
  const meta = fixtureRow(
    "[META]",
    `generation=${state.generation} size=${width}x${height} ${mode}`,
    width
  );
  const status = state.working
    ? fixtureRow(
        "[WORK]",
        `Working (${Math.floor(state.workingTick / 5)}s) tick=${state.workingTick}`,
        width
      )
    : fixtureRow("[READY]", "Ready for input", width);

  const composer = composerRows(state.composer, width);
  const lines = [meta, ...paddedConversation, status, ...composer.lines];
  return {
    lines: lines.slice(0, height),
    cursor: {
      x: composer.cursorX,
      y: height - COMPOSER_ROWS + composer.cursorRow,
      visible: true,
    },
  };
}

// The inline agent (Claude-Code-style primary-buffer TUI) never scrolls its
// own conversation: history flows into the host/tmux scrollback and only the
// bottom block is repainted in place. The reference frame is that block; the
// conversation tail above it is validated separately via
// simulatedConversationRows().
export function renderSimulatedInlineBlock(
  state: SimulatedAgentState,
  cols: number
): SimulatedAgentFrame {
  const width = Math.max(1, Math.floor(cols));
  const meta = fixtureRow(
    "[META]",
    `generation=${state.generation} inline size=${width}`,
    width
  );
  const status = state.working
    ? fixtureRow(
        "[WORK]",
        `Working (${Math.floor(state.workingTick / 5)}s) tick=${state.workingTick}`,
        width
      )
    : fixtureRow("[READY]", "Ready for input", width);
  const composer = composerRows(state.composer, width);
  return {
    lines: [meta, status, ...composer.lines],
    cursor: {
      x: composer.cursorX,
      y: 2 + composer.cursorRow,
      visible: true,
    },
  };
}

// Full conversation (fixed history + streamed responses) as fixture rows, so
// tests can compare the rows the inline agent has emitted above its block.
export function simulatedConversationRows(
  state: SimulatedAgentState,
  cols: number
): string[] {
  const width = Math.max(1, Math.floor(cols));
  return historyRows(width).concat(
    state.responses.map((row) =>
      fixtureRow(`[R${pad(row.id)}]`, row.text, width)
    )
  );
}

function historyRows(width: number): string[] {
  return Array.from({ length: SIMULATED_HISTORY_ROWS }, (_, index) =>
    fixtureRow(
      `[H${pad(index + 1)}]`,
      index === 99
        ? "⚠ narrow warning glyph must not wrap the outer terminal"
        : `existing conversation row ${pad(index + 1)}`,
      width
    )
  );
}

function composerRows(
  value: string,
  width: number
): { cursorRow: number; cursorX: number; lines: string[] } {
  const textWidth = Math.max(1, width - 9);
  const logical = value.split("\n");
  const wrapped: string[] = [];
  for (const logicalLine of logical) {
    if (!logicalLine) {
      wrapped.push("");
      continue;
    }
    for (let start = 0; start < logicalLine.length; start += textWidth) {
      wrapped.push(logicalLine.slice(start, start + textWidth));
    }
  }
  const visible = wrapped.slice(-2);
  while (visible.length < 2) {
    visible.unshift("");
  }
  const activeIndex = visible.length - 1;
  const active = visible[activeIndex] ?? "";
  const top = fixtureRow("[CMP0]", "+-- multiline composer", width);
  const first = fixtureRow("[CMP1]", `> ${visible[0] ?? ""}`, width);
  const second = fixtureRow("[CMP2]", `  ${visible[1] ?? ""}`, width);
  const bottom = fixtureRow("[CMP3]", "+-- Enter submit | Esc clear", width);
  return {
    lines: [top, first, second, bottom],
    cursorRow: activeIndex + 1,
    cursorX: Math.min(width - 1, 9 + active.length),
  };
}

function fixtureRow(marker: string, text: string, width: number): string {
  const row = `${marker} ${text}`;
  if (!Number.isFinite(width)) {
    return row;
  }
  return row.slice(0, width).padEnd(width, " ");
}

function pad(value: number): string {
  return String(value).padStart(3, "0");
}
