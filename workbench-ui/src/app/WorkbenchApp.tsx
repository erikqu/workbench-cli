import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { useEffect, useState } from "react";
import { ThemeProvider } from "silvery";
import { run } from "silvery/runtime";

type RunHandle = Awaited<ReturnType<typeof run>>;

import type {
  SelectOption,
  TabSelectOption,
  WorkbenchActions,
  WorkbenchViewModel,
} from "../components/types";
import { Workbench } from "../components/Workbench";
import { harnessSpec, harnessSpecs } from "../state/harnesses";
import {
  createHarness,
  createInitialState,
  createSession,
  createTerminal,
  focusForMainTab,
  savePersistedState,
} from "../state/state";
import type {
  AgentSession,
  AppState,
  FileTreeEntry,
  HarnessTab,
  TerminalTab,
} from "../state/types";
import {
  CHANGES_TAB,
  harnessIdFromTab,
  isChangesTab,
  terminalIdFromTab,
} from "../state/types";
import { TerminalPanel } from "../terminal/terminal-panel";
import {
  computeFilePatch,
  computeSessionDiff,
  diffSignature,
  type SessionDiff,
} from "../text/diff";
import { openEditorTab, openTab } from "../text/editor";
import {
  buildExplorerEntries,
  createExplorerIgnore,
  describeEntry,
  expandPathInput,
  isExistingDirectory,
  toggleDirectory,
} from "../text/file-tree";
import {
  COLLAPSED_SESSIONS_SIDEBAR_WIDTH,
  clampPaneWidth,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDE_PANE_WIDTH,
  maxSessionsSidebarWidth,
  maxWorkspaceSidePaneWidth,
} from "../ui/pane-layout";
import {
  applyTheme,
  nextThemeName,
  THEME_LABELS,
  themeTokens,
} from "../ui/theme";
import { emitToast } from "../ui/toast";

// Persistent harness/terminal sessions run on a private tmux server addressed by
// an explicit socket *path* under ~/.workbench (not a `-L` name in the shared
// per-user tmux tmpdir). This guarantees they never collide with, or show up in,
// the user's own tmux server.
const TMUX_SOCKET_PATH = join(
  Bun.env.HOME ?? homedir(),
  ".workbench",
  "tmux-ui.sock"
);

// Minimum gap between full-app repaints (~60fps) used by the leading-edge render
// throttle. Low enough to feel instant, high enough to coalesce bursts.
const RENDER_INTERVAL_MS = 16;
const HARNESS_COLOR_ENV = {
  CLICOLOR: "1",
  CLICOLOR_FORCE: "1",
  COLORTERM: "truecolor",
  FORCE_COLOR: "1",
};

export interface WorkbenchOptions {
  cwd: string;
}

export class ReactWorkbenchApp {
  private instance?: RunHandle;
  private state: AppState;
  private explorerEntries: FileTreeEntry[] = [];
  private explorerOptions: SelectOption<FileTreeEntry>[] = [];
  // Harness tabs and ordinary terminals are both real PTYs; the maps differ
  // only by which state collection owns their ids.
  private harnessPanels = new Map<string, TerminalPanel>();
  private shellPanels = new Map<string, TerminalPanel>();
  private explorerWatcher?: FSWatcher;
  private watchedCwd?: string;
  private explorerWorkbenchTimer?: ReturnType<typeof setTimeout>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private lastRenderAt = 0;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private lastActiveKey?: string;
  // Working-tree diffs keyed by session cwd, workbenched by a background poll.
  private diffCache = new Map<string, SessionDiff>();
  private diffSignatures = new Map<string, string>();
  private diffTimer?: ReturnType<typeof setTimeout>;
  private diffTick?: () => void;
  private diffRunning = false;
  private readonly workbenchActions: WorkbenchActions;
  private shuttingDown = false;
  private viewListener?: () => void;

