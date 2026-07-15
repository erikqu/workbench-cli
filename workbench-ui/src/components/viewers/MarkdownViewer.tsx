import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Blockquote,
  Box,
  Code,
  CodeBlock,
  Em,
  H1,
  H2,
  H3,
  HR,
  LI,
  Link,
  ListView,
  type ListViewHandle,
  Muted,
  OL,
  P,
  Strong,
  Text,
  UL,
  useBoxRectDangerously,
  useInput,
} from "silvery";
import { cacheRemoteImage } from "../../media/image";
import { mermaidAvailable, renderMermaidToPng } from "../../media/mermaid";
import type { EditorTab } from "../../state/types";
import { highlightLineTokens } from "../../text/syntax";
import { colors, themeMode } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { MeasuredImageContent } from "./ImageViewer";
import { CodeLine, LineList } from "./TextEditor";

// Fixed cell height for an embedded, rendered Mermaid diagram. Generous so
// portrait flowcharts get enough vertical room to stay legible.
const MERMAID_ROWS = 24;

// Fixed cell height for an embedded markdown image. The image pipeline fits the
// picture inside (width x IMAGE_ROWS) preserving aspect ratio.
const IMAGE_ROWS = 20;

type TableAlign = "left" | "right" | "center";
type MarkdownBlock =
  | { type: "text"; lines: string[] }
  | { type: "mermaid"; source: string }
  | { type: "image"; alt: string; src: string }
  | { type: "table"; header: string[]; aligns: TableAlign[]; rows: string[][] };

