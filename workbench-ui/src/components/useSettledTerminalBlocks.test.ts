import { describe, expect, test } from "bun:test";
import type { TerminalPanel } from "../terminal/terminal-panel";
import {
  INLINE_MEDIA_LOOKBEHIND_VIEWPORTS,
  inlineBlockViewportPlacement,
  inlineMediaViewportWidth,
  terminalBlocksForOverlay,
  terminalBlocksNearViewport,
  visibleSettledTerminalBlocks,
} from "./useSettledTerminalBlocks";

describe("terminalBlocksNearViewport", () => {
  test("keeps a diagram taller than the viewport and translates its rows", () => {
    expect(
      terminalBlocksNearViewport(
        [{ endRow: 12, source: "flowchart TD", startRow: 2 }],
        7,
        5
      )
    ).toEqual([{ endRow: 5, source: "flowchart TD", startRow: -5 }]);
  });

  test("keeps blocks entering either viewport edge", () => {
    expect(
      terminalBlocksNearViewport(
        [
          { endRow: 10, id: "above", startRow: 8 },
          { endRow: 14, id: "inside", startRow: 12 },
          { endRow: 17, id: "below", startRow: 16 },
        ],
        10,
        6
      )
    ).toEqual([
      { endRow: 0, id: "above", startRow: -2 },
      { endRow: 4, id: "inside", startRow: 2 },
    ]);
  });

  test("prepares blocks up to three viewport heights above the screen", () => {
    const viewportRows = 10;
    const viewportStart = 50;
    expect(INLINE_MEDIA_LOOKBEHIND_VIEWPORTS).toBe(3);
    expect(
      terminalBlocksNearViewport(
        [
          { endRow: 19, id: "too-far", startRow: 18 },
          { endRow: 20, id: "three-pages-up", startRow: 19 },
          { endRow: 49, id: "just-above", startRow: 48 },
        ],
        viewportStart,
        viewportRows
      )
    ).toEqual([
      { endRow: -30, id: "three-pages-up", startRow: -31 },
      { endRow: -1, id: "just-above", startRow: -2 },
    ]);
  });
});

describe("visibleSettledTerminalBlocks", () => {
  const firstPanel = {} as TerminalPanel;
  const secondPanel = {} as TerminalPanel;
  const blocks = [{ startRow: 2, endRow: 4 }];

  test("hides native overlays immediately while the viewport is moving", () => {
    const hidden = visibleSettledTerminalBlocks(
      firstPanel,
      firstPanel,
      1,
      blocks
    );
    expect(hidden).toEqual([]);
    expect(
      visibleSettledTerminalBlocks(firstPanel, firstPanel, 1, blocks)
    ).toBe(hidden);
  });

  test("never carries an old panel's overlays into another session", () => {
    const hidden = visibleSettledTerminalBlocks(
      firstPanel,
      secondPanel,
      0,
      blocks
    );
    expect(hidden).toEqual([]);
    expect(
      visibleSettledTerminalBlocks(firstPanel, secondPanel, 0, blocks)
    ).toBe(hidden);
    expect(
      visibleSettledTerminalBlocks(firstPanel, firstPanel, 0, blocks)
    ).toBe(blocks);
  });
});

describe("inlineMediaViewportWidth", () => {
  test("reserves both pane edges from native terminal graphics", () => {
    expect(inlineMediaViewportWidth(115)).toBe(113);
    expect(inlineMediaViewportWidth(2)).toBe(1);
    expect(inlineMediaViewportWidth(0)).toBe(1);
  });
});

describe("inlineBlockViewportPlacement", () => {
  test("fits an oversized block's visible tail into the terminal viewport", () => {
    expect(
      inlineBlockViewportPlacement({ startRow: -107, endRow: 17 }, 41)
    ).toEqual({ top: 2, height: 18 });
  });

  test("preserves the source rows when the complete block is visible", () => {
    expect(
      inlineBlockViewportPlacement({ startRow: 4, endRow: 9 }, 41)
    ).toEqual({ top: 6, height: 6 });
  });

  test("clamps a block spanning both edges to the complete viewport", () => {
    expect(
      inlineBlockViewportPlacement({ startRow: -20, endRow: 80 }, 41)
    ).toEqual({ top: 2, height: 41 });
  });

  test("pins blocks above or below the screen to the nearest edge", () => {
    expect(
      inlineBlockViewportPlacement({ startRow: -20, endRow: -1 }, 41)
    ).toEqual({ top: 2, height: 20 });
    expect(
      inlineBlockViewportPlacement({ startRow: 41, endRow: 80 }, 41)
    ).toEqual({ top: 3, height: 40 });
  });

  test("rejects an unusable viewport height", () => {
    expect(
      inlineBlockViewportPlacement({ startRow: 0, endRow: 5 }, 0)
    ).toBeNull();
  });
});

describe("terminalBlocksForOverlay", () => {
  test("shows visible blocks instead of pinned offscreen blocks", () => {
    expect(
      terminalBlocksForOverlay(
        [
          { endRow: -2, id: "above", startRow: -8 },
          { endRow: 8, id: "visible", startRow: 3 },
        ],
        20
      )
    ).toEqual([{ endRow: 8, id: "visible", startRow: 3 }]);
  });

  test("pins only the nearest block when every render is above", () => {
    expect(
      terminalBlocksForOverlay(
        [
          { endRow: -20, id: "far", startRow: -30 },
          { endRow: -2, id: "near", startRow: -8 },
        ],
        20
      )
    ).toEqual([{ endRow: -2, id: "near", startRow: -8 }]);
  });
});