  constructor(options: WorkbenchOptions) {
    this.state = createInitialState(options.cwd);
    this.workbenchActions = this.createActions();
  }

  async run() {
    // Workbench themes and media previews require color even when a parent
    // shell exports NO_COLOR. Child harnesses already apply the same override.
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    process.env.COLORTERM ??= "truecolor";

    this.rebuildExplorer();
    this.syncExplorerWatcher();
    this.startDiffPolling();

    process.once("SIGTERM", () => this.shutdown(0));
    process.once("SIGINT", () => this.shutdown(0));
    this.instance = await run(<WorkbenchRoot app={this} />, {
      stdin: process.stdin,
      stdout: process.stdout,
      cols: process.stdout.columns ?? 120,
      rows: process.stdout.rows ?? 36,
      mode: "fullscreen",
      exitOnCtrlC: false,
      mouse: true,
      // The workbench routes Tab/Shift+Tab itself (PTY tab-completion when a
      // terminal/harness is focused, otherwise cycling main tabs). Silvery's
      // default focus-cycling would otherwise swallow Tab before useInput, so
      // tab-completion never reaches the shell. `run()` (unlike `render()`)
      // exposes this knob.
      handleTabCycling: false,
    });
    await this.instance.waitUntilExit();
  }

  actions(): WorkbenchActions {
    return this.workbenchActions;
  }

