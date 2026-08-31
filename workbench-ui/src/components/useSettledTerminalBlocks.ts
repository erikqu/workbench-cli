import { useEffect, useState, useSyncExternalStore } from "react";
import type { TerminalPanel } from "../terminal/terminal-panel";

// Keep rich terminal overlays aligned with a stationary viewport. A wheel
// gesture clears the old placements immediately; repeated gestures extend the
// timer, while unrelated PTY redraws do not.
interface PositionedTerminalBlock {
  endRow: number;
  startRow: number;
}

const EMPTY_SETTLED_TERMINAL_BLOCKS: readonly never[] = Object.freeze([]);

export const INLINE_MEDIA_LOOKBEHIND_VIEWPORTS = 3;
export const INLINE_MEDIA_TOP_OFFSET = 2;
export const INLINE_MEDIA_HORIZONTAL_INSET = 1;

export function inlineMediaViewportWidth(viewportCols: number): number {
  const bounded = Number.isFinite(viewportCols)
    ? Math.max(1, Math.floor(viewportCols))
    : 1;
  return Math.max(1, bounded - INLINE_MEDIA_HORIZONTAL_INSET * 2);
}

export function inlineBlockViewportPlacement(
  block: PositionedTerminalBlock,
  viewportRows: number
): { height: number; top: number } | null {
  const boundedViewportRows = Number.isFinite(viewportRows)
    ? Math.max(0, Math.floor(viewportRows))
    : 0;
  if (boundedViewportRows === 0) {
    return null;
  }
  const sourceTop = block.startRow + INLINE_MEDIA_TOP_OFFSET;
  const sourceBottom = block.endRow + 1 + INLINE_MEDIA_TOP_OFFSET;
  const viewportTop = INLINE_MEDIA_TOP_OFFSET;
  const viewportBottom = boundedViewportRows + INLINE_MEDIA_TOP_OFFSET;
  const fallbackHeight = Math.min(
    boundedViewportRows,
    Math.max(1, block.endRow - block.startRow + 1)
  );
  if (sourceBottom <= viewportTop) {
    return { top: viewportTop, height: fallbackHeight };
  }
  if (sourceTop >= viewportBottom) {
    return {
      top: viewportBottom - fallbackHeight,
      height: fallbackHeight,
    };
  }
  const top = Math.max(sourceTop, viewportTop);
  const bottom = Math.min(sourceBottom, viewportBottom);
  return bottom > top ? { top, height: bottom - top } : null;
}

export function terminalBlocksForOverlay<T extends PositionedTerminalBlock>(
  blocks: readonly T[],
  viewportRows: number
): T[] {
  const visible = blocks.filter(
    (block) => block.endRow >= 0 && block.startRow < viewportRows
  );
  if (visible.length > 0) {
    return visible;
  }
  const nearestAbove = blocks
    .filter((block) => block.endRow < 0)
    .sort((left, right) => right.endRow - left.endRow)[0];
  if (nearestAbove) {
    return [nearestAbove];
  }
  const nearestBelow = blocks
    .filter((block) => block.startRow >= viewportRows)
    .sort((left, right) => left.startRow - right.startRow)[0];
  return nearestBelow ? [nearestBelow] : [];
}

export function terminalBlocksNearViewport<T extends PositionedTerminalBlock>(
  blocks: readonly T[],
  viewportStart: number,
  viewportRows: number
): T[] {
  const lookbehindStart = Math.max(
    0,
    viewportStart - viewportRows * INLINE_MEDIA_LOOKBEHIND_VIEWPORTS
  );
  const viewportEnd = viewportStart + viewportRows - 1;
  return blocks
    .filter(
      (block) =>
        block.endRow >= lookbehindStart && block.startRow <= viewportEnd
    )
    .map((block) => ({
      ...block,
      endRow: block.endRow - viewportStart,
      startRow: block.startRow - viewportStart,
    }));
}

export function visibleSettledTerminalBlocks<T>(
  owner: TerminalPanel | null,
  panel: TerminalPanel,
  renderDelay: number,
  blocks: readonly T[]
): readonly T[] {
  // Native terminal graphics live outside the normal cell buffer. Never give
  // React even one stale frame in which it can retain an old placement while
  // the viewport is moving or the user has switched to another PTY.
  return owner === panel && renderDelay <= 0
    ? blocks
    : EMPTY_SETTLED_TERMINAL_BLOCKS;
}

export function useSettledTerminalBlocks<T extends PositionedTerminalBlock>(
  panel: TerminalPanel,
  extract: (lines: readonly string[]) => T[],
  signature: (blocks: readonly T[]) => string
): T[] {
  const revision = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot
  );
  const [settled, setSettled] = useState<{
    blocks: T[];
    owner: TerminalPanel | null;
  }>({ blocks: [], owner: null });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scanWhenSettled = async () => {
      if (cancelled) {
        return;
      }
      const delay = panel.viewportRenderDelay();
      if (delay > 0) {
        timer = setTimeout(scanWhenSettled, delay);
        timer.unref?.();
        return;
      }
      const snapshot = await panel.captureInlineMediaText();
      const next = terminalBlocksNearViewport(
        extract(snapshot.lines),
        snapshot.viewportStart,
        snapshot.viewportRows
      );
      if (cancelled) {
        return;
      }
      setSettled((current) =>
        current.owner === panel && signature(current.blocks) === signature(next)
          ? current
          : { blocks: next, owner: panel }
      );
    };

    const delay = panel.viewportRenderDelay();
    if (delay > 0) {
      setSettled((current) =>
        current.owner === panel && current.blocks.length === 0
          ? current
          : { blocks: [], owner: panel }
      );
      timer = setTimeout(scanWhenSettled, delay);
      timer.unref?.();
    } else {
      scanWhenSettled();
    }

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [revision, panel, extract, signature]);

  return visibleSettledTerminalBlocks(
    settled.owner,
    panel,
    panel.viewportRenderDelay(),
    settled.blocks
  ) as T[];
}
