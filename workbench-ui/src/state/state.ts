import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { openEditorTab } from "../text/editor";
import {
  clampPaneWidth,
  DEFAULT_SESSIONS_SIDEBAR_WIDTH,
  DEFAULT_WORKSPACE_SIDE_PANE_WIDTH,
  MAX_PERSISTED_PANE_WIDTH,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDE_PANE_WIDTH,
} from "../ui/pane-layout";
import { applyTheme, DEFAULT_THEME } from "../ui/theme";
import { defaultHarnessId, harnessSpec } from "./harnesses";
import type {
  AgentSession,
  AppState,
  EditorTab,
  HarnessTab,
  PersistedSession,
  PersistedTerminalTab,
  PersistedWorkbenchState,
  TerminalTab,
} from "./types";
import { harnessIdFromTab, terminalIdFromTab } from "./types";

const statePath = join(
  Bun.env.HOME ?? ".",
  ".workbench",
  "workbench-ui-state.json"
);

export function createSession(
  cwd: string,
  existing: AgentSession[],
  harnessId = defaultHarnessId()
): AgentSession {
  const base = basename(cwd) || cwd;
  let name = base;
  let counter = 2;
  while (existing.some((session) => session.name === name)) {
    name = `${base} (${counter})`;
    counter += 1;
  }
  const harness = createHarness(cwd, [], harnessId);
  return {
    id: crypto.randomUUID(),
    cwd,
    name,
    harnesses: [harness],
    // Every session starts with one terminal in its workspace folder.
    terminals: [createTerminal(cwd, [])],
    openTabs: [],
    activeTabPath: undefined,
    activeMainTab: `harness:${harness.id}`,
    expandedDirs: new Set(),
  };
}

export function createHarness(
  cwd: string,
  existing: HarnessTab[],
  harnessId = defaultHarnessId()
): HarnessTab {
  const label = harnessSpec(harnessId).label;
  const pattern = new RegExp(`^${escapeRegex(label)}(?: \\((\\d+)\\))?$`);
  const used = existing
    .map((harness) => pattern.exec(harness.name))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => match[1] ?? "1")
    .map(Number);
  const next = used.length > 0 ? Math.max(...used) + 1 : 1;
  return {
    id: crypto.randomUUID(),
    harnessId,
    cwd,
    name: next === 1 ? label : `${label} (${next})`,
    tmux: makeTmuxName("h"),
  };
}

