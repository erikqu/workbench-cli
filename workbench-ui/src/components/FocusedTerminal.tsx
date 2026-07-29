import { useMemo } from "react";
import {
  Box,
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
    const lines = terminal.getLines();
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