// Split markdown into renderable blocks: text runs, ```mermaid diagrams,
// standalone images, and pipe tables. Fenced code blocks are kept verbatim
// inside text runs (and rendered as CodeBlock) so table/image detection never
// fires on code contents.
function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split("\n");
  const blocks: MarkdownBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) {
      blocks.push({ type: "text", lines: text });
    }
    text = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```+\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      if (fence[1].toLowerCase() === "mermaid") {
        flush();
        const source: string[] = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
          source.push(lines[i++]);
        }
        blocks.push({ type: "mermaid", source: source.join("\n") });
        continue;
      }
      // Generic code fence: keep the whole block (incl. fences) in the text run.
      text.push(line);
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        text.push(lines[i++]);
      }
      if (i < lines.length) {
        text.push(lines[i]);
      }
      continue;
    }

    // Standalone image line: ![alt](src "optional title").
    const image =
      /^\s*!\[([^\]]*)\]\(\s*<?([^)\s">]+)>?(?:\s+"[^"]*")?\s*\)\s*$/.exec(
        line
      );
    if (image) {
      flush();
      blocks.push({ type: "image", alt: image[1], src: image[2] });
      continue;
    }

    // Pipe table: a row containing `|` immediately followed by a delimiter row.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1])
    ) {
      const table = parseTable(lines, i);
      if (table) {
        flush();
        blocks.push(table.block);
        i = table.end;
        continue;
      }
    }

    text.push(line);
  }
  flush();
  return blocks;
}

function isTableDelimiter(line: string): boolean {
  return (
    /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) &&
    line.includes("-")
  );
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|")) {
    s = s.slice(0, -1);
  }
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (s[i] === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += s[i];
  }
  cells.push(buf.trim());
  return cells;
}

function parseTable(
  lines: string[],
  start: number
): { block: Extract<MarkdownBlock, { type: "table" }>; end: number } | null {
  const header = splitTableRow(lines[start]);
  const delim = splitTableRow(lines[start + 1]);
  if (delim.length === 0) {
    return null;
  }
  const cols = header.length;
  const aligns: TableAlign[] = Array.from({ length: cols }, (_, c) => {
    const cell = delim[c] ?? "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
    rows.push(splitTableRow(lines[i]));
    i++;
  }
  const fit = (row: string[]) =>
    Array.from({ length: cols }, (_, c) => row[c] ?? "");
  return {
    block: { type: "table", header: fit(header), aligns, rows: rows.map(fit) },
    end: i - 1,
  };
}

// Render inline markdown spans (`code`, **bold**, *italic*) as themed
// typography elements. Everything stays on one logical line so the surrounding
// block keeps its single-line height model.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: inline image before link (both start with `[`/`![`).
  const pattern =
    /(!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]*\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let part = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${part++}`;
    if (token.startsWith("![")) {
      const m = /^!\[([^\]]*)\]\([^)]*\)$/.exec(token);
      nodes.push(<Muted key={key}>{`[${m?.[1] || "image"}]`}</Muted>);
    } else if (token.startsWith("[")) {
      const m = /^\[([^\]]+)\]\(\s*<?([^)\s">]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(
        token
      );
      if (m) {
        nodes.push(
          <Link href={m[2]} key={key} variant="arm-on-hover">
            {m[1]}
          </Link>
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("`")) {
      nodes.push(<Code key={key}>{token.slice(1, -1)}</Code>);
    } else if (token.startsWith("**")) {
      nodes.push(<Strong key={key}>{token.slice(2, -2)}</Strong>);
    } else {
      nodes.push(<Em key={key}>{token.slice(1, -1)}</Em>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes.length ? nodes : [text];
}

// Visible width of a markdown string once inline markers are stripped — used to
// size table columns so the rendered (styled) cells still line up.
function visibleLength(text: string): number {
  const stripped = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
  return [...stripped].length;
}

// Group a markdown text run into themed block-level typography: headings, code
// blocks, blockquotes, bullet/ordered lists, horizontal rules, and paragraphs.
function renderMarkdownLines(lines: string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = () => `${keyPrefix}-${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: collect until the closing fence.
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i++]);
      }
      if (i < lines.length) {
        i++; // consume closing fence
      }
      nodes.push(
        <CodeBlock key={nextKey()}>{code.join("\n") || " "}</CodeBlock>
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], nextKey());
      const Tag = level === 1 ? H1 : level === 2 ? H2 : H3;
      nodes.push(
        <Tag key={nextKey()} wrap="wrap">
          {content}
        </Tag>
      );
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      nodes.push(<HR key={nextKey()} />);
      i++;
      continue;
    }

    // Blockquote run.
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      nodes.push(<Blockquote key={nextKey()}>{quote.join("\n")}</Blockquote>);
      continue;
    }

    // Unordered list run.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      }
      nodes.push(
        <UL key={nextKey()}>
          {items.map((item, index) => (
            <LI key={index}>{renderInline(item, `${keyPrefix}-ul${index}`)}</LI>
          ))}
        </UL>
      );
      continue;
    }

    // Ordered list run.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      }
      nodes.push(
        <OL key={nextKey()}>
          {items.map((item, index) => (
            <LI key={index}>{renderInline(item, `${keyPrefix}-ol${index}`)}</LI>
          ))}
        </OL>
      );
      continue;
    }

    if (!line.trim()) {
      nodes.push(<Text key={nextKey()}> </Text>);
      i++;
      continue;
    }

    nodes.push(
      <P key={nextKey()} wrap="wrap">
        {renderInline(line, nextKey())}
      </P>
    );
    i++;
  }

  return nodes;
}

export function MarkdownViewer({
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
  const mode = tab.mdView ?? "preview";
  const blocks = useMemo(() => parseMarkdownBlocks(tab.content), [tab.content]);
  // Only tokenize the raw source when the Source tab is actually showing.
  const sourceLines = useMemo(
    () => (mode === "source" ? highlightLineTokens(tab.path, tab.content) : []),
    [mode, tab.path, tab.content]
  );
  const lineNumberWidth = String(Math.max(1, sourceLines.length)).length;

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      padding={1}
    >
      <Box
        alignItems="center"
        flexDirection="row"
        flexShrink={0}
        height={1}
        justifyContent="space-between"
      >
        <Text color={colors.dim}>{rel}</Text>
        <MarkdownViewTabs
          mode={mode}
          onSelect={(next) => actions.setMarkdownView(tab.path, next)}
        />
      </Box>
      <Box flexGrow={1} minWidth={1}>
        {mode === "preview" ? (
          <MarkdownList
            baseDir={dirname(tab.path)}
            blocks={blocks}
            focused={focused}
            mode={themeMode(view.state.themeName)}
          />
        ) : (
          <LineList
            focused={focused}
            lines={sourceLines}
            renderLine={(tokens, index) => (
              <CodeLine
                lineNumber={index + 1}
                tokens={tokens}
                width={lineNumberWidth}
              />
            )}
          />
        )}
      </Box>
    </Box>
  );
}

// Small segmented control under the file tab: toggle a markdown buffer between
// the rendered Preview and its raw Source. Styled to echo the main tab strip
// (active segment uses the selected background + accent label).
function MarkdownViewTabs({
  mode,
  onSelect,
}: {
  mode: "preview" | "source";
  onSelect(mode: "preview" | "source"): void;
}) {
  return (
    <Box flexDirection="row" flexShrink={0}>
      <MarkdownViewTab
        active={mode === "preview"}
        label="Preview"
        onSelect={() => onSelect("preview")}
      />
      <MarkdownViewTab
        active={mode === "source"}
        label="Source"
        onSelect={() => onSelect("source")}
      />
    </Box>
  );
}

function MarkdownViewTab({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      backgroundColor={
        active
          ? colors.selected
          : hovered
            ? colors.selectedMuted
            : colors.editor
      }
      onClick={(event) => {
        onSelect();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      paddingX={1}
    >
      <Text color={active ? colors.accent : hovered ? colors.text : colors.dim}>
        {label}
      </Text>
    </Box>
  );
}

// Markdown content is a mix of text runs and tall Mermaid image blocks, so the
// ListView uses per-index height estimates and lets pixel virtualization
// measure the real heights. Scrolling is driven imperatively (wheel + keys) via
// a ref-driven, non-nav ListView wrapped in an onWheel container — same robust
// pattern as the file editor and the diff pane.
function MarkdownList({
  blocks,
  focused,
  baseDir,
  mode,
}: {
  blocks: MarkdownBlock[];
  focused: boolean;
  baseDir: string;
  mode: "dark" | "light";
}) {
  const listRef = useRef<ListViewHandle>(null);
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  const viewportWidth = Math.max(1, Math.floor(rect.width));
  const width = Math.max(10, viewportWidth - 1);
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
      minWidth={1}
      onWheel={(event) => {
        listRef.current?.scrollBy(event.deltaY > 0 ? 3 : -3);
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ListView
        active={false}
        estimateHeight={(index) => {
          const block = blocks[index];
          if (block.type === "mermaid") {
            return MERMAID_ROWS + 1;
          }
          if (block.type === "image") {
            return IMAGE_ROWS + 2;
          }
          if (block.type === "table") {
            return block.rows.length + 3;
          }
          return Math.max(1, block.lines.length);
        }}
        getKey={(_block, index) => index}
        height={height}
        items={blocks}
        ref={listRef}
        renderItem={(block, index) =>
          block.type === "mermaid" ? (
            <MermaidBlock mode={mode} source={block.source} width={width} />
          ) : block.type === "image" ? (
            <ImageBlock
              alt={block.alt}
              baseDir={baseDir}
              src={block.src}
              width={width}
            />
          ) : block.type === "table" ? (
            <Box flexDirection="column" flexShrink={0}>
              <TableBlock block={block} keyPrefix={`tbl${index}`} />
            </Box>
          ) : (
            <Box flexDirection="column" flexShrink={0}>
              {renderMarkdownLines(block.lines, `t${index}`)}
            </Box>
          )
        }
        scrollbarVisibility="always"
        width={viewportWidth}
      />
    </Box>
  );
}

// A ```mermaid block: rendered to a PNG and shown via the image pipeline, with a
// graceful fall back to the raw source when mermaid-cli isn't installed or the
// diagram fails to parse.
function MermaidBlock({
  source,
  width,
  mode,
}: {
  source: string;
  width: number;
  mode: "dark" | "light";
}) {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setPath(null);
    renderMermaidToPng(source, mode)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result) {
          setPath(result);
          setStatus("ok");
        } else {
          setStatus("error");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, mode]);

  if (status === "ok" && path) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color={colors.dim}>mermaid</Text>
        <Box
          backgroundColor={colors.panelAlt}
          flexShrink={0}
          height={MERMAID_ROWS}
          width={width}
        >
          <MeasuredImageContent path={path} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={colors.dim}>
        {status === "loading"
          ? "mermaid (rendering diagram...)"
          : mermaidAvailable()
            ? "mermaid (could not render; showing source)"
            : "mermaid (install mermaid-cli `mmdc` to render as an image)"}
      </Text>
      {source.split("\n").map((line, index) => (
        <Text color={colors.accentAlt} key={index} wrap="wrap">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

// An embedded markdown image: ![alt](src). Resolves http(s) URLs (downloaded to
// a temp cache), absolute paths, and paths relative to the markdown file, then
// renders through the shared image pipeline. Falls back to the alt text.
function ImageBlock({
  alt,
  src,
  baseDir,
  width,
}: {
  alt: string;
  src: string;
  baseDir: string;
  width: number;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setPath(null);
    resolveMarkdownImage(src, baseDir)
      .then((resolved) => {
        if (cancelled) {
          return;
        }
        if (resolved) {
          setPath(resolved);
          setStatus("ok");
        } else {
          setStatus("error");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src, baseDir]);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={colors.dim}>{alt ? `image: ${alt}` : "image"}</Text>
      {status === "ok" && path ? (
        <Box
          backgroundColor={colors.panelAlt}
          flexShrink={0}
          height={IMAGE_ROWS}
          overflow="hidden"
          width={width}
        >
          <MeasuredImageContent path={path} />
        </Box>
      ) : (
        <Text color={colors.accentAlt} wrap="wrap">
          {status === "loading"
            ? "(loading image...)"
            : `(could not load image) ${src}`}
        </Text>
      )}
    </Box>
  );
}

async function resolveMarkdownImage(
  src: string,
  baseDir: string
): Promise<string | null> {
  if (/^https?:\/\//i.test(src)) {
    return cacheRemoteImage(src);
  }
  if (src.startsWith("data:")) {
    return null;
  }
  const path = isAbsolute(src) ? src : resolve(baseDir, src);
  return existsSync(path) ? path : null;
}

// A GitHub-style pipe table. Columns are sized to the widest visible cell so the
// (styled) header/body still align, with per-column alignment from the
// delimiter row.
function TableBlock({
  block,
  keyPrefix,
}: {
  block: Extract<MarkdownBlock, { type: "table" }>;
  keyPrefix: string;
}) {
  const cols = block.header.length;
  const gap = 2;
  const widths = Array.from({ length: cols }, (_, c) => {
    let w = visibleLength(block.header[c] ?? "");
    for (const row of block.rows) {
      w = Math.max(w, visibleLength(row[c] ?? ""));
    }
    return Math.max(1, w);
  });
  const justify = (align: TableAlign) =>
    align === "right" ? "flex-end" : align === "center" ? "center" : undefined;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" flexShrink={0}>
        {block.header.map((cell, c) => (
          <Box
            flexShrink={0}
            justifyContent={justify(block.aligns[c])}
            key={c}
            width={widths[c] + gap}
          >
            <Text color={colors.accent} wrap={false}>
              {renderInline(cell, `${keyPrefix}-h${c}`)}
            </Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        {widths.map((w, c) => (
          <Box flexShrink={0} key={c} width={w + gap}>
            <Text color={colors.border} wrap={false}>
              {"\u2500".repeat(w)}
            </Text>
          </Box>
        ))}
      </Box>
      {block.rows.map((row, r) => (
        <Box flexDirection="row" flexShrink={0} key={r}>
          {widths.map((w, c) => (
            <Box
              flexShrink={0}
              justifyContent={justify(block.aligns[c])}
              key={c}
              width={w + gap}
            >
              <Text color={colors.text} wrap={false}>
                {renderInline(row[c] ?? "", `${keyPrefix}-r${r}c${c}`)}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
