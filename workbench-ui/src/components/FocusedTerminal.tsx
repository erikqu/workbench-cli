import { useMemo } from "react";
import {
  Box,
  graphemeWidth,
  type SilveryWheelEvent,
  Terminal,
  type TerminalCell,
  type TerminalProps,
  type TerminalReadable,
} from "silvery";

interface FocusedTerminalProps extends Omit<TerminalProps, "cursor"> {
  focused: boolean;
  // Wheel gestures are handled here on the wrapper Box, NOT via the inner
  // <Terminal onMouse> wheel events: silvery's runtime coalesces same-direction
  // wheel bursts into one event whose deltaY accumulates the step count, and
  // the Terminal component's onMouse callback only exposes the direction. This
  // Box is the single wheel owner for the pane; the raw SilveryWheelEvent
  // keeps the magnitude and the handler stops propagation so no ancestor can
  // double-send the gesture.
  onWheel?: (event: SilveryWheelEvent) => void;
}

// Workbench owns the focus semantics around the mirrored terminal. Silvery's
// generic Terminal component publishes a cursor offset but cannot know whether
// this pane, rather than an explorer/editor control, owns the app's caret. Keep
// the grid renderer cursor-free and publish one focused cursor owner around it
// so cursor position/visibility is committed in the same frame as grid rows.
export function FocusedTerminal({
  cols: colsProp,
  focused,
  onWheel,
  revision,
  rows: rowsProp,
  terminal,
  ...props
}: FocusedTerminalProps) {
  const cols = colsProp ?? terminal.cols;
  const rows = rowsProp ?? terminal.rows;
  const cursor = useMemo(
    () => (focused ? terminal.getCursor() : undefined),
    [focused, revision, terminal]
  );
  const mirrored = useMemo<TerminalReadable>(() => {
    const lines = normalizeTerminalWidths(terminal.getLines());
    if (
      focused &&
      cursor &&
      cursor.visible !== false &&
      cursor.y >= 0 &&
      cursor.y < lines.length &&
      cursor.x >= 0
    ) {
      const sourceRow = lines[cursor.y];
      const sourceCell = sourceRow?.[cursor.x];
      if (sourceRow && sourceCell) {
        const paintedLines = lines.slice();
        const paintedRow = sourceRow.slice();
        paintedRow[cursor.x] = paintCursor(sourceCell);
        paintedLines[cursor.y] = paintedRow;
        return terminalSnapshot(terminal, paintedLines);
      }
    }
    return terminalSnapshot(terminal, lines);
  }, [cursor, focused, revision, terminal]);

  return (
    <Box
      cursorOffset={
        cursor
          ? {
              col: cursor.x,
              row: cursor.y,
              // The caret is painted into the mirrored cell above. Keep a
              // focused hidden layout cursor owner so Silvery parks the host
              // cursor without adding a second caret or choosing a fallback.
              visible: false,
            }
          : undefined
      }
      flexDirection="column"
      focused={focused}
      height={rows}
      onWheel={onWheel}
      width={cols}
    >
      <Terminal
        {...props}
        cols={cols}
        cursor={false}
        revision={revision}
        rows={rows}
        terminal={mirrored}
      />
    </Box>
  );
}

const TEXT_PRESENTATION = "\uFE0E";

// xterm is the authority for the width of every PTY cell. Silvery normally
// upgrades emoji-capable symbols (for example U+26A0 WARNING SIGN) to emoji
// presentation while laying out <Text>, which turns xterm's one-cell glyph
// into two cells. A full terminal row then wraps and displaces every row below
// it. Pin only those mismatched narrow glyphs to text presentation so the
// outer layout preserves the exact grid width reported by xterm.
function normalizeTerminalWidths(
  lines: readonly (readonly TerminalCell[])[]
): readonly (readonly TerminalCell[])[] {
  let normalizedLines: TerminalCell[][] | undefined;
  for (let rowIndex = 0; rowIndex < lines.length; rowIndex += 1) {
    const row = lines[rowIndex];
    if (!row) {
      continue;
    }
    let normalizedRow: TerminalCell[] | undefined;
    for (let col = 0; col < row.length; col += 1) {
      const cell = row[col];
      if (
        !cell ||
        cell.wide ||
        cell.continuation ||
        !cell.char ||
        graphemeWidth(cell.char) <= 1
      ) {
        continue;
      }
      normalizedRow ??= row.slice();
      normalizedRow[col] = {
        ...cell,
        char: `${cell.char.replaceAll("\uFE0F", "").replaceAll(TEXT_PRESENTATION, "")}${TEXT_PRESENTATION}`,
      };
    }
    if (!normalizedRow) {
      continue;
    }
    normalizedLines ??= lines.map((source) => source.slice());
    normalizedLines[rowIndex] = normalizedRow;
  }
  return normalizedLines ?? lines;
}

function paintCursor(cell: TerminalCell): TerminalCell {
  return { ...cell, inverse: !cell.inverse };
}

function terminalSnapshot(
  terminal: TerminalReadable,
  lines: readonly (readonly TerminalCell[])[]
): TerminalReadable {
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    getCursor: () => terminal.getCursor(),
    getLines: () => lines,
  };
}
