import { useEffect, useState } from "react";
import { Box } from "silvery";
import {
  extractMermaidBlocks,
  type MermaidBlock,
  renderMermaidToPng,
} from "../media/mermaid";
import type { TerminalPanel } from "../terminal/terminal-panel";
import { colors } from "../ui/theme";
import {
  INLINE_MEDIA_HORIZONTAL_INSET,
  inlineBlockViewportPlacement,
  inlineMediaViewportWidth,
  terminalBlocksForOverlay,
  useSettledTerminalBlocks,
} from "./useSettledTerminalBlocks";
import { MeasuredImageContent } from "./viewers/ImageViewer";

function mermaidBlockSignature(blocks: readonly MermaidBlock[]): string {
  return blocks
    .map((block) => `${block.startRow}:${block.endRow}:${block.source}`)
    .join("\u0000");
}

// Mermaid diagrams use the same non-interactive row replacement as equations:
// the PTY retains its original dimensions and all input goes to the harness.
export function MermaidInlineOverlay({
  panel,
  mode,
  onLoadingChange,
}: {
  panel: TerminalPanel;
  mode: "dark" | "light";
  onLoadingChange(loading: boolean): void;
}) {
  const stableBlocks = useSettledTerminalBlocks(
    panel,
    extractMermaidBlocks,
    mermaidBlockSignature
  );
  const [paths, setPaths] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    if (stableBlocks.length === 0) {
      setPaths(new Map());
      onLoadingChange(false);
      return;
    }
    onLoadingChange(true);
    Promise.all(
      stableBlocks.map(async (block) => ({
        key: blockKey(block),
        path: await renderMermaidToPng(block.source, mode),
      }))
    )
      .then((results) => {
        if (cancelled) {
          return;
        }
        setPaths(
          new Map(
            results.flatMap(({ key, path }) => (path ? [[key, path]] : []))
          )
        );
      })
      .catch(() => {
        if (!cancelled) {
          setPaths(new Map());
        }
      })
      .finally(() => {
        if (!cancelled) {
          onLoadingChange(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [stableBlocks, mode, onLoadingChange]);

  return (
    <>
      {terminalBlocksForOverlay(stableBlocks, panel.rows).map((block) => {
        const path = paths.get(blockKey(block));
        return path ? (
          <InlineDiagram
            block={block}
            key={`${block.startRow}:${block.endRow}:${block.source}`}
            path={path}
            viewportRows={panel.rows}
            width={inlineMediaViewportWidth(panel.cols)}
          />
        ) : null;
      })}
    </>
  );
}

function blockKey(block: MermaidBlock): string {
  return block.source;
}

function InlineDiagram({
  block,
  path,
  viewportRows,
  width,
}: {
  block: MermaidBlock;
  path: string;
  viewportRows: number;
  width: number;
}) {
  const placement = inlineBlockViewportPlacement(block, viewportRows);
  if (!placement) {
    return null;
  }
  return (
    <Box
      backgroundColor={colors.termBg}
      height={placement.height}
      left={INLINE_MEDIA_HORIZONTAL_INSET}
      overflow="hidden"
      pointerEvents="none"
      position="absolute"
      top={placement.top}
      userSelect="none"
      width={width}
    >
      <MeasuredImageContent path={path} zIndex={22} />
    </Box>
  );
}
