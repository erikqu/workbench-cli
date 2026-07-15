import type { HarnessSpec } from "../state/harnesses";
import type {
  AgentSession,
  AppState,
  FileTreeEntry,
  MainTabId,
} from "../state/types";
import type { TerminalPanel } from "../terminal/terminal-panel";
import type { FilePatch, SessionDiff } from "../text/diff";

export interface SelectOption<T = unknown> {
  description?: string;
  name: string;
  value: T;
}

export interface TabSelectOption {
  description?: string;
  name: string;
  value: MainTabId;
}

export interface WorkbenchActions {
  addHarness(harnessId: string): void;
  cancelNewAgent(): void;
  cancelNewHarness(): void;
  closeActiveTab(): void;
  closeHarness(id: string): void;
  closePlusMenu(): void;
  closeSession(id: string): void;
  closeTab(value: MainTabId): void;
  closeTerminal(id: string): void;
  createAgent(path: string): void;
  cycleTheme(direction?: number): void;
  dismissSplash(): void;
  focus(target: AppState["focus"]): void;
  getFilePatch(path: string): Promise<FilePatch>;
  newTerminal(): void;
  openNewAgent(): void;
  openNewHarness(): void;
  resizeHarness(cols: number, rows: number): void;
  resizeSessionsSidebar(width: number): void;
  resizeTerminal(cols: number, rows: number): void;
  resizeWorkspaceSidePane(width: number): void;
  saveActiveFile(): void;
  scrollHarness(lines: number): void;
  scrollTerminal(lines: number): void;
  selectDiffFile(path: string): void;
  selectExplorer(option: SelectOption<FileTreeEntry> | null): void;
  selectMainTab(option: TabSelectOption | null): void;
  selectSession(id: string): void;
  setMarkdownView(path: string, mode: "preview" | "source"): void;
  shutdown(code: number): void;
  togglePlusMenu(): void;
  toggleSidebar(): void;
  updateFileContent(path: string, content: string): void;
  writeHarness(input: string): void;
  writeTerminal(input: string): void;
}

export interface WorkbenchViewModel {
  activeFile?: FileTreeEntry;
  cwd: string;
  // Working-tree diff for the active session, plus all sessions for sidebar badges.
  diff?: SessionDiff;
  diffs: Map<string, SessionDiff>;
  explorerOptions: SelectOption<FileTreeEntry>[];
  harnessPanel?: TerminalPanel;
  harnessSpecs: HarnessSpec[];
  mainTabOptions: TabSelectOption[];
  // The active session; its tab set drives the tab strip and main content.
  session: AgentSession;
  state: AppState;
  terminalPanel?: TerminalPanel;
}

export type MainTabValue = MainTabId;
