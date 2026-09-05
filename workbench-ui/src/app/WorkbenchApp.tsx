import { existsSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { useEffect, useState } from "react";
import { ThemeProvider } from "silvery";
import { run } from "silvery/runtime";
import { captureAnalytics, shutdownAnalytics } from "../analytics";
import { tracedStdout } from "../terminal/terminal-trace";

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
  claimInstanceLock,
  readInstanceOwner,
  releaseInstanceLock,
} from "../state/instance-lock";
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
import {
  hotAttachesRealSessions,
  tmuxSocketPath,
  workbenchDir,
} from "../state/workbench-paths";
import {
  killPersistentTmuxSession,
  type PersistentTmuxSession,
  TerminalPanel,
} from "../terminal/terminal-panel";
import {
  captureTmuxPane,
  harnessAppearsRunning,
  recentTmuxActivity,
  sessionAppearsRunning,
} from "../terminal/tmux-activity";
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
  ensureWorkspaceDirectory,
  expandPathInput,
  toggleDirectory,
} from "../text/file-tree";
import {
  type GitHubRepositoryInput,
  githubRepositoryInput,
} from "../text/github-repo";
import {
  COLLAPSED_SESSIONS_SIDEBAR_WIDTH,
  COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH,
  clampPaneWidth,
  clampSessionsLogoHeight,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDE_PANE_WIDTH,
  maxSessionsSidebarWidth,
  maxWorkspaceSidePaneWidth,
} from "../ui/pane-layout";
import { applyTheme, nextThemeName, themeTokens } from "../ui/theme";
import { emitToast } from "../ui/toast";
import {
  UPDATE_RESTART_EXIT_CODE,
  updateRestartCommand,
  updateRestartHasSupervisor,
} from "./update-restart";

// Persistent harness/terminal sessions run on a private tmux server addressed by
// an explicit socket *path* under ~/.workbench (not a `-L` name in the shared
// per-user tmux tmpdir). This guarantees they never collide with, or show up in,
// the user's own tmux server.
// Resolved via workbench-paths: `work --hot` deliberately uses the normal
// socket so it can reattach the user's sessions. The startup owner guard below
// prevents a hot and ordinary UI from mounting those sessions simultaneously.
const TMUX_SOCKET_PATH = tmuxSocketPath();

// Minimum gap between full-app repaints (~60fps) used by the leading-edge render
// throttle. Low enough to feel instant, high enough to coalesce bursts.
const RENDER_INTERVAL_MS = 16;
const HARNESS_ACTIVITY_POLL_MS = 750;
// Long enough for a freshly mounted pane's first repaint burst to land, short
// enough that a stale region is never visible for more than a blink.
const FULL_REDRAW_DELAY_MS = 200;
const HARNESS_COLOR_ENV = {
  CLICOLOR: "1",
  CLICOLOR_FORCE: "1",
  COLORTERM: "truecolor",
  FORCE_COLOR: "1",
};

export interface WorkbenchOptions {
  cwd: string;
}

interface WorkspaceCloneOperation {
  cancelled: boolean;
  destination: string;
  destinationExisted: boolean;
  id: string;
  process?: ReturnType<typeof Bun.spawn>;
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
  private runningSessionIds = new Set<string>();
  private workspaceCloneOperation?: WorkspaceCloneOperation;
  private harnessActivityTimer?: ReturnType<typeof setTimeout>;
  private fullRedrawTimer?: ReturnType<typeof setTimeout>;
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

    // A shared hot launch is meant to replace an ordinary UI and exercise its
    // real sessions for a long-running test. Require the previous UI to shut
    // down and detach first; attaching anyway would steal each tmux client and
    // recreate the stale-size/input-box corruption hot testing is meant to find.
    const existingOwner = readInstanceOwner();
    if (existingOwner && hotAttachesRealSessions()) {
      console.error(
        `work --hot cannot attach sessions while Workbench pid ${existingOwner.pid} on ${existingOwner.tty} is still open. Quit that Workbench first; its harnesses will keep running, then launch work --hot again.`
      );
      process.exitCode = 2;
      return;
    }

    // Claim this workbench namespace. A live previous owner means two instances
    // share one tmux server and one state file, which silently corrupts panes
    // (the later mount detaches the earlier client), so say so plainly rather
    // than letting the user hunt a vanished input box.
    const collidingOwner = claimInstanceLock();
    if (collidingOwner) {
      emitToast({
        title: "Another Workbench is using these sessions",
        description: `pid ${collidingOwner.pid} on ${collidingOwner.tty} shares ${workbenchDir()}. Panes will fight; quit one window.`,
        variant: "warning",
      });
    }

    this.rebuildExplorer();
    this.syncExplorerWatcher();
    this.startDiffPolling();
    this.startHarnessActivityPolling();
    captureAnalytics("app_started", {
      restored_session_count: this.state.sessions.length,
      theme: this.state.themeName,
    });