  private createActions(): WorkbenchActions {
    return {
      selectExplorer: (option) => this.openExplorerOption(option),
      selectMainTab: (option) => this.selectMainTab(option),
      closeActiveTab: () => this.closeTab(this.activeSession().activeMainTab),
      closeTab: (value) => this.closeTab(value),
      updateFileContent: (path, content) =>
        this.updateFileContent(path, content),
      saveActiveFile: () => this.saveActiveFile(),
      setMarkdownView: (path, mode) => this.setMarkdownView(path, mode),
      focus: (target) => this.focus(target),
      toggleSidebar: () => {
        this.state.sidebarVisible = !this.state.sidebarVisible;
        if (!this.state.sidebarVisible && this.state.focus === "sessions") {
          this.state.focus = focusForMainTab(
            this.activeSession().activeMainTab
          );
        }
        this.persistAndRender();
      },
      cycleTheme: (direction) => this.cycleTheme(direction ?? 1),
      dismissSplash: () => {
        if (!this.state.splashVisible) {
          return;
        }
        this.state.splashVisible = false;
        this.render();
      },
      shutdown: (code) => this.shutdown(code),
      writeHarness: (input) => {
        const harness = this.activeHarness();
        if (harness) {
          this.harnessPanel(harness).write(input);
        }
      },
      writeTerminal: (input) => {
        const terminal = this.activeTerminal();
        if (terminal) {
          this.shellPanel(terminal).write(input);
        }
      },
      resizeHarness: (cols, rows) => {
        const harness = this.activeHarness();
        if (!harness) {
          return;
        }
        const panel = this.harnessPanel(harness);
        panel.resize(cols, rows);
      },
      resizeSessionsSidebar: (width) => {
        const maxWidth = maxSessionsSidebarWidth(
          process.stdout.columns ?? 100,
          this.state.workspaceSidePaneWidth
        );
        const next = clampPaneWidth(
          width,
          MIN_SESSIONS_SIDEBAR_WIDTH,
          maxWidth
        );
        if (next !== this.state.sessionsSidebarWidth) {
          this.state.sessionsSidebarWidth = next;
          this.persistAndRender();
        }
      },
      resizeTerminal: (cols, rows) => {
        const terminal = this.activeTerminal();
        if (!terminal) {
          return;
        }
        const panel = this.shellPanel(terminal);
        panel.resize(cols, rows);
      },
      resizeWorkspaceSidePane: (width) => {
        const sessionsWidth = this.state.sidebarVisible
          ? this.state.sessionsSidebarWidth
          : COLLAPSED_SESSIONS_SIDEBAR_WIDTH;
        const maxWidth = maxWorkspaceSidePaneWidth(
          process.stdout.columns ?? 100,
          sessionsWidth
        );
        const next = clampPaneWidth(
          width,
          MIN_WORKSPACE_SIDE_PANE_WIDTH,
          maxWidth
        );
        if (next !== this.state.workspaceSidePaneWidth) {
          this.state.workspaceSidePaneWidth = next;
          this.persistAndRender();
        }
      },
      scrollHarness: (lines) => {
        const harness = this.activeHarness();
        if (harness) {
          this.harnessPanel(harness).scrollLines(lines);
        }
      },
      scrollTerminal: (lines) => {
        const terminal = this.activeTerminal();
        if (terminal) {
          this.shellPanel(terminal).scrollLines(lines);
        }
      },
      selectSession: (id) => this.selectSession(id),
      closeSession: (id) => this.closeSession(id),
      openNewAgent: () => {
        this.state.newAgentOpen = true;
        this.state.newHarnessOpen = false;
        this.state.plusMenuOpen = false;
        this.state.focus = "newAgent";
        this.render();
      },
      cancelNewAgent: () => {
        this.state.newAgentOpen = false;
        this.state.focus = focusForMainTab(this.activeSession().activeMainTab);
        this.render();
      },
      createAgent: (path) => this.createAgent(path),
      openNewHarness: () => {
        this.state.newHarnessOpen = true;
        this.state.newAgentOpen = false;
        this.state.plusMenuOpen = false;
        this.state.focus = "newHarness";
        this.render();
      },
      cancelNewHarness: () => {
        this.state.newHarnessOpen = false;
        this.state.newAgentOpen = false;
        this.state.focus = focusForMainTab(this.activeSession().activeMainTab);
        this.render();
      },
      addHarness: (harnessId) => this.addHarness(harnessId),
      newTerminal: () => this.newTerminal(),
      closeTerminal: (id) => this.closeTerminal(id),
      closeHarness: (id) => this.closeHarness(id),
      togglePlusMenu: () => {
        this.state.plusMenuOpen = !this.state.plusMenuOpen;
        this.render();
      },
      closePlusMenu: () => {
        if (!this.state.plusMenuOpen) {
          return;
        }
        this.state.plusMenuOpen = false;
        this.render();
      },
      selectDiffFile: (path) => {
        const session = this.activeSession();
        session.selectedDiffPath = path;
        session.activeMainTab = CHANGES_TAB;
        this.state.focus = "editor";
        if (this.diffTick) {
          this.scheduleDiffTick(this.diffTick);
        }
        this.render();
      },
      getFilePatch: (path) => computeFilePatch(this.activeSession().cwd, path),
    };
  }

  buildView(): WorkbenchViewModel {
    const session = this.activeSession();
    const harness = this.activeHarness();
    const terminal = this.activeTerminal();
    const harnessPanel = harness ? this.harnessPanel(harness) : undefined;
    const terminalPanel = terminal ? this.shellPanel(terminal) : undefined;

    // When the active pane changes, bump its revision once so the <Terminal>
    // redraws in place (we no longer force a remount via `key`).
    const activeKey = `${session.id}:${session.activeMainTab}`;
    if (activeKey !== this.lastActiveKey) {
      this.lastActiveKey = activeKey;
      harnessPanel?.touch();
      terminalPanel?.touch();
    }

    return {
      cwd: session.cwd,
      state: this.state,
      session,
      explorerOptions: this.explorerOptions,
      mainTabOptions: this.mainTabOptions(),
      harnessSpecs,
      harnessPanel,
      terminalPanel,
      activeFile: this.explorerEntries.find(
        (entry) => entry.path === session.activeTabPath
      ),
      diff: this.diffCache.get(session.cwd),
      diffs: this.diffCache,
    };
  }