// tmux session names may not contain "." or ":"; a uuid suffix keeps them
// unique and stable across restarts once persisted.
function makeTmuxName(prefix: string): string {
  return `workbench_${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createTerminal(
  cwd: string,
  existing: TerminalTab[]
): TerminalTab {
  const used = existing
    .map((terminal) => /^Terminal (\d+)$/.exec(terminal.name)?.[1])
    .filter((value): value is string => !!value)
    .map(Number);
  const next = used.length > 0 ? Math.max(...used) + 1 : 1;
  return {
    id: crypto.randomUUID(),
    cwd,
    name: `Terminal ${next}`,
    tmux: makeTmuxName("t"),
  };
}

function isDirectory(path: string) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function restoreSession(
  persisted: PersistedSession,
  existing: AgentSession[]
): AgentSession {
  const persistedHarnesses = persisted.harnesses?.length
    ? persisted.harnesses
    : [
        {
          harnessId: persisted.agentId ?? defaultHarnessId(),
          cwd: persisted.cwd,
        },
      ];
  const session = createSession(
    persisted.cwd,
    existing,
    persistedHarnesses[0]?.harnessId ?? defaultHarnessId()
  );
  session.harnesses = persistedHarnesses.map((entry, index) => ({
    id: index === 0 ? session.harnesses[0].id : crypto.randomUUID(),
    harnessId: entry.harnessId,
    cwd: entry.cwd ?? session.cwd,
    name: entry.name ?? harnessSpec(entry.harnessId).label,
    // Reuse the persisted tmux name so we re-attach the same running session.
    tmux:
      entry.tmux ??
      (index === 0 ? session.harnesses[0].tmux : makeTmuxName("h")),
  }));

  const persistedTerminals: PersistedTerminalTab[] = persisted.terminals?.length
    ? persisted.terminals
    : Array.from(
        { length: Math.max(1, persisted.terminalCount ?? 1) },
        () => ({})
      );
  session.terminals = persistedTerminals.map((entry, index) => ({
    id: index === 0 ? session.terminals[0].id : crypto.randomUUID(),
    cwd: entry.cwd ?? session.cwd,
    name: entry.name ?? `Terminal ${index + 1}`,
    tmux:
      entry.tmux ??
      (index === 0 ? session.terminals[0].tmux : makeTmuxName("t")),
  }));

  session.openTabs = (persisted.openTabs ?? [])
    .map((path) => openEditorTab(path))
    .filter((tab): tab is EditorTab => !!tab);
  session.activeTabPath = session.openTabs.some(
    (tab) => tab.path === persisted.activeTabPath
  )
    ? persisted.activeTabPath
    : session.openTabs[0]?.path;
  const persistedHarnessId = persisted.activeMainTab
    ? harnessIdFromTab(persisted.activeMainTab)
    : undefined;
  const restoredHarness = persistedHarnessId
    ? session.harnesses.find((harness) => harness.id === persistedHarnessId)
    : undefined;
  session.activeMainTab = restoredHarness
    ? `harness:${restoredHarness.id}`
    : session.openTabs.some((tab) => tab.path === persisted.activeMainTab)
      ? (persisted.activeMainTab ?? `harness:${session.harnesses[0].id}`)
      : `harness:${session.harnesses[0].id}`;
  session.expandedDirs = new Set(persisted.expandedDirs ?? []);
  return session;
}

export function createInitialState(cwd: string): AppState {
  if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
    return createScreenshotState(cwd);
  }

  const persisted = loadPersistedState();

  const sessions: AgentSession[] = [];
  for (const entry of persisted.sessions ?? []) {
    if (isDirectory(entry.cwd)) {
      sessions.push(restoreSession(entry, sessions));
    }
  }
  if (sessions.length === 0) {
    sessions.push(createSession(cwd, []));
  }
  const activeIndex = Math.min(
    Math.max(persisted.activeSessionIndex ?? 0, 0),
    sessions.length - 1
  );
  const activeSession = sessions[activeIndex];

  // Resolve + apply the persisted theme before the first render so the very
  // first paint already uses the right palette (applyTheme normalizes unknowns).
  const themeName = applyTheme(persisted.themeName ?? DEFAULT_THEME);

  return {
    sessions,
    activeSessionId: activeSession.id,
    newAgentOpen: false,
    newHarnessOpen: false,
    plusMenuOpen: false,
    focus: focusForMainTab(activeSession.activeMainTab),
    sessionsSidebarWidth: clampPaneWidth(
      persisted.sessionsSidebarWidth ?? DEFAULT_SESSIONS_SIDEBAR_WIDTH,
      MIN_SESSIONS_SIDEBAR_WIDTH,
      MAX_PERSISTED_PANE_WIDTH
    ),
    sidebarVisible: persisted.sidebarVisible ?? true,
    splashVisible: true,
    themeName,
    workspaceSidePaneWidth: clampPaneWidth(
      persisted.workspaceSidePaneWidth ?? DEFAULT_WORKSPACE_SIDE_PANE_WIDTH,
      MIN_WORKSPACE_SIDE_PANE_WIDTH,
      MAX_PERSISTED_PANE_WIDTH
    ),
  };
}

export function focusForMainTab(tab: string): AppState["focus"] {
  if (harnessIdFromTab(tab) || tab === "chat") {
    return "harness";
  }
  if (terminalIdFromTab(tab)) {
    return "terminal";
  }
  // The Changes tab and file tabs both live in the editor focus region.
  return "editor";
}

function createScreenshotState(cwd: string): AppState {
  const samplePaths = [
    join(cwd, "test-harness", "sample.ts"),
    join(cwd, "README.md"),
    join(cwd, "test-harness", "sample.png"),
    join(cwd, "test-harness", "diagram.md"),
    join(cwd, "test-harness", "sample.pdf"),
    join(cwd, "test-harness", "sample.mp4"),
  ];
  const session = createSession(cwd, []);
  session.openTabs = samplePaths
    .map((path) => openEditorTab(path))
    .filter((tab): tab is EditorTab => !!tab);
  session.activeTabPath = session.openTabs[0]?.path;
  session.expandedDirs = new Set([join(cwd, "test-harness")]);

  return {
    sessions: [session],
    activeSessionId: session.id,
    newAgentOpen: false,
    newHarnessOpen: false,
    plusMenuOpen: false,
    focus: "harness",
    sessionsSidebarWidth: DEFAULT_SESSIONS_SIDEBAR_WIDTH,
    sidebarVisible: true,
    // Show the splash in screenshots only when explicitly exercising it.
    splashVisible: Bun.env.WORKBENCH_UI_FORCE_SPLASH === "1",
    themeName: applyTheme(Bun.env.WORKBENCH_UI_THEME ?? DEFAULT_THEME),
    workspaceSidePaneWidth: DEFAULT_WORKSPACE_SIDE_PANE_WIDTH,
  };
}

export function loadPersistedState(): PersistedWorkbenchState {
  if (!existsSync(statePath)) {
    return {};
  }
  try {
    return JSON.parse(
      readFileSync(statePath, "utf8")
    ) as PersistedWorkbenchState;
  } catch {
    return {};
  }
}

export function savePersistedState(state: AppState) {
  // Harness runs use a synthetic state; never let them overwrite the user's.
  if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
    return;
  }
  const payload: PersistedWorkbenchState = {
    sessions: state.sessions.map((session) => ({
      harnesses: session.harnesses.map((harness) => ({
        harnessId: harness.harnessId,
        cwd: harness.cwd,
        name: harness.name,
        tmux: harness.tmux,
      })),
      cwd: session.cwd,
      terminals: session.terminals.map((terminal) => ({
        cwd: terminal.cwd,
        name: terminal.name,
        tmux: terminal.tmux,
      })),
      openTabs: session.openTabs.map((tab) => tab.path),
      activeTabPath: session.activeTabPath,
      activeMainTab: session.activeMainTab,
      expandedDirs: [...session.expandedDirs],
    })),
    activeSessionIndex: state.sessions.findIndex(
      (session) => session.id === state.activeSessionId
    ),
    sessionsSidebarWidth: state.sessionsSidebarWidth,
    sidebarVisible: state.sidebarVisible,
    themeName: state.themeName,
    workspaceSidePaneWidth: state.workspaceSidePaneWidth,
  };

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
