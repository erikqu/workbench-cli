export const DEFAULT_SESSIONS_SIDEBAR_WIDTH = 26;
export const MIN_SESSIONS_SIDEBAR_WIDTH = 18;
export const COLLAPSED_SESSIONS_SIDEBAR_WIDTH = 3;

export const DEFAULT_WORKSPACE_SIDE_PANE_WIDTH = 30;
export const MIN_WORKSPACE_SIDE_PANE_WIDTH = 20;

export const MIN_MAIN_PANE_WIDTH = 40;
export const MAX_PERSISTED_PANE_WIDTH = 120;

export function clampPaneWidth(
  width: number,
  minWidth: number,
  maxWidth: number
): number {
  const finiteWidth = Number.isFinite(width) ? Math.round(width) : minWidth;
  const boundedMax = Math.max(minWidth, Math.floor(maxWidth));
  return Math.max(minWidth, Math.min(finiteWidth, boundedMax));
}

export function maxSessionsSidebarWidth(
  columns: number,
  workspaceSidePaneWidth: number
): number {
  return Math.max(
    MIN_SESSIONS_SIDEBAR_WIDTH,
    Math.floor(columns) - workspaceSidePaneWidth - MIN_MAIN_PANE_WIDTH
  );
}

export function maxWorkspaceSidePaneWidth(
  columns: number,
  sessionsSidebarWidth: number
): number {
  return Math.max(
    MIN_WORKSPACE_SIDE_PANE_WIDTH,
    Math.floor(columns) - sessionsSidebarWidth - MIN_MAIN_PANE_WIDTH
  );
}