  private startDiffPolling() {
    if (
      Bun.env.WORKBENCH_UI_SCREENSHOT === "1" &&
      Bun.env.WORKBENCH_UI_FORCE_DIFF !== "1"
    ) {
      return;
    }
    const tick = async () => {
      if (this.shuttingDown) {
        return;
      }
      await this.workbenchDiffs();
      this.scheduleDiffTick(tick);
    };
    void tick();
  }

  // Poll quickly only while the Changes view is open (so it feels live as an
  // agent edits files); otherwise the diffs just back badges/side summaries, so
  // a slow cadence is plenty and keeps constant git/subprocess churn down.
  private scheduleDiffTick(tick: () => void) {
    if (this.shuttingDown) {
      return;
    }
    if (this.diffTimer) {
      clearTimeout(this.diffTimer);
    }
    const onChanges = isChangesTab(this.activeSession().activeMainTab);
    this.diffTimer = setTimeout(tick, onChanges ? 2000 : 10_000);
    this.diffTick = tick;
  }

  private async workbenchDiffs() {
    if (this.diffRunning || this.shuttingDown) {
      return;
    }
    this.diffRunning = true;
    try {
      const roots = new Set(this.state.sessions.map((session) => session.cwd));
      let changed = false;
      for (const root of roots) {
        try {
          const diff = await computeSessionDiff(root);
          const signature = diffSignature(diff);
          if (this.diffSignatures.get(root) !== signature) {
            this.diffSignatures.set(root, signature);
            changed = true;
          }
          this.diffCache.set(root, diff);
        } catch {
          // Ignore per-root failures; the next tick retries.
        }
      }
      if (changed && !this.shuttingDown) {
        this.render();
      }
    } finally {
      this.diffRunning = false;
    }
  }

  subscribe(listener: () => void): () => void {
    this.viewListener = listener;
    return () => {
      if (this.viewListener === listener) {
        this.viewListener = undefined;
      }
    };
  }

