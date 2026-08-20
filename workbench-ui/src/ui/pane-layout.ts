export const DEFAULT_SESSIONS_SIDEBAR_WIDTH = 26;
export const MIN_SESSIONS_SIDEBAR_WIDTH = 18;
export const COLLAPSED_SESSIONS_SIDEBAR_WIDTH = 3;
export const DEFAULT_SESSIONS_LOGO_HEIGHT = 32;
export const MIN_SESSIONS_LOGO_HEIGHT = 3;
export const MAX_SESSIONS_LOGO_HEIGHT = 32;

export const DEFAULT_WORKSPACE_SIDE_PANE_WIDTH = 30;
export const MIN_WORKSPACE_SIDE_PANE_WIDTH = 20;
export const COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH = 3;

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

export function clampSessionsLogoHeight(height: number): number {
  const finiteHeight = Number.isFinite(height)
    ? Math.round(height)
    : DEFAULT_SESSIONS_LOGO_HEIGHT;
  return Math.max(
    MIN_SESSIONS_LOGO_HEIGHT,
    Math.min(finiteHeight, MAX_SESSIONS_LOGO_HEIGHT)
  );
}

export function visibleSessionsLogoHeight(
  preferredHeight: number,
  terminalRows: number
): number {
  const available = Math.max(1, Math.floor(terminalRows) - 20);
  return Math.min(clampSessionsLogoHeight(preferredHeight), available);
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
