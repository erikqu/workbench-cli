import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { openEditorTab } from "../text/editor";
import {
  clampPaneWidth,
  clampSessionsLogoHeight,
  DEFAULT_SESSIONS_LOGO_HEIGHT,
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
import {
  CHANGES_TAB,
  harnessIdFromTab,
  isChangesTab,
  terminalIdFromTab,
} from "./types";
import { persistedStatePath } from "./workbench-paths";

// Resolved once via workbench-paths. `work --hot` intentionally uses the real
// layout so watched restarts reattach every existing user session; explicitly
// isolated hot runs still get their checkout-specific state file.
const statePath = persistedStatePath();
const stateBackupPath = `${statePath}.bak`;

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

export function restoreSession(
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
  session.id = persisted.id ?? session.id;
  session.harnesses = persistedHarnesses.map((entry, index) => ({
    id:
      entry.id ?? (index === 0 ? session.harnesses[0].id : crypto.randomUUID()),
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
    id:
      entry.id ?? (index === 0 ? session.terminals[0].id : crypto.randomUUID()),
    // A terminal belongs to its workspace. Older persisted state may carry a
    // stale per-terminal cwd, so normalize it instead of reopening outside the
    // workspace after a relaunch or hot reload.
    cwd: session.cwd,
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
  const persistedTerminalId = persisted.activeMainTab
    ? terminalIdFromTab(persisted.activeMainTab)
    : undefined;
  const restoredTerminal = persistedTerminalId
    ? session.terminals.find((terminal) => terminal.id === persistedTerminalId)
    : undefined;
  session.activeMainTab = restoredHarness
    ? `harness:${restoredHarness.id}`
    : restoredTerminal
      ? `term:${restoredTerminal.id}`
      : isChangesTab(persisted.activeMainTab ?? "")
        ? CHANGES_TAB
        : session.openTabs.some((tab) => tab.path === persisted.activeMainTab)
          ? (persisted.activeMainTab ?? `harness:${session.harnesses[0].id}`)
          : persistedTerminalId && session.terminals[0]
            ? `term:${session.terminals[0].id}`
            : `harness:${session.harnesses[0].id}`;
  // Directory expansion is intentionally ephemeral. Every restored workspace
  // starts collapsed so old/deep trees never reopen unexpectedly.
  session.expandedDirs = new Set();
  return session;
}

export function createInitialState(cwd: string): AppState {
  if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
    return createScreenshotState(cwd);
  }

  const persisted = loadPersistedState();

  const sessions = restoreSessions(persisted.sessions ?? []);
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
    sessionsLogoHeight: clampSessionsLogoHeight(
      persisted.sessionsLogoHeight ?? DEFAULT_SESSIONS_LOGO_HEIGHT
    ),
    sessionsSidebarWidth: clampPaneWidth(
      persisted.sessionsSidebarWidth ?? DEFAULT_SESSIONS_SIDEBAR_WIDTH,
      MIN_SESSIONS_SIDEBAR_WIDTH,
      MAX_PERSISTED_PANE_WIDTH
    ),
    sidebarVisible: persisted.sidebarVisible ?? true,
    // A watched process restarts repeatedly. Re-showing the splash masks the
    // restored coding pane and consumes its first keypress after every edit.
    splashVisible:
      Bun.env.WORKBENCH_UI_SPLASH_PREVIEW === "1" ||
      Bun.env.WORKBENCH_CLI_HOT !== "1",
    themeName,
    workspaceSidePaneVisible: persisted.workspaceSidePaneVisible ?? true,
    workspaceSidePaneWidth: clampPaneWidth(
      persisted.workspaceSidePaneWidth ?? DEFAULT_WORKSPACE_SIDE_PANE_WIDTH,
      MIN_WORKSPACE_SIDE_PANE_WIDTH,
      MAX_PERSISTED_PANE_WIDTH
    ),
  };
}

export function restoreSessions(
  persisted: readonly PersistedSession[]
): AgentSession[] {
  const sessions: AgentSession[] = [];
  for (const entry of persisted) {
    // A removable drive, delayed network mount, or temporarily renamed folder
    // must not erase a Work Session. Keep the card and its tmux identity; the
    // workspace can become available again after startup.
    sessions.push(restoreSession(entry, sessions));
  }
  return sessions;
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
    join(cwd, "test-harness", "sample.gif"),
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
    sessionsLogoHeight: DEFAULT_SESSIONS_LOGO_HEIGHT,
    sessionsSidebarWidth: DEFAULT_SESSIONS_SIDEBAR_WIDTH,
    sidebarVisible: true,
    // Show the splash in screenshots only when explicitly exercising it.
    splashVisible:
      Bun.env.WORKBENCH_UI_FORCE_SPLASH === "1" ||
      Bun.env.WORKBENCH_UI_SPLASH_PREVIEW === "1",
    themeName: applyTheme(Bun.env.WORKBENCH_UI_THEME ?? DEFAULT_THEME),
    workspaceSidePaneVisible: true,
    workspaceSidePaneWidth: DEFAULT_WORKSPACE_SIDE_PANE_WIDTH,
  };
}

export function loadPersistedState(): PersistedWorkbenchState {
  return readPersistedStateFile(statePath, stateBackupPath);
}

export function savePersistedState(state: AppState) {
  // Harness runs use a synthetic state; never let them overwrite the user's.
  if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
    return;
  }
  const payload: PersistedWorkbenchState = {
    sessions: state.sessions.map((session) => ({
      id: session.id,
      harnesses: session.harnesses.map((harness) => ({
        harnessId: harness.harnessId,
        cwd: harness.cwd,
        id: harness.id,
        name: harness.name,
        tmux: harness.tmux,
      })),
      cwd: session.cwd,
      terminals: session.terminals.map((terminal) => ({
        cwd: terminal.cwd,
        id: terminal.id,
        name: terminal.name,
        tmux: terminal.tmux,
      })),
      openTabs: session.openTabs.map((tab) => tab.path),
      activeTabPath: session.activeTabPath,
      activeMainTab: session.activeMainTab,
    })),
    activeSessionIndex: state.sessions.findIndex(
      (session) => session.id === state.activeSessionId
    ),
    sessionsLogoHeight: state.sessionsLogoHeight,
    sessionsSidebarWidth: state.sessionsSidebarWidth,
    sidebarVisible: state.sidebarVisible,
    themeName: state.themeName,
    workspaceSidePaneVisible: state.workspaceSidePaneVisible,
    workspaceSidePaneWidth: state.workspaceSidePaneWidth,
  };

  writePersistedStateFile(statePath, stateBackupPath, payload);
}

export function readPersistedStateFile(
  path: string,
  backupPath = `${path}.bak`
): PersistedWorkbenchState {
  return parsePersistedState(path) ?? parsePersistedState(backupPath) ?? {};
}

export function writePersistedStateFile(
  path: string,
  backupPath: string,
  payload: PersistedWorkbenchState
) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const previous = parsePersistedState(path);
  if (
    previous &&
    sessionSetSignature(previous) !== sessionSetSignature(payload)
  ) {
    atomicWrite(backupPath, `${JSON.stringify(previous, null, 2)}\n`);
  }
  atomicWrite(path, serialized);
}

function parsePersistedState(path: string): PersistedWorkbenchState | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as PersistedWorkbenchState)
      : null;
  } catch {
    return null;
  }
}

function sessionSetSignature(state: PersistedWorkbenchState): string {
  return (state.sessions ?? [])
    .map((session) => `${session.id ?? ""}\0${session.cwd}`)
    .sort()
    .join("\0");
}

function atomicWrite(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