  // Leading-edge throttle: paint the first change in a quiet period immediately
  // (zero added latency for a keystroke / tab switch), then coalesce any further
  // changes within the frame window so bursts stay capped at ~60fps. Terminal
  // output no longer flows through here (the <Terminal> subscribes to its panel
  // directly), so this path now serves sparse, latency-sensitive UI updates.
  private render() {
    if (this.shuttingDown) {
      return;
    }
    if (this.renderTimer) {
      return;
    }
    const elapsed = Date.now() - this.lastRenderAt;
    if (elapsed >= RENDER_INTERVAL_MS) {
      this.lastRenderAt = Date.now();
      this.viewListener?.();
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.lastRenderAt = Date.now();
      if (!this.shuttingDown) {
        this.viewListener?.();
      }
    }, RENDER_INTERVAL_MS - elapsed);
  }

  private cycleTheme(direction: number) {
    const next = nextThemeName(this.state.themeName, direction);
    // applyTheme mutates the shared `colors` palette in place; the re-render
    // below repaints all chrome, and touching panels forces the <Terminal>
    // subtrees (which only redraw on revision bumps) to repick default colors.
    this.state.themeName = applyTheme(next);
    for (const panel of this.harnessPanels.values()) {
      panel.touch();
    }
    for (const panel of this.shellPanels.values()) {
      panel.touch();
    }
    emitToast({
      title: `Theme: ${THEME_LABELS[next]}`,
      variant: "accent",
      duration: 1500,
    });
    this.persistAndRender();
  }

  private activeSession(): AgentSession {
    return (
      this.state.sessions.find(
        (session) => session.id === this.state.activeSessionId
      ) ?? this.state.sessions[0]
    );
  }

  private activeTerminal(): TerminalTab | undefined {
    const session = this.activeSession();
    const id = terminalIdFromTab(session.activeMainTab);
    if (!id) {
      return;
    }
    return session.terminals.find((terminal) => terminal.id === id);
  }

  private activeHarness(): HarnessTab | undefined {
    const session = this.activeSession();
    const id = harnessIdFromTab(session.activeMainTab);
    if (!id) {
      return;
    }
    return session.harnesses.find((harness) => harness.id === id);
  }

  private harnessPanel(harness: HarnessTab): TerminalPanel {
    let panel = this.harnessPanels.get(harness.id);
    if (!panel) {
      const command = harnessSpec(harness.harnessId).command();
      panel = new TerminalPanel(
        harness.cwd,
        this.estimateCols(),
        this.estimateRows(),
        {
          ...command,
          env: {
            ...HARNESS_COLOR_ENV,
            ...command.env,
          },
          persist: this.persistFor(harness.tmux),
        }
      );
      this.harnessPanels.set(harness.id, panel);
    }
    return panel;
  }

  private shellPanel(terminal: TerminalTab): TerminalPanel {
    let panel = this.shellPanels.get(terminal.id);
    if (!panel) {
      panel = new TerminalPanel(
        terminal.cwd,
        this.estimateCols(),
        this.estimateRows(),
        {
          persist: this.persistFor(terminal.tmux),
        }
      );
      this.shellPanels.set(terminal.id, panel);
    }
    return panel;
  }

  // Persistent tmux backing for a panel, unless we're in a throwaway screenshot
  // run (which must not spawn real tmux sessions).
  private persistFor(
    name: string
  ): { socketPath: string; name: string } | undefined {
    if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
      return;
    }
    return { socketPath: TMUX_SOCKET_PATH, name };
  }

  private mainTabOptions(): TabSelectOption[] {
    const session = this.activeSession();
    return [
      ...session.harnesses.map((harness) => ({
        name: harness.name,
        description: `${harnessSpec(harness.harnessId).label} | ${harness.cwd}`,
        value: `harness:${harness.id}`,
      })),
      ...session.terminals.map((terminal) => ({
        name: terminal.name,
        description: terminal.cwd,
        value: `term:${terminal.id}`,
      })),
      ...session.openTabs.map((tab) => ({
        name: `${tab.dirty ? "*" : ""}${tab.name}`,
        description: relative(session.cwd, tab.path),
        value: tab.path,
      })),
    ];
  }

  private focus(target: AppState["focus"]) {
    this.state.focus = target;
    this.render();
  }

  private openExplorerOption(option: SelectOption | null) {
    const entry = option?.value as FileTreeEntry | undefined;
    if (!entry) {
      return;
    }
    const session = this.activeSession();
    if (entry.isDirectory) {
      this.state.focus = "explorer";
      toggleDirectory(session.expandedDirs, entry.path);
      this.rebuildExplorer(entry.path);
      this.syncExplorerWatcher();
      this.persistAndRender();
      return;
    }
    openTab(session, entry.path);
    session.activeMainTab = entry.path;
    session.activeTabPath = entry.path;
    this.state.focus = "editor";
    this.persistAndRender();
  }

  private selectMainTab(option: TabSelectOption | null) {
    const value = option?.value as string | undefined;
    if (!value) {
      return;
    }
    const session = this.activeSession();
    if (session.activeMainTab === value) {
      return;
    }
    session.activeMainTab = value;
    this.state.focus = focusForMainTab(value);
    if (
      !(
        harnessIdFromTab(value) ||
        terminalIdFromTab(value) ||
        isChangesTab(value)
      )
    ) {
      session.activeTabPath = value;
    }
    if (isChangesTab(value)) {
      void this.workbenchDiffs();
      // Switch to the fast cadence right away instead of waiting out the
      // current slow timer.
      if (this.diffTick) {
        this.scheduleDiffTick(this.diffTick);
      }
    }
    this.persistAndRender();
  }

  private closeTab(value: string) {
    // The Changes tab is synthetic and always present; it can't be closed.
    if (isChangesTab(value)) {
      return;
    }
    const harnessId = harnessIdFromTab(value);
    if (harnessId) {
      this.closeHarness(harnessId);
      return;
    }
    const terminalId = terminalIdFromTab(value);
    if (terminalId) {
      this.closeTerminal(terminalId);
      return;
    }
    const session = this.activeSession();
    const index = session.openTabs.findIndex((tab) => tab.path === value);
    if (index === -1) {
      return;
    }
    session.openTabs.splice(index, 1);
    const neighbor = session.openTabs[Math.max(0, index - 1)];
    if (session.activeMainTab === value) {
      session.activeMainTab = neighbor
        ? neighbor.path
        : `harness:${session.harnesses[0].id}`;
      session.activeTabPath = neighbor?.path;
      this.state.focus = focusForMainTab(session.activeMainTab);
    } else if (session.activeTabPath === value) {
      session.activeTabPath = neighbor?.path;
    }
    this.persistAndRender();
  }

  private selectSession(id: string) {
    if (this.state.activeSessionId === id) {
      return;
    }
    const session = this.state.sessions.find((item) => item.id === id);
    if (!session) {
      return;
    }
    this.state.activeSessionId = id;
    // Keep focus in the sidebar during keyboard navigation; otherwise land on
    // whatever tab the session had active.
    if (this.state.focus !== "sessions") {
      this.state.focus = focusForMainTab(session.activeMainTab);
    }
    this.syncExplorerToActiveSession();
    this.persistAndRender();
  }

  private closeSession(id: string) {
    if (this.state.sessions.length <= 1) {
      return;
    }
    const index = this.state.sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      return;
    }
    const closing = this.state.sessions[index];
    for (const harness of closing.harnesses) {
      this.harnessPanels.get(harness.id)?.kill();
      this.harnessPanels.delete(harness.id);
    }
    for (const terminal of closing.terminals) {
      this.shellPanels.get(terminal.id)?.kill();
      this.shellPanels.delete(terminal.id);
    }
    this.state.sessions.splice(index, 1);
    if (this.state.activeSessionId === id) {
      const next = this.state.sessions[Math.max(0, index - 1)];
      this.state.activeSessionId = next.id;
      if (this.state.focus !== "sessions") {
        this.state.focus = focusForMainTab(next.activeMainTab);
      }
      this.syncExplorerToActiveSession();
    }
    emitToast({
      title: "Workspace closed",
      description: relative(homedir(), closing.cwd) || closing.cwd,
      variant: "info",
    });
    this.persistAndRender();
  }

  private createAgent(rawPath: string) {
    const base = this.activeSession().cwd;
    const resolved = expandPathInput(rawPath, base);
    const cwd = isExistingDirectory(resolved) ? resolved : base;
    const session = createSession(cwd, this.state.sessions);
    this.state.sessions.push(session);
    this.state.activeSessionId = session.id;
    this.state.newAgentOpen = false;
    this.state.focus = "harness";
    this.syncExplorerToActiveSession();
    emitToast({
      title: "Workspace created",
      description: relative(homedir(), cwd) || cwd,
      variant: "success",
    });
    this.persistAndRender();
  }

  private addHarness(harnessId: string) {
    const session = this.activeSession();
    const active = this.activeHarness();
    const existing =
      (active?.harnessId === harnessId ? active : undefined) ??
      session.harnesses.find((harness) => harness.harnessId === harnessId);
    const harness =
      existing ?? createHarness(session.cwd, session.harnesses, harnessId);
    if (!existing) {
      session.harnesses.push(harness);
    } else if (active?.id === existing.id) {
      // Re-selecting the harness that already owns this pane is an explicit
      // restart. Keep the tab and its stable tmux identity, but destroy the
      // current tmux session and replace the local panel so the next render
      // starts a clean harness process in place.
      const panel =
        this.harnessPanels.get(existing.id) ?? this.harnessPanel(existing);
      panel.kill();
      this.harnessPanels.delete(existing.id);
    }
    session.activeMainTab = `harness:${harness.id}`;
    this.state.newHarnessOpen = false;
    this.state.plusMenuOpen = false;
    this.state.focus = "harness";
    this.persistAndRender();
  }

  private newTerminal() {
    const session = this.activeSession();
    const terminal = createTerminal(session.cwd, session.terminals);
    session.terminals.push(terminal);
    session.activeMainTab = `term:${terminal.id}`;
    this.state.plusMenuOpen = false;
    this.state.focus = "terminal";
    this.persistAndRender();
  }

  private closeTerminal(id: string) {
    const session = this.activeSession();
    const index = session.terminals.findIndex((terminal) => terminal.id === id);
    if (index === -1) {
      return;
    }
    this.shellPanels.get(id)?.kill();
    this.shellPanels.delete(id);
    session.terminals.splice(index, 1);
    if (session.activeMainTab === `term:${id}`) {
      const next = session.terminals[Math.max(0, index - 1)];
      session.activeMainTab = next
        ? `term:${next.id}`
        : `harness:${session.harnesses[0].id}`;
      this.state.focus = next ? "terminal" : "harness";
    }
    this.persistAndRender();
  }

  private closeHarness(id: string) {
    const session = this.activeSession();
    if (session.harnesses.length <= 1) {
      return;
    }
    const index = session.harnesses.findIndex((harness) => harness.id === id);
    if (index === -1) {
      return;
    }
    this.harnessPanels.get(id)?.kill();
    this.harnessPanels.delete(id);
    session.harnesses.splice(index, 1);
    if (session.activeMainTab === `harness:${id}`) {
      const next =
        session.harnesses[Math.max(0, index - 1)] ?? session.harnesses[0];
      session.activeMainTab = `harness:${next.id}`;
      this.state.focus = "harness";
    }
    this.persistAndRender();
  }

  private updateFileContent(path: string, content: string) {
    const tab = this.activeSession().openTabs.find(
      (item) => item.path === path
    );
    if (!tab || tab.binary || tab.truncated) {
      return;
    }
    if (tab.content === content) {
      return;
    }
    tab.content = content;
    tab.dirty = true;
    this.render();
  }

  private setMarkdownView(path: string, mode: "preview" | "source") {
    const tab = this.activeSession().openTabs.find(
      (item) => item.path === path
    );
    if (!tab || tab.kind !== "markdown") {
      return;
    }
    if (tab.mdView === mode) {
      return;
    }
    tab.mdView = mode;
    this.render();
  }

  private saveActiveFile() {
    const session = this.activeSession();
    const tab = session.openTabs.find(
      (item) => item.path === session.activeMainTab
    );
    if (!tab || tab.binary || tab.truncated) {
      return;
    }
    try {
      writeFileSync(tab.path, tab.content, "utf8");
      tab.dirty = false;
      this.persistAndRender();
    } catch {
      this.render();
    }
  }

  private rebuildExplorer(preferredPath?: string) {
    const session = this.activeSession();
    this.explorerEntries = buildExplorerEntries(
      session.cwd,
      session.expandedDirs
    );
    this.explorerOptions = this.explorerEntries.map((entry) => ({
      name: entry.label,
      description: describeEntry(session.cwd, entry),
      value: entry,
    }));
    if (
      preferredPath &&
      !this.explorerEntries.some((entry) => entry.path === preferredPath)
    ) {
      session.expandedDirs.delete(preferredPath);
    }
  }

  private syncExplorerToActiveSession() {
    this.rebuildExplorer();
    this.syncExplorerWatcher();
  }

  private syncExplorerWatcher() {
    const session = this.activeSession();
    const cwd = session.cwd;
    // Watch only the directories that are actually visible (root + expanded
    // folders), each shallowly. Watching the whole repo to depth 8 set up
    // thousands of inotify watches and was a major source of startup lag.
    const paths = [
      cwd,
      ...[...session.expandedDirs].filter((dir) => dir.startsWith(cwd)),
    ].sort();
    const signature = paths.join("\n");
    if (this.watchedCwd === signature) {
      return;
    }
    void this.explorerWatcher?.close();
    this.watchedCwd = signature;
    const shouldIgnore = createExplorerIgnore(cwd, {
      respectGitignore: false,
    });
    this.explorerWatcher = chokidar
      .watch(paths, {
        depth: 0,
        ignored: (path) => shouldIgnore(path),
        ignoreInitial: true,
        ignorePermissionErrors: true,
        awaitWriteFinish: {
          stabilityThreshold: 120,
          pollInterval: 40,
        },
      })
      .on("all", () => this.scheduleExplorerWorkbench())
      .on("error", () => {});
  }

  private scheduleExplorerWorkbench() {
    if (this.explorerWorkbenchTimer) {
      clearTimeout(this.explorerWorkbenchTimer);
    }
    this.explorerWorkbenchTimer = setTimeout(() => {
      this.explorerWorkbenchTimer = undefined;
      this.rebuildExplorer();
      this.reloadOpenTabs();
      void this.workbenchDiffs();
      this.render();
    }, 120);
  }

  private reloadOpenTabs() {
    const session = this.activeSession();
    session.openTabs = session.openTabs.map((tab) =>
      tab.dirty ? tab : (openEditorTab(tab.path) ?? tab)
    );
    if (
      !(
        harnessIdFromTab(session.activeMainTab) ||
        terminalIdFromTab(session.activeMainTab) ||
        isChangesTab(session.activeMainTab) ||
        session.openTabs.some((tab) => tab.path === session.activeMainTab)
      )
    ) {
      session.activeMainTab = `harness:${session.harnesses[0].id}`;
      session.activeTabPath = undefined;
      this.state.focus = "harness";
    }
  }

  private persistAndRender() {
    this.schedulePersist();
    this.render();
  }

  private schedulePersist() {
    if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1" || this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      if (!this.shuttingDown) {
        savePersistedState(this.state);
      }
    }, 250);
  }

  shutdown(code: number) {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    savePersistedState(this.state);
    // Detach (not kill): persistent tmux sessions keep running so the next
    // launch re-attaches to the same live harnesses/terminals.
    for (const panel of this.harnessPanels.values()) {
      panel.detach();
    }
    for (const panel of this.shellPanels.values()) {
      panel.detach();
    }
    if (this.explorerWorkbenchTimer) {
      clearTimeout(this.explorerWorkbenchTimer);
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    if (this.diffTimer) {
      clearTimeout(this.diffTimer);
    }
    void this.explorerWatcher?.close();
    try {
      this.instance?.unmount();
    } catch {
      // Ignore shutdown races.
    }
    process.exit(code);
  }

  // Initial PTY size estimates only; the panes resize to exact dimensions via
  // onSizeChange before the PTY spawns.
  private estimateCols() {
    const sidebar = this.state.sidebarVisible
      ? this.state.sessionsSidebarWidth
      : COLLAPSED_SESSIONS_SIDEBAR_WIDTH;
    return Math.max(
      20,
      (process.stdout.columns ?? 100) -
        sidebar -
        this.state.workspaceSidePaneWidth -
        4
    );
  }

  private estimateRows() {
    return Math.max(8, (process.stdout.rows ?? 30) - 4);
  }
}

function WorkbenchRoot({ app }: { app: ReactWorkbenchApp }) {
  const [view, setView] = useState(() => app.buildView());
  useEffect(() => app.subscribe(() => setView(app.buildView())), [app]);
  return (
    <ThemeProvider
      key={view.state.themeName}
      tokens={themeTokens(view.state.themeName)}
    >
      <Workbench actions={app.actions()} view={view} />
    </ThemeProvider>
  );
}

export async function runWorkbench(options: WorkbenchOptions) {
  const app = new ReactWorkbenchApp(options);
  await app.run();
}
