import { useEffect, useState } from "react";
import { Box } from "silvery";
import {
  type DisplayMathBlock,
  extractDisplayMathBlocks,
  renderLatexToPng,
} from "../media/latex";
import type { TerminalPanel } from "../terminal/terminal-panel";
import { colors } from "../ui/theme";
import { useSettledTerminalBlocks } from "./useSettledTerminalBlocks";
import { MeasuredImageContent } from "./viewers/ImageViewer";

function mathBlockSignature(blocks: readonly DisplayMathBlock[]): string {
  return blocks
    .map((block) => `${block.startRow}:${block.endRow}:${block.formula}`)
    .join("\u0000");
}

// Paint equation images over exactly the terminal rows occupied by their raw
// LaTeX. Absolute placement keeps the PTY dimensions unchanged, and disabling
// hit-testing lets selection, clicks, and wheel input continue to reach the
// real harness underneath.
export function LatexInlineOverlay({
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
    extractDisplayMathBlocks,
    mathBlockSignature
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
      `Math: rendering ${stableBlocks.length} visible equation${stableBlocks.length === 1 ? "" : "s"}...`
    );
    Promise.all(
      stableBlocks.map(async (block) => ({
        key: blockKey(block),
        path: await renderLatexToPng([block.formula], mode),
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
          ? "Math: one or more equations could not be rendered"
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
          <InlineFormula
            block={block}
            key={`${block.startRow}:${block.endRow}:${block.formula}`}
            path={path}
            width={panel.cols}
          />
        ) : null;
      })}
    </>
  );
}

function blockKey(block: DisplayMathBlock): string {
  return `${block.startRow}:${block.endRow}:${block.formula}`;
}

function InlineFormula({
  block,
  path,
  width,
}: {
  block: DisplayMathBlock;
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
      <MeasuredImageContent path={path} zIndex={21} />
    </Box>
  );
}
