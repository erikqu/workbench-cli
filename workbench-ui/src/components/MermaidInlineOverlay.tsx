import { useEffect, useState } from "react";
import { Box } from "silvery";
import {
  extractMermaidBlocks,
  type MermaidBlock,
  renderMermaidToPng,
} from "../media/mermaid";
import type { TerminalPanel } from "../terminal/terminal-panel";
import { colors } from "../ui/theme";
import { useSettledTerminalBlocks } from "./useSettledTerminalBlocks";
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
  onStatusChange,
}: {
  panel: TerminalPanel;
  mode: "dark" | "light";
  onStatusChange(status: string | null): void;
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
      onStatusChange(null);
      return;
    }
    onStatusChange(
      `Mermaid: rendering ${stableBlocks.length} visible diagram${stableBlocks.length === 1 ? "" : "s"}...`
    );
    Promise.all(
      stableBlocks.map(async (block) => ({
        key: blockKey(block),
        path: await renderMermaidToPng(block.source, mode),
      }))
    ).then((results) => {
      if (cancelled) {
        return;
      }
      setPaths(
        new Map(results.flatMap(({ key, path }) => (path ? [[key, path]] : [])))
      );
      onStatusChange(
        results.some(({ path }) => !path)
          ? "Mermaid: one or more diagrams could not be rendered"
          : null
      );
    });
    return () => {
      cancelled = true;
    };
  }, [stableBlocks, mode, onStatusChange]);

  return (
    <>
      {stableBlocks.map((block) => {
        const path = paths.get(blockKey(block));
        return path ? (
          <InlineDiagram
            block={block}
            key={`${block.startRow}:${block.endRow}:${block.source}`}
            path={path}
            width={panel.cols}
          />
        ) : null;
      })}
    </>
  );
}

function blockKey(block: MermaidBlock): string {
  return `${block.startRow}:${block.endRow}:${block.source}`;
}

function InlineDiagram({
  block,
  path,
  width,
}: {
  block: MermaidBlock;
  path: string;
  width: number;
}) {
  const height = block.endRow - block.startRow + 1;
  return (
    <Box
      backgroundColor={colors.termBg}
      height={height}
      left={0}
      overflow="hidden"
      pointerEvents="none"
      position="absolute"
      top={block.startRow + 2}
      userSelect="none"
      width={width}
    >
      <MeasuredImageContent path={path} zIndex={22} />
    </Box>
  );
}
