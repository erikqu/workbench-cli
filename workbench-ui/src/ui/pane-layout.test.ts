import { describe, expect, test } from "bun:test";
import {
  clampPaneWidth,
  clampSessionsLogoHeight,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDE_PANE_WIDTH,
  maxSessionsSidebarWidth,
  maxWorkspaceSidePaneWidth,
  visibleSessionsLogoHeight,
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

describe("sessions logo height", () => {
  test("clamps a saved preference to the supported range", () => {
    expect(clampSessionsLogoHeight(1)).toBe(3);
    expect(clampSessionsLogoHeight(18.6)).toBe(19);
    expect(clampSessionsLogoHeight(100)).toBe(32);
  });

  test("temporarily fits the logo to a short terminal", () => {
    expect(visibleSessionsLogoHeight(24, 60)).toBe(24);
    expect(visibleSessionsLogoHeight(24, 30)).toBe(10);
    expect(visibleSessionsLogoHeight(24, 18)).toBe(1);
  });
});
