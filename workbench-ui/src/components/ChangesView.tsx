import { forwardRef, useEffect, useRef, useState } from "react";
import {
  Box,
  ListView,
  type ListViewHandle,
  Text,
  useBoxRectDangerously,
  useInput,
} from "silvery";
import type { DiffFile, DiffLine, FilePatch, SessionDiff } from "../text/diff";
import { colors } from "../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

const listWidth = 38;

export function ChangesView({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const diff = view.diff;
  const focused = view.state.focus === "editor";
  const files = diff?.files ?? [];
  const selected =
    files.find((file) => file.path === view.session.selectedDiffPath) ??
    files[0];

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
    >
      <ChangesHeader diff={diff} />
      {diff?.reason ? (
        <Box
          backgroundColor={colors.editor}
          flexShrink={0}
          height={1}
          paddingX={1}
        >
          <Text color={colors.dim} wrap={false}>
            {diff.reason}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="row" flexGrow={1} minWidth={1}>
        <FileList
          actions={actions}
          files={files}
          focused={focused}
          selectedPath={selected?.path}
        />
        <DiffDetail
          file={selected}
          focused={focused}
          getFilePatch={actions.getFilePatch}
        />
      </Box>
    </Box>
  );
}

function ChangesHeader({ diff }: { diff?: SessionDiff }) {
  const baseline = diff?.isGit ? "vs HEAD" : "vs session start";
  return (
    <Box
      backgroundColor={colors.panelAlt}
      flexDirection="row"
      flexShrink={0}
      height={1}
      justifyContent="space-between"
      paddingX={1}
    >
      <Box flexDirection="row">
        <Text color={colors.accentAlt}>Changes</Text>
        {diff && diff.files.length > 0 ? (
          <>
            <Text color={colors.dim}>{`  ${diff.files.length} files  `}</Text>
            <Text color={colors.diffAddFg}>{`+${diff.totalAdded} `}</Text>
            <Text color={colors.diffDelFg}>{`-${diff.totalDeleted}`}</Text>
          </>
        ) : null}
      </Box>
      <Text color={colors.dim}>{baseline}</Text>
    </Box>
  );
}

function FileList({
  files,
  selectedPath,
  focused,
  actions,
}: {
  files: DiffFile[];
  selectedPath?: string;
  focused: boolean;
  actions: WorkbenchActions;
}) {
  return (
    <Box
      backgroundColor={colors.panel}
      borderColor={colors.border}
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      width={listWidth}
    >
      {files.length === 0 ? (
        <Text color={colors.dim}>No changes</Text>
      ) : (
        <FileListBody
          actions={actions}
          active={focused}
          files={files}
          selectedPath={selectedPath}
        />
      )}
    </Box>
  );
}

// Arrow keys move the file selection (which drives the selected diff); wheel
// scrolls the viewport. Driven imperatively rather than via ListView `nav`,
// which scrolls one row per wheel tick and only when this pane owns keyboard
// focus — the same sluggish behavior we removed from the editor/diff panes.
function FileListBody({
  files,
  selectedPath,
  active,
  actions,
}: {
  files: DiffFile[];
  selectedPath?: string;
  active: boolean;
  actions: WorkbenchActions;
}) {
  const listRef = useRef<ListViewHandle>(null);
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  const innerWidth = listWidth - 2;
  const selectedIndex = Math.max(
    0,
    files.findIndex((file) => file.path === selectedPath)
  );

  useInput((_input, key) => {
    if (!active) {
      return;
    }
    if (key.upArrow && selectedIndex > 0) {
      const next = files[selectedIndex - 1];
      actions.selectDiffFile(next.path);
      listRef.current?.scrollToItem(selectedIndex - 1);
    } else if (key.downArrow && selectedIndex < files.length - 1) {
      const next = files[selectedIndex + 1];
      actions.selectDiffFile(next.path);
      listRef.current?.scrollToItem(selectedIndex + 1);
    }
  });

  return (
    <Box
      flexGrow={1}
      minWidth={1}
      onWheel={(event) => {
        listRef.current?.scrollBy(event.deltaY > 0 ? 3 : -3);
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ListView
        active={false}
        cursorKey={selectedIndex}
        getKey={(_file, index) => index}
        height={height}
        items={files}
        ref={listRef}
        renderItem={(file) => (
          <FileRow
            actions={actions}
            active={file.path === selectedPath}
            file={file}
            width={innerWidth}
          />
        )}
      />
    </Box>
  );
}

function FileRow({
  file,
  active,
  width,
  actions,
}: {
  file: DiffFile;
  active: boolean;
  width: number;
  actions: WorkbenchActions;
}) {
  const counts = file.binary ? " bin" : `+${file.added} -${file.deleted}`;
  const glyph = `${statusGlyph(file.status)} `;
  // Leave one trailing cell unfilled so the row never exactly equals the box
  // width (silvery truncates an exact-fit wrap=false Text with an ellipsis).
  const pathBudget = Math.max(1, width - glyph.length - counts.length - 2);
  const path = shortenPath(file.relativePath, pathBudget).padEnd(
    pathBudget,
    " "
  );
  const bg = active ? colors.selectedMuted : colors.panel;

  return (
    <Box
      backgroundColor={bg}
      flexDirection="row"
      flexShrink={0}
      height={1}
      onClick={(event) => {
        actions.selectDiffFile(file.path);
        event.stopPropagation();
      }}
    >
      <Text color={statusColor(file.status)}>{glyph}</Text>
      <Text color={active ? colors.text : colors.dim} wrap={false}>
        {`${path} `}
      </Text>
      {file.binary ? (
        <Text color={colors.dim} wrap={false}>
          {counts}
        </Text>
      ) : (
        <>
          <Text color={colors.diffAddFg} wrap={false}>{`+${file.added}`}</Text>
          <Text
            color={colors.diffDelFg}
            wrap={false}
          >{` -${file.deleted}`}</Text>
        </>
      )}
    </Box>
  );
}

function DiffDetail({
  file,
  getFilePatch,
  focused,
}: {
  file?: DiffFile;
  getFilePatch(path: string): Promise<FilePatch>;
  focused: boolean;
}) {
  const listRef = useRef<ListViewHandle>(null);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [pageRows, setPageRows] = useState(20);

  useEffect(() => {
    if (!file) {
      setPatch(null);
      return;
    }
    let cancelled = false;
    setPatch(null);
    getFilePatch(file.path)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setPatch(result);
        listRef.current?.scrollToTop();
      })
      .catch(() => {
        if (!cancelled) {
          setPatch({
            path: file.path,
            binary: false,
            truncated: false,
            lines: [{ kind: "meta", text: "Could not load diff" }],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file?.path, getFilePatch]);

  const lines = patch?.lines ?? [];
  const numberWidth = Math.max(
    2,
    String(
      lines.reduce(
        (max, line) => Math.max(max, line.newNo ?? 0, line.oldNo ?? 0),
        0
      )
    ).length
  );

  useInput((_input, key) => {
    if (!focused) {
      return;
    }
    if (key.pageUp) {
      listRef.current?.scrollBy(-pageRows);
    }
    if (key.pageDown) {
      listRef.current?.scrollBy(pageRows);
    }
    if (key.home) {
      listRef.current?.scrollToTop();
    }
    if (key.end) {
      listRef.current?.scrollToBottom();
    }
  });

  return (
    <Box
      backgroundColor={colors.editor}
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      paddingX={1}
    >
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Text color={colors.dim} wrap={false}>
          {file ? file.relativePath : "Select a file to view its diff"}
        </Text>
      </Box>
      {file ? (
        patch ? (
          patch.binary ? (
            <Text color={colors.dim}>Binary file ({file.status})</Text>
          ) : lines.length === 0 ? (
            <Text color={colors.dim}>No textual changes</Text>
          ) : (
            <Box
              flexGrow={1}
              minWidth={1}
              onWheel={(event) => {
                listRef.current?.scrollBy(event.deltaY > 0 ? 3 : -3);
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <DiffList
                lines={lines}
                numberWidth={numberWidth}
                onViewportRows={setPageRows}
                ref={listRef}
              />
            </Box>
          )
        ) : (
          <Text color={colors.dim}>Loading diff...</Text>
        )
      ) : null}
    </Box>
  );
}

// Patch pane: a ref-driven (non-nav) ListView so its arrow keys never collide
// with the file-list cursor; the parent drives wheel + PgUp/PgDn/Home/End.
const DiffList = forwardRef<
  ListViewHandle,
  { lines: DiffLine[]; numberWidth: number; onViewportRows(rows: number): void }
>(function DiffList({ lines, numberWidth, onViewportRows }, ref) {
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  // Minus a 1-cell slack: silvery truncates an exact-fit wrap=false Text with a
  // stray ellipsis against the enclosing border.
  const width = Math.max(1, Math.floor(rect.width) - 1);

  useEffect(() => {
    onViewportRows(height);
  }, [height, onViewportRows]);

  return (
    <ListView
      active={false}
      getKey={(_line, index) => index}
      height={height}
      items={lines}
      ref={ref}
      renderItem={(line) => (
        <DiffLineRow line={line} numberWidth={numberWidth} width={width} />
      )}
    />
  );
});

function DiffLineRow({
  line,
  numberWidth,
  width,
}: {
  line: DiffLine;
  numberWidth: number;
  width: number;
}) {
  if (line.kind === "hunk" || line.kind === "meta") {
    const color = line.kind === "hunk" ? colors.diffHunk : colors.dim;
    return (
      <Box backgroundColor={colors.editor} flexShrink={0} height={1}>
        <Text color={color} wrap={false}>
          {pad(line.text, width)}
        </Text>
      </Box>
    );
  }

  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const fg =
    line.kind === "add"
      ? colors.diffAddFg
      : line.kind === "del"
        ? colors.diffDelFg
        : colors.text;
  const bg =
    line.kind === "add"
      ? colors.diffAddBg
      : line.kind === "del"
        ? colors.diffDelBg
        : colors.editor;
  const num = line.kind === "del" ? line.oldNo : line.newNo;
  const gutter = `${String(num ?? "").padStart(numberWidth, " ")} `;

  // A single padded Text per row: avoids the flex-row rounding that makes
  // silvery truncate the trailing cell with a stray ellipsis.
  return (
    <Box backgroundColor={bg} flexShrink={0} height={1}>
      <Text color={fg} wrap={false}>
        {pad(`${gutter}${sign}${line.text}`, width)}
      </Text>
    </Box>
  );
}

function pad(text: string, width: number): string {
  if (text.length >= width) {
    return text.slice(0, Math.max(0, width));
  }
  return text.padEnd(width, " ");
}

function statusGlyph(status: DiffFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function statusColor(status: DiffFile["status"]): string {
  switch (status) {
    case "added":
      return colors.diffAddFg;
    case "deleted":
      return colors.diffDelFg;
    default:
      return colors.accentAlt;
  }
}

function shortenPath(path: string, max: number): string {
  if (path.length <= max) {
    return path;
  }
  return `..${path.slice(path.length - max + 2)}`;
}
