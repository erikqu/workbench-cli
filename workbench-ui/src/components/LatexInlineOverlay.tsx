import { useEffect, useState } from "react";
import { Box } from "silvery";
import {
  type DisplayMathBlock,
  extractDisplayMathBlocks,
  renderLatexToPng,
} from "../media/latex";
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
  onLoadingChange,
}: {
  panel: TerminalPanel;
  mode: "dark" | "light";
  onLoadingChange(loading: boolean): void;
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
      onLoadingChange(false);
      return;
    }
    onLoadingChange(true);
    Promise.all(
      stableBlocks.map(async (block) => ({
        key: blockKey(block),
        path: await renderLatexToPng([block.formula], mode),
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
          <InlineFormula
            block={block}
            key={`${block.startRow}:${block.endRow}:${block.formula}`}
            path={path}
            viewportRows={panel.rows}
            width={inlineMediaViewportWidth(panel.cols)}
          />
        ) : null;
      })}
    </>
  );
}

function blockKey(block: DisplayMathBlock): string {
  return block.formula;
}

function InlineFormula({
  block,
  path,
  viewportRows,
  width,
}: {
  block: DisplayMathBlock;
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
      <MeasuredImageContent path={path} zIndex={21} />
    </Box>
  );
}