    process.once("SIGTERM", () => this.shutdown(0));
    process.once("SIGINT", () => this.shutdown(0));
    const stdout = tracedStdout(process.stdout);
    this.instance = await run(<WorkbenchRoot app={this} />, {
      stdin: process.stdin,
      stdout,
      cols: process.stdout.columns ?? 120,
      rows: process.stdout.rows ?? 36,
      // The host has already reflowed when SIGWINCH arrives. Waiting 200 ms
      // lets incoming PTY output paint diffs against the pre-resize screen.
      resizeCoalesceMs: 0,
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
      updateWorkbench: () => this.updateWorkbench(),
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
      toggleWorkspaceSidePane: () => {
        this.state.workspaceSidePaneVisible =
          !this.state.workspaceSidePaneVisible;
        if (
          !this.state.workspaceSidePaneVisible &&
          this.state.focus === "explorer"
        ) {
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
      resizeSessionsLogo: (height) => {
        const next = clampSessionsLogoHeight(height);
        if (next !== this.state.sessionsLogoHeight) {
          this.state.sessionsLogoHeight = next;
          this.persistAndRender();
        }
      },
      resizeSessionsSidebar: (width) => {
        const maxWidth = maxSessionsSidebarWidth(
          process.stdout.columns ?? 100,
          this.state.workspaceSidePaneVisible
            ? this.state.workspaceSidePaneWidth
            : COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH
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
      cancelWorkspaceClone: (id) => this.cancelWorkspaceClone(id),
      cloneRepository: (repository) => this.createRepository(repository),
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

  private async updateWorkbench(): Promise<boolean> {
    const command = Bun.which("workbench-cli") ?? Bun.which("work");
    if (!command) {
      return false;
    }
    try {
      const process = Bun.spawn([command, "update"], {
        cwd: this.activeSession().cwd,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const updated = (await process.exited) === 0;
      captureAnalytics("manual_update_completed", { success: updated });
      if (updated) {
        this.shutdown(
          UPDATE_RESTART_EXIT_CODE,
          updateRestartHasSupervisor()
            ? undefined
            : updateRestartCommand(command)
        );
      }
      return updated;
    } catch {
      captureAnalytics("manual_update_completed", { success: false });
      return false;
    }
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
      runningSessionIds: this.runningSessionIds,
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

  private startHarnessActivityPolling() {
    if (Bun.env.WORKBENCH_UI_SCREENSHOT === "1") {
      return;
    }
    const tick = async () => {
      if (this.shuttingDown) {
        return;
      }
      const sessions = [...this.state.sessions];
      const activeTmux = await recentTmuxActivity(TMUX_SOCKET_PATH);
      const statuses = await Promise.all(
        sessions.map(async (session) => {
          const [harnessStatuses, terminalPaneTexts] = await Promise.all([
            Promise.all(
              session.harnesses.map(async (harness) =>
                harnessAppearsRunning(
                  harness.harnessId,
                  await captureTmuxPane(TMUX_SOCKET_PATH, harness.tmux),
                  activeTmux.has(harness.tmux)
                )
              )
            ),
            Promise.all(
              session.terminals.map((terminal) =>
                captureTmuxPane(TMUX_SOCKET_PATH, terminal.tmux)
              )
            ),
          ]);
          // A coding agent can also be launched inside a regular terminal tab.
          // Only explicit agent UI markers count there: ordinary shell output
          // must not make the session rail look like a running agent.
          return [
            session.id,
            sessionAppearsRunning(harnessStatuses, terminalPaneTexts),
          ] as const;
        })
      );
      if (this.shuttingDown) {
        return;
      }
      const next = new Set(
        statuses.filter(([, running]) => running).map(([id]) => id)
      );
      if (!setsEqual(next, this.runningSessionIds)) {
        this.runningSessionIds = next;
        this.render();
      }
      this.harnessActivityTimer = setTimeout(tick, HARNESS_ACTIVITY_POLL_MS);
      this.harnessActivityTimer.unref?.();
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
    // Never touch `harnessActivityTimer` here. This scheduler only owns the
    // diff cadence; the harness activity poll re-arms itself and nothing
    // restarts it if its pending wakeup is cancelled. Clearing it from here
    // silently froze the running-session animation a few seconds into every
    // launch, because this runs after every diff pass (every 2s with the
    // Changes tab open, otherwise every 10s) and the activity tick spends
    // nearly its whole 750ms cycle parked on that timeout.
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
    captureAnalytics("theme_changed", { theme: next });
    for (const panel of this.harnessPanels.values()) {
      panel.touch();
    }
    for (const panel of this.shellPanels.values()) {
      panel.touch();
    }
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
      // A newly mounted pane paints its whole backlog at once; that is exactly
      // when the renderer's incremental model has been observed to diverge.
      this.scheduleFullRedraw();
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
      this.scheduleFullRedraw();
    }
    return panel;
  }

  // Persistent tmux backing for a panel, unless we're in a throwaway screenshot
  // run (which must not spawn real tmux sessions).
  private persistFor(name: string): PersistentTmuxSession | undefined {
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
    // Mounting a pane and immediately taking its first large repaint can leave
    // the renderer believing part of the pane is already correct, so those rows
    // are never written again — an agent's bottom-anchored composer then stays
    // invisible indefinitely. Repaint every cell once the switch settles.
    this.scheduleFullRedraw();
    this.persistAndRender();
  }

  // Force the renderer to rewrite every cell of the next frame.
  //
  // Silvery's diff only emits rows it considers dirty, so once its notion of
  // the screen diverges from what was actually painted, nothing converges on
  // its own: the stale rows are never written again. A `--terminal-trace`
  // capture showed exactly that — after a freshly mounted pane took its first
  // large PTY burst, 38 of the pane's 65 rows stayed wrong for 163 consecutive
  // frames across 47 panel revisions, which is what hides an agent's
  // bottom-anchored composer.
  //
  // `markAllRowsDirty()` re-arms every row so the next commit repaints in full.
  // Debounced, and delayed so a pane's initial burst lands first.
  private scheduleFullRedraw() {
    if (this.fullRedrawTimer) {
      clearTimeout(this.fullRedrawTimer);
    }
    this.fullRedrawTimer = setTimeout(() => {
      this.fullRedrawTimer = undefined;
      if (this.shuttingDown) {
        return;
      }
      try {
        this.instance?.buffer?.markAllRowsDirty();
        this.render();
      } catch {
        // A repaint is best-effort; never take the app down for it.
      }
    }, FULL_REDRAW_DELAY_MS);
    this.fullRedrawTimer.unref?.();
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
    // Switching workspaces swaps every pane's contents at once, the same
    // condition under which the incremental renderer has been seen to leave a
    // region stale.
    this.scheduleFullRedraw();
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
      this.killBackingPanel(this.harnessPanels, harness.id, harness.tmux);
    }
    for (const terminal of closing.terminals) {
      this.killBackingPanel(this.shellPanels, terminal.id, terminal.tmux);
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
    this.persistAndRender();
  }

  private createAgent(rawPath: string) {
    const base = this.activeSession().cwd;
    const resolved = expandPathInput(rawPath, base);
    try {
      ensureWorkspaceDirectory(resolved);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emitToast({
        title: "Workspace could not be created",
        description: reason,
        variant: "error",
      });
      return;
    }
    this.openWorkspace(resolved);
  }

  private createRepository(rawRepository: string) {
    const repository = githubRepositoryInput(
      rawRepository,
      this.activeSession().cwd
    );
    if (!repository) {
      emitToast({
        title: "GitHub repository URL is not valid",
        description:
          "Paste a GitHub HTTPS URL, SSH URL, or github.com/owner/repository.",
        variant: "error",
      });
      return;
    }
    void this.cloneWorkspace(repository);
  }

  private async cloneWorkspace(repository: GitHubRepositoryInput) {
    if (this.workspaceCloneOperation) {
      emitToast({
        title: "Repository clone already running",
        description:
          "Wait for the current clone to finish before starting another.",
        variant: "warning",
      });
      return;
    }
    const pendingClone = {
      destination: repository.destination,
      id: `clone-${crypto.randomUUID()}`,
      name: repository.name,
    };
    const operation: WorkspaceCloneOperation = {
      cancelled: false,
      destination: repository.destination,
      destinationExisted: existsSync(repository.destination),
      id: pendingClone.id,
    };
    this.workspaceCloneOperation = operation;
    this.state.pendingWorkspaceClone = pendingClone;
    this.state.newAgentOpen = false;
    this.state.focus = focusForMainTab(this.activeSession().activeMainTab);
    this.persistAndRender();
    try {
      const process = Bun.spawn(
        ["git", "clone", "--", repository.cloneUrl, repository.destination],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }
      );
      operation.process = process;
      const stderr = new Response(process.stderr).text();
      const exitCode = await process.exited;
      const details = (await stderr).trim();
      if (operation.cancelled) {
        return;
      }
      if (exitCode !== 0) {
        captureAnalytics("repository_clone_completed", { success: false });
        emitToast({
          title: "Repository could not be cloned",
          description: details || `git clone exited with status ${exitCode}`,
          variant: "error",
        });
        return;
      }
      this.state.pendingWorkspaceClone = undefined;
      captureAnalytics("repository_clone_completed", { success: true });
      this.openWorkspace(repository.destination);
    } catch (error) {
      captureAnalytics("repository_clone_completed", { success: false });
      emitToast({
        title: "Repository could not be cloned",
        description: error instanceof Error ? error.message : String(error),
        variant: "error",
      });
    } finally {
      if (operation.cancelled && !operation.destinationExisted) {
        try {
          rmSync(operation.destination, { force: true, recursive: true });
        } catch {
          // Cancellation already succeeded; a locked partial directory can be
          // removed manually without leaving Workbench stuck in clone mode.
        }
      }
      if (this.workspaceCloneOperation?.id === operation.id) {
        this.workspaceCloneOperation = undefined;
      }
      if (this.state.pendingWorkspaceClone?.id === pendingClone.id) {
        this.state.pendingWorkspaceClone = undefined;
        this.render();
      }
    }
  }

  private cancelWorkspaceClone(id: string) {
    const operation = this.workspaceCloneOperation;
    if (!(operation && operation.id === id)) {
      return;
    }
    operation.cancelled = true;
    this.state.pendingWorkspaceClone = undefined;
    try {
      operation.process?.kill("SIGTERM");
    } catch {
      // The process may have exited between the click and this signal.
    }
    this.render();
  }

  private openWorkspace(cwd: string) {
    const session = createSession(cwd, this.state.sessions);
    this.state.sessions.push(session);
    this.state.activeSessionId = session.id;
    this.state.newAgentOpen = false;
    this.state.focus = "harness";
    this.syncExplorerToActiveSession();
    captureAnalytics("workspace_created", {
      session_count: this.state.sessions.length,
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
    captureAnalytics("harness_opened", {
      harness: harnessId,
      restarted: Boolean(existing && active?.id === existing.id),
    });
    if (!existing) {
      session.harnesses.push(harness);
    } else if (active?.id === existing.id) {
      // Re-selecting the harness that already owns this pane is an explicit
      // restart. Keep the tab and its stable tmux identity, but destroy the
      // current tmux session and replace the local panel so the next render
      // starts a clean harness process in place.
      this.killBackingPanel(this.harnessPanels, existing.id, existing.tmux);
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
    captureAnalytics("terminal_opened", {
      terminal_count: session.terminals.length,
    });
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
    this.killBackingPanel(this.shellPanels, id, session.terminals[index].tmux);
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
    this.killBackingPanel(
      this.harnessPanels,
      id,
      session.harnesses[index].tmux
    );
    session.harnesses.splice(index, 1);
    if (session.activeMainTab === `harness:${id}`) {
      const next =
        session.harnesses[Math.max(0, index - 1)] ?? session.harnesses[0];
      session.activeMainTab = `harness:${next.id}`;
      this.state.focus = "harness";
    }
    this.persistAndRender();
  }

  private killBackingPanel(
    panels: Map<string, TerminalPanel>,
    id: string,
    tmux: string
  ) {
    const panel = panels.get(id);
    if (panel) {
      panel.kill();
    } else {
      // A persisted pane may never have been opened in this Workbench process.
      // Closing its tab/workspace must still destroy the private tmux session;
      // otherwise removing the state entry makes that live process orphaned.
      killPersistentTmuxSession(this.persistFor(tmux));
    }
    panels.delete(id);
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

  shutdown(code: number, relaunch?: readonly string[]) {
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
    // Shutdown is the one place that legitimately stops the activity poll.
    if (this.harnessActivityTimer) {
      clearTimeout(this.harnessActivityTimer);
      this.harnessActivityTimer = undefined;
    }
    if (this.fullRedrawTimer) {
      clearTimeout(this.fullRedrawTimer);
      this.fullRedrawTimer = undefined;
    }
    releaseInstanceLock();
    void this.explorerWatcher?.close();
    try {
      this.instance?.unmount();
    } catch {
      // Ignore shutdown races.
    }
    void shutdownAnalytics().finally(async () => {
      if (relaunch) {
        try {
          // A Workbench started by a launcher older than v0.1.50 has the shell
          // as its parent, so nobody can consume exit 75. Keep this process as
          // the shell's foreground job while the freshly installed launcher
          // and UI run beneath it. New launchers advertise supervision and use
          // the simpler exit-code handoff instead.
          const replacement = Bun.spawn([...relaunch], {
            cwd: process.cwd(),
            env: {
              ...Bun.env,
              WORKBENCH_CLI_AUTO_UPDATE_DONE: "1",
            },
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
          });
          process.exit(await replacement.exited);
        } catch {
          process.exit(1);
        }
      }
      process.exit(code);
    });
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
        (this.state.workspaceSidePaneVisible
          ? this.state.workspaceSidePaneWidth
          : COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH) -
        4
    );
  }

  private estimateRows() {
    return Math.max(8, (process.stdout.rows ?? 30) - 4);
  }
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
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
