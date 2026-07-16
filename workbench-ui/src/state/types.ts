export interface FileTreeEntry {
  depth: number;
  expanded: boolean;
  isDirectory: boolean;
  label: string;
  mtimeMs?: number;
  name: string;
  path: string;
  relativePath: string;
  size?: number;
}

// How the editor pane should present a tab:
// - "text": editable textarea with syntax highlighting
// - "markdown": rendered (read-only) markdown
// - "image": decoded and shown as colored half-block art
// - "pdf": rasterized page preview, then shown through the image renderer
// - "video": ffmpeg-decoded frames played through the image renderer
export type EditorTabKind = "text" | "markdown" | "image" | "pdf" | "video";

export interface EditorTab {
  binary: boolean;
  content: string;
  dirty: boolean;
  kind: EditorTabKind;
  // For markdown tabs: whether to show the rendered preview or the raw source.
  // Undefined is treated as "preview" (markdown opens rendered by default).
  mdView?: "preview" | "source";
  name: string;
  path: string;
  truncated: boolean;
}

export interface TerminalTab {
  cwd: string;
  id: string;
  name: string;
  // Stable name of the backing tmux session (persists across restarts).
  tmux: string;
}

export interface HarnessTab {
  cwd: string;
  harnessId: string;
  id: string;
  name: string;
  // Stable name of the backing tmux session (persists across restarts).
  tmux: string;
}

// "harness:<harnessTabId>" | "term:<terminalId>" | "changes" | absolute file path
export type MainTabId = string;

// The synthetic per-session "Changes" review tab.
export const CHANGES_TAB = "changes";

export function isChangesTab(tab: MainTabId): boolean {
  return tab === CHANGES_TAB;
}

// Each agent session owns its complete tab set: switching sessions swaps the
// whole tab strip (terminals + file tabs) along with the chat and explorer.
export interface AgentSession {
  activeMainTab: MainTabId;
  activeTabPath?: string;
  cwd: string;
  expandedDirs: Set<string>;
  harnesses: HarnessTab[];
  id: string;
  name: string;
  openTabs: EditorTab[];
  // Which changed file's diff is shown in the Changes tab (transient, absolute path).
  selectedDiffPath?: string;
  terminals: TerminalTab[];
}

export type FocusTarget =
  | "sessions"
  | "explorer"
  | "editor"
  | "harness"
  | "terminal"
  | "newAgent"
  | "newHarness";

export interface AppState {
  activeSessionId: string;
  focus: FocusTarget;
  newAgentOpen: boolean;
  newHarnessOpen: boolean;
  plusMenuOpen: boolean;
  sessions: AgentSession[];
  sessionsSidebarWidth: number;
  sidebarVisible: boolean;
  // Startup splash overlay; shown on launch, dismissed on first interaction.
  splashVisible: boolean;
  // Active UI theme name (see theme.ts THEME_ORDER); cycled with Option+Tab.
  themeName: string;
  workspaceSidePaneWidth: number;
}

export interface PersistedSession {
  activeMainTab?: MainTabId;
  activeTabPath?: string;
  agentId?: string;
  cwd: string;
  expandedDirs?: string[];
  harnesses?: PersistedHarnessTab[];
  id?: string;
  openTabs?: string[];
  terminalCount?: number;
  terminals?: PersistedTerminalTab[];
}

export interface PersistedHarnessTab {
  cwd?: string;
  harnessId: string;
  id?: string;
  name?: string;
  tmux?: string;
}

export interface PersistedTerminalTab {
  cwd?: string;
  id?: string;
  name?: string;
  tmux?: string;
}

export interface PersistedWorkbenchState {
  activeSessionIndex?: number;
  sessions?: PersistedSession[];
  sessionsSidebarWidth?: number;
  sidebarVisible?: boolean;
  themeName?: string;
  workspaceSidePaneWidth?: number;
}

export function terminalIdFromTab(tab: MainTabId): string | undefined {
  return tab.startsWith("term:") ? tab.slice("term:".length) : undefined;
}

export function harnessIdFromTab(tab: MainTabId): string | undefined {
  return tab.startsWith("harness:") ? tab.slice("harness:".length) : undefined;
}
