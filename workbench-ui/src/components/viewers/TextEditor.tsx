import { type ReactNode, useMemo, useRef } from "react";
import {
  Box,
  ListView,
  type ListViewHandle,
  Text,
  useBoxRectDangerously,
  useInput,
} from "silvery";
import type { EditorTab } from "../../state/types";
import { type HighlightToken, highlightLineTokens } from "../../text/syntax";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { tokenColor } from "./shared";

export function ReadOnlyViewer({
  tab,
  rel,
  content,
  view,
  actions,
}: {
  tab: EditorTab;
  rel: string;
  content: string;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const focused = view.state.focus === "editor";
  const lines = useMemo(() => content.split("\n"), [content]);

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minHeight={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      padding={1}
    >
      <Text color={colors.dim}>{rel}</Text>
      {tab.binary || tab.truncated ? (
        <Text color={colors.accentAlt}>
          {tab.binary
            ? "(binary file)"
            : "Large file preview is truncated and read-only."}
        </Text>
      ) : null}
      <Box flexGrow={1} minHeight={1} minWidth={1}>
        <LineList
          focused={focused}
          lines={lines}
          renderLine={(line) => (
            <Text color={colors.text} wrap={false}>
              {line || " "}
            </Text>
          )}
        />
      </Box>
    </Box>
  );
}

export function FileEditor({
  tab,
  rel,
  view,
  actions,
}: {
  tab: EditorTab;
  rel: string;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const focused = view.state.focus === "editor";
  // Tokenize once per file (not on every render); the whole Workbench re-renders
  // frequently from background output, and re-highlighting a 64KB file each time
  // is what made viewing files slow.
  const lines = useMemo(
    () => highlightLineTokens(tab.path, tab.content),
    [tab.path, tab.content]
  );
  const lineNumberWidth = String(lines.length).length;

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minHeight={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      padding={1}
    >
      <Text
        color={tab.dirty ? colors.accentAlt : colors.dim}
      >{`${tab.dirty ? "* " : ""}${rel}`}</Text>
      <Box flexGrow={1} minHeight={1} minWidth={1}>
        <LineList
          focused={focused}
          lines={lines}
          renderLine={(tokens, index) => (
            <CodeLine
              lineNumber={index + 1}
              tokens={tokens}
              width={lineNumberWidth}
            />
          )}
        />
      </Box>
    </Box>
  );
}

// Pixel-virtualised line list. Passing an explicit `height` makes ListView
// window against the viewport (render only visible rows + overscan), so a long
// file is no slower than a short one. Scrolling is driven imperatively (wheel +
// keys) rather than via ListView `nav`: built-in nav scrolls one row per wheel
// tick and only when the pane owns keyboard focus, which felt broken. This
// mirrors the diff pane in ChangesView — a non-nav ListView with a container
// `onWheel` (3 rows/tick, works on hover) and PgUp/PgDn/Home/End/arrows.
export function LineList<T>({
  lines,
  focused,
  estimateHeight,
  renderLine,
}: {
  lines: T[];
  focused: boolean;
  estimateHeight?: number | ((index: number) => number);
  renderLine: (item: T, index: number) => ReactNode;
}) {
  const listRef = useRef<ListViewHandle>(null);
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  const pageRows = Math.max(1, height - 1);

  useInput((_input, key) => {
    if (!focused) {
      return;
    }
    if (key.upArrow) {
      listRef.current?.scrollBy(-1);
    } else if (key.downArrow) {
      listRef.current?.scrollBy(1);
    } else if (key.pageUp) {
      listRef.current?.scrollBy(-pageRows);
    } else if (key.pageDown) {
      listRef.current?.scrollBy(pageRows);
    } else if (key.home) {
      listRef.current?.scrollToTop();
    } else if (key.end) {
      listRef.current?.scrollToBottom();
    }
  });

  return (
    <Box
      flexGrow={1}
      minHeight={1}
      minWidth={1}
      onWheel={(event) => {
        listRef.current?.scrollBy(event.deltaY > 0 ? 3 : -3);
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ListView
        active={false}
        estimateHeight={estimateHeight}
        getKey={(_item, index) => index}
        height={height}
        items={lines}
        ref={listRef}
        renderItem={(item, index) => renderLine(item, index)}
        scrollbarVisibility="auto"
      />
    </Box>
  );
}

export function CodeLine({
  lineNumber,
  width,
  tokens,
}: {
  lineNumber: number;
  width: number;
  tokens: HighlightToken[];
}) {
  return (
    <Box flexDirection="row" flexShrink={0} height={1} minWidth={1}>
      <Text
        color={colors.dim}
      >{`${String(lineNumber).padStart(width, " ")}  `}</Text>
      {tokens.map((token, index) => (
        <Text color={tokenColor(token.group)} key={index} wrap={false}>
          {token.text}
        </Text>
      ))}
    </Box>
  );
}
