import { describe, expect, test } from "bun:test";
import {
  clampPaneWidth,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDE_PANE_WIDTH,
  maxSessionsSidebarWidth,
  maxWorkspaceSidePaneWidth,
} from "./pane-layout";

describe("pane width constraints", () => {
  test("clamps and rounds drag widths", () => {
    expect(clampPaneWidth(31.6, 18, 50)).toBe(32);
    expect(clampPaneWidth(5, 18, 50)).toBe(18);
    expect(clampPaneWidth(80, 18, 50)).toBe(50);
  });

  test("reserves the main pane while resizing sessions", () => {
    expect(maxSessionsSidebarWidth(120, 30)).toBe(50);
    expect(maxSessionsSidebarWidth(60, 30)).toBe(MIN_SESSIONS_SIDEBAR_WIDTH);
  });

  test("reserves the main pane while resizing the workspace pane", () => {
    expect(maxWorkspaceSidePaneWidth(120, 26)).toBe(54);
    expect(maxWorkspaceSidePaneWidth(60, 26)).toBe(
      MIN_WORKSPACE_SIDE_PANE_WIDTH
    );
  });
});
