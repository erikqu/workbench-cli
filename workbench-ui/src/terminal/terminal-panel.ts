import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IBufferCell } from "@xterm/headless";
import { Terminal } from "@xterm/headless";
import type {
  Key,
  TerminalCell,
  TerminalCursor,
  TerminalReadable,
} from "silvery";
import { colors } from "../ui/theme";
import { emitToast } from "../ui/toast";
import {
  type PaneScrollPosition,
  parseTranscriptPercent,
  type ScrollThumb,
  sameScrollThumb,
  scrollThumb,
} from "./scroll-position";
import {
  terminalTrace,
  terminalTraceEnabled,
  terminalTracePresentedPanel,
  terminalTraceRowId,
} from "./terminal-trace";
import { type TmuxScrollPosition, tmuxScrollPosition } from "./tmux-activity";

export interface PersistentTmuxSession {
  name: string;
  socketPath: string;
}

export interface TerminalPanelOptions {
  command?: string;
  env?: Record<string, string>;
  // When set, the PTY command runs inside a persistent tmux session on a private
  // tmux server addressed by an explicit socket path (`-S`), so the process
  // survives the editor closing and is re-attached on the next launch. Using a
  // socket path under the app's own directory keeps this server fully separate
  // from the user's tmux (default server and any `-L` named servers).
  persist?: PersistentTmuxSession;
  // Some inline applications leave transient redraws in tmux history. Route
  // wheel gestures through their native transcript overlay instead.
  wheelNavigation?: "transcript";
}

let tmuxAvailable: boolean | undefined;
function hasTmux(): boolean {
  if (tmuxAvailable === undefined) {
    tmuxAvailable = Bun.which("tmux") !== null;
  }
  return tmuxAvailable;
}

export function killPersistentTmuxSession(
  persist: PersistentTmuxSession | undefined
): boolean {
  if (!(persist && hasTmux())) {
    return false;
  }
  try {
    return (
      Bun.spawnSync(
        ["tmux", "-S", persist.socketPath, "kill-session", "-t", persist.name],
        { stderr: "ignore", stdout: "ignore" }
      ).exitCode === 0
    );
  } catch {
    return false;
  }
}

// `setsid -c` (util-linux) starts the shell in a new session AND makes the PTY
// its controlling terminal, which Bun.Terminal alone does not do — without it
// interactive shells print "cannot set terminal process group / no job control"
// and lose Ctrl-Z/fg/bg. macOS has no `setsid`, so we fall back to a plain
// shell there (Ctrl-C still works; the main harness panes get job control from
// tmux regardless).
let setsidAvailable: boolean | undefined;
function hasSetsid(): boolean {
  if (setsidAvailable === undefined) {
    setsidAvailable = Bun.which("setsid") !== null;
  }
  return setsidAvailable;
}

// Minimal config for our private tmux server so embedded harness panes look
// clean: no status bar, mouse on, and none of the user's keybindings/status
// line or (possibly unsupported) options from ~/.tmux.conf leak in.
let tmux256ColorAvailable: boolean | undefined;
function hasTmux256Color(): boolean {
  if (tmux256ColorAvailable === undefined) {
    try {
      tmux256ColorAvailable =
        Bun.spawnSync(["infocmp", "tmux-256color"], {
          stderr: "ignore",
          stdout: "ignore",
        }).exitCode === 0;
    } catch {
      tmux256ColorAvailable = false;
    }
  }
  return tmux256ColorAvailable;
}

function tmuxConf(): string {
  return [
    "set -g status off",
    "set -g mouse on",
    "set -g escape-time 1",
    "set -g history-limit 20000",
    "set -g focus-events on",
    "setw -g aggressive-resize on",
    ...(hasTmux256Color() ? ['set -g default-terminal "tmux-256color"'] : []),
    "",
  ].join("\n");
}

let tmuxConfPath: string | undefined;
function ensureTmuxConf(): string {
  if (!tmuxConfPath) {
    const dir = join(Bun.env.HOME ?? ".", ".workbench");
    const path = join(dir, "workbench-ui-tmux.conf");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, tmuxConf());
    } catch {
      // Fall back to default config if we can't write ours.
    }
    tmuxConfPath = path;
  }
  return tmuxConfPath;
}

function interactiveShellCommand(shell: string, cwd: string): string {
  const shellName = shell.split("/").pop() ?? shell;
  const home = Bun.env.HOME ?? ".";
  if (shellName === "fish") {
    const fishCwd = `'${cwd.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    return `${shellQuote(shell)} -i -C ${shellQuote(`cd ${fishCwd}`)}`;
  }
  const digest = createHash("sha1").update(`${shell}\0${cwd}`).digest("hex");
  const initRoot = join(home, ".workbench", "shell-init", digest);
  try {
    mkdirSync(initRoot, { recursive: true });
    if (shellName === "bash") {
      const rcPath = join(initRoot, "bashrc");
      writeFileSync(
        rcPath,
        [
          "# Workbench terminal initialization: preserve login setup, then pin cwd.",
          'if [ -r "$HOME/.bash_profile" ]; then',
          '  . "$HOME/.bash_profile"',
          'elif [ -r "$HOME/.bash_login" ]; then',
          '  . "$HOME/.bash_login"',
          'elif [ -r "$HOME/.profile" ]; then',
          '  . "$HOME/.profile"',
          "fi",
          `builtin cd -- ${shellQuote(cwd)}`,
          "",
        ].join("\n"),
        { mode: 0o600 }
      );
      return `${shellQuote(shell)} --rcfile ${shellQuote(rcPath)} -i`;
    }
    if (shellName === "zsh") {
      const rcPath = join(initRoot, ".zshrc");
      writeFileSync(
        rcPath,
        [
          "# Workbench terminal initialization: preserve user setup, then pin cwd.",
          'if [[ -r "$HOME/.zshrc" ]]; then',
          '  source "$HOME/.zshrc"',
          "fi",
          `builtin cd -- ${shellQuote(cwd)}`,
          "",
        ].join("\n"),
        { mode: 0o600 }
      );
      return `ZDOTDIR=${shellQuote(initRoot)} ${shellQuote(shell)} -i`;
    }
  } catch {
    // If the wrapper cannot be created, tmux -c still gives ordinary shells
    // the correct initial directory. Only startup files that cd elsewhere can
    // override that fallback.
  }
  return `${shellQuote(shell)} -l`;
}

// macOS folder privacy (TCC) authorizes the private tmux server, not the
// panes it forks. The server outlives the terminal app that spawned it, and
// once that attribution goes stale (terminal restarted or updated, permission
// revoked, OS upgrade) every NEW pane is denied access to protected folders
// like ~/Documents: getcwd/readdir fail with EPERM, the agent CLI crashes on
// startup, and the pane shows "[exited]". Panes spawned while the grant was
// valid keep running, which makes the breakage look random. Ask the server to
// list the pane's cwd before creating a session there; when the server is
// denied a directory this process can read, kill it so the next new-session
// forks a fresh server attributed to the current app. Losing the old sessions
// is the designed trade-off: harness commands resume their previous
// conversation (`claude --continue`, `codex resume --last`).
const trustedServerDirs = new Set<string>();

export function restartServerIfPermissionStale(
  socketPath: string,
  cwd: string
): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const key = `${socketPath}\0${cwd}`;
  if (trustedServerDirs.has(key)) {
    return false;
  }
  const serverRunning =
    Bun.spawnSync(["tmux", "-S", socketPath, "has-session"], {
      stderr: "ignore",
      stdout: "ignore",
    }).exitCode === 0;
  if (!serverRunning) {
    // The session we are about to create forks a fresh server as our own
    // child, so it inherits the current app's (valid) attribution.
    trustedServerDirs.add(key);
    return false;
  }
  const serverCanRead =
    Bun.spawnSync(
      [
        "tmux",
        "-S",
        socketPath,
        "run-shell",
        `ls ${shellQuote(cwd)} >/dev/null 2>&1`,
      ],
      { stderr: "ignore", stdout: "ignore" }
    ).exitCode === 0;
  if (serverCanRead) {
    trustedServerDirs.add(key);
    return false;
  }
  // Only blame the server when this process can read the directory itself;
  // otherwise the workspace is genuinely inaccessible and a restart would
  // destroy live sessions for nothing.
  try {
    readdirSync(cwd);
  } catch {
    trustedServerDirs.add(key);
    return false;
  }
  Bun.spawnSync(["tmux", "-S", socketPath, "kill-server"], {
    stderr: "ignore",
    stdout: "ignore",
  });
  emitToast({
    title: "Agent session server restarted",
    description:
      "Its macOS folder permissions went stale; agents resume their last conversation.",
    variant: "info",
  });
  return true;
}

function configureExistingTmuxServer(socketPath: string) {
  if (!hasTmux256Color()) {
    return;
  }
  try {
    // A running private server has already read its config. Updating the
    // default affects only panes created afterward; existing sessions retain
    // the TERM they started with and are never restarted or destroyed.
    Bun.spawnSync(
      [
        "tmux",
        "-S",
        socketPath,
        "set-option",
        "-g",
        "default-terminal",
        "tmux-256color",
      ],
      { stderr: "ignore", stdout: "ignore" }
    );
  } catch {
    // No server yet: the first new-session reads the generated config instead.
  }
}

// Terminal default foreground/background follow the active app theme so the
// panes match the chrome (e.g. dark agent text on dark bg, near-black on white
// in the light theme). Default-colored cells render as a real terminal's fg
// instead of inheriting the muted $fg, which washed agent output out. Parsed
// hex is memoized so per-cell rendering stays allocation-cheap.
const rgbCache = new Map<string, { r: number; g: number; b: number }>();
function rgb(hex: string): { r: number; g: number; b: number } {
  let value = rgbCache.get(hex);
  if (!value) {
    value = hexToRgb(hex);
    rgbCache.set(hex, value);
  }
  return value;
}
const TERM_FG = () => rgb(colors.termFg);
const TERM_FG_BOLD = () => rgb(colors.termFgBold);
const TERM_BG = () => rgb(colors.termBg);
// Host terminals vary wildly in how faint they render SGR dim. Agent CLIs use
// dim for a lot of secondary text, so default to readability unless explicitly
// asked to preserve exact styling.
const PRESERVE_DIM = Bun.env.WORKBENCH_UI_PRESERVE_DIM === "1";

// High-contrast ANSI foreground palette for agent/terminal output. Saturated
// normals (0-7) that stay legible on the warm near-black background, paired
// with clearly lighter brights (8-15) so the bold -> bright promotion in
// cellColor() reads as genuinely bolder. Blue is aligned to the app's #5c9cf5
// secondary.
const ANSI_FG_16 = [
  "#6f6f78", // 0  black
  "#ff6b6b", // 1  red
  "#5fd75f", // 2  green
  "#ffd152", // 3  yellow
  "#5c9cf5", // 4  blue
  "#c792ea", // 5  magenta
  "#36d6e7", // 6  cyan
  "#eeece6", // 7  white (= terminal fg)
  "#9696a0", // 8  bright black
  "#ff8787", // 9  bright red
  "#87ef87", // 10 bright green
  "#ffe08a", // 11 bright yellow
  "#8fbcff", // 12 bright blue
  "#ddb6ff", // 13 bright magenta
  "#79e7f3", // 14 bright cyan
  "#ffffff", // 15 bright white
];

const ANSI_BG_16 = [
  "#1b1b1f", // 0  black
  "#ff6b6b", // 1  red
  "#5fd75f", // 2  green
  "#ffd152", // 3  yellow
  "#5c9cf5", // 4  blue
  "#c792ea", // 5  magenta
  "#36d6e7", // 6  cyan
  "#eeece6", // 7  white
  "#6c6c74", // 8  bright black
  "#ff8787", // 9  bright red
  "#87ef87", // 10 bright green
  "#ffe08a", // 11 bright yellow
  "#8fbcff", // 12 bright blue
  "#ddb6ff", // 13 bright magenta
  "#79e7f3", // 14 bright cyan
  "#ffffff", // 15 bright white
];

const PALETTE_256 = (() => {
  const palette = ANSI_FG_16.map(hexToRgb);
  const levels = [0, 95, 135, 175, 215, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        palette.push({ r, g, b });
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push({ r: v, g: v, b: v });
  }
  return palette;
})();

// Globally monotonic so the revision a panel reports always increases, even
// across panel switches. This lets the silvery <Terminal> redraw when the
// active pane swaps without remounting (no `key`), keeping switches instant.
let revisionCounter = 0;
let tracePanelCounter = 0;
const SYNCHRONIZED_OUTPUT_RECOVERY_IDLE_MS = 1000;
// Grace before the wheel-opened pager auto-closes at the bottom. Long enough
// that an up/down/up direction reversal never lands after a close (which would
// force a full alt-screen reopen and read as a flash), short enough that the
// composer returns promptly once the user actually stops scrolling.
const TRANSCRIPT_WHEEL_SETTLE_MS = 400;
const TMUX_MOUSE_MODE_CACHE_MS = 100;
// Rows one coalesced wheel burst may move inside the transcript pager.
//
// The pager repaints ONCE per burst no matter how many arrows arrive (measured
// against Codex 0.147: twelve back-to-back Down arrows produced a single
// ~12.5ms repaint), so a small fixed cap throttles scrolling without saving the
// agent any work. Scale with the gesture instead and allow up to a screenful,
// which keeps a fast flick fast while a single tick still moves three rows for
// fine control. The floor keeps narrow panes usable.
const TRANSCRIPT_ROWS_PER_WHEEL_STEP = 3;
const MIN_TRANSCRIPT_ROWS_PER_BURST = 12;

// Most rows any single burst may move: a screenful, floored so narrow panes
// still scroll usefully.
export function transcriptBurstCap(paneRows: number): number {
  const screenful = Math.max(1, Math.floor(paneRows) - 2);
  return Math.max(MIN_TRANSCRIPT_ROWS_PER_BURST, screenful);
}

export function transcriptBurstRows(steps: number, paneRows: number): number {
  const requested =
    Math.max(1, Math.floor(steps)) * TRANSCRIPT_ROWS_PER_WHEEL_STEP;
  return Math.min(transcriptBurstCap(paneRows), requested);
}
// Upper bound on how long the panel keeps presenting the last stable frame
// while the pager opens or closes. Real transitions finish in tens of
// milliseconds; the cap only exists so a wedged pager can never freeze the
// pane.
const TRANSCRIPT_TRANSITION_MAX_HOLD_MS = 500;
// tmux updates a detached session's PTY size while a new client attaches, but
// some long-lived TUIs miss that attach-time SIGWINCH and keep their composer
// anchored to the old bottom row. Re-signal after ownership/geometry settle.
const PERSISTENT_TUI_REDRAW_DELAY_MS = 400;
// How often a scrolled persistent pane re-reads its tmux copy-mode offset, and
// how many unchanged samples end the poll. Four ticks matches silvery's
// SCROLLBAR_FADE_AFTER_MS (800ms) so the poll and the highlight fade retire
// together and a pane parked in scrollback costs nothing.
const SCROLL_POLL_MS = 200;
const SCROLL_POLL_IDLE_TICKS = 4;
const SCROLL_HIGHLIGHT_MS = 800;

function transcriptWheelKeys(
  direction: "up" | "down",
  steps: number,
  paneRows: number
): string {
  const rows = transcriptBurstRows(steps, paneRows);
  return (direction === "up" ? "\x1b[A" : "\x1b[B").repeat(rows);
}

export class TerminalPanel implements TerminalReadable {
  private readonly traceId = ++tracePanelCounter;
  private terminal: Terminal;
  private child?: ReturnType<typeof Bun.spawn>;
  private pty?: Bun.Terminal;
  private updateRevision = ++revisionCounter;
  private listeners = new Set<() => void>();
  private followOutput = true;
  private tmuxCopyModePossible = false;
  private transcriptWheelOpen = false;
  private transcriptWheelClosing = false;
  private transcriptWheelMovingDown = false;
  private transcriptWheelDebt = 0;
  // Scroll rows queued while the pager is still starting. Codex silently
  // discards arrow keys that arrive in the same instant as the opening Ctrl+T,
  // so the rows are flushed only once the pager header is on screen.
  private transcriptPendingRows = 0;
  // Wheel-up steps that arrived while the pager was closing. Dropping them
  // makes a direction reversal feel dead; instead the pager reopens with these
  // steps once the close resolves.
  private transcriptReopenSteps = 0;
  private pendingTranscriptInput = "";
  private transcriptWheelSettle?: ReturnType<typeof setTimeout>;
  // While set, onWriteParsed keeps presenting the last stable frame: the
  // cleared alternate screen of an opening pager and the stale primary screen
  // of a closing one must never paint (they read as a flash / blank pane).
  private transcriptFrameHold?: "close" | "open";
  private transcriptFrameHoldTimer?: ReturnType<typeof setTimeout>;
  private synchronizedOutputRecovery?: ReturnType<typeof setTimeout>;
  private persistentTuiRedrawTimer?: ReturnType<typeof setTimeout>;
  private resizeGeneration = 0;
  private resizeScheduled = false;
  private tmuxNativeMouseCache?: { active: boolean; at: number };
  // Scroll-indicator state. `scrollHighlight` only changes the thumb's color, so
  // its timer fires once per gesture rather than driving visibility.
  private scrollPollTimer?: ReturnType<typeof setTimeout>;
  private scrollHighlightTimer?: ReturnType<typeof setTimeout>;
  private scrollPollIdleTicks = 0;
  private scrollHighlight = false;
  private transcriptPercent?: number;
  private tmuxScroll?: TmuxScrollPosition;
  private pendingResize?: {
    cols: number;
    generation: number;
    rows: number;
  };

  constructor(
    private readonly cwd: string,
    cols: number,
    rows: number,
    private readonly options: TerminalPanelOptions = {}
  ) {
    this.terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 1000,
      logLevel: "off",
      theme: {
        background: "#161618",
        foreground: "#e4e2dc",
      },
    });
    terminalTrace("panel-create", {
      cols,
      panel: this.traceId,
      persistent: Boolean(this.options.persist),
      rows,
    });
    this.terminal.onWriteParsed(() => {
      this.snapFollowingViewportToBottom();
      this.traceBuffer("panel-parse");
      // Full-screen TUIs such as Codex wrap redraws in synchronized-output mode
      // (DEC private mode 2026). Do not expose partially parsed frames while the
      // mode is active; repaint once the closing sequence has been processed.
      // Rendering every PTY chunk defeats the mode and produces transient stale
      // borders/text ("artifacts") during Codex's frequent composer redraws.
      if (this.terminal.modes.synchronizedOutputMode) {
        this.scheduleSynchronizedOutputRecovery();
        return;
      }
      this.clearSynchronizedOutputRecovery();
      // The pager footer carries the only scroll position Codex publishes. Read
      // it before the transition branches below, which can return early, so the
      // indicator always rides a frame that is being published anyway.
      if (this.transcriptWheelOpen) {
        this.transcriptPercent = parseTranscriptPercent(this.viewportRows());
      }
      if (this.transcriptWheelClosing && !this.transcriptVisible()) {
        this.finishTranscriptClose();
      }
      if (this.transcriptFrameHold === "open" && this.transcriptVisible()) {
        // The pager has painted: deliver the queued scroll rows (sending them
        // earlier loses them in the pager's startup window) and reveal it.
        const rows = this.transcriptPendingRows;
        this.transcriptPendingRows = 0;
        if (rows > 0) {
          this.writeToChild("\x1b[A".repeat(rows));
        }
        this.releaseTranscriptFrameHold();
        return;
      }
      if (
        this.transcriptWheelOpen &&
        this.transcriptWheelMovingDown &&
        this.transcriptAtBottom()
      ) {
        this.scheduleTranscriptWheelClose(false);
      }
      if (this.transcriptFrameHold) {
        // Mid-transition: keep the last stable frame on screen instead of the
        // half-switched buffer. The hold is released by the branches above or
        // by its bounded timer.
        return;
      }
      this.publishFrame();
    });
  }

  // A pager close resolved (its header left the screen) or timed out: deliver
  // input the user typed while it was closing, reveal the restored composer,
  // and honor a wheel-up reversal that arrived mid-close by reopening.
  private finishTranscriptClose() {
    this.transcriptWheelClosing = false;
    const pendingInput = this.pendingTranscriptInput;
    this.pendingTranscriptInput = "";
    if (pendingInput) {
      // Typed input wins over a queued scroll reversal: the user decided to
      // return to the composer.
      this.transcriptReopenSteps = 0;
      this.writeToChild(pendingInput);
    }
    const reopenSteps = this.transcriptReopenSteps;
    this.transcriptReopenSteps = 0;
    if (reopenSteps > 0) {
      this.transcriptWheelOpen = true;
      this.transcriptWheelMovingDown = false;
      this.transcriptWheelDebt += reopenSteps;
      this.transcriptPendingRows = transcriptBurstRows(
        reopenSteps,
        this.terminal.rows
      );
      this.writeToChild("\x14");
      this.beginTranscriptFrameHold("open");
      return;
    }
    this.releaseTranscriptFrameHold();
  }

  private beginTranscriptFrameHold(kind: "close" | "open") {
    this.transcriptFrameHold = kind;
    if (this.transcriptFrameHoldTimer) {
      clearTimeout(this.transcriptFrameHoldTimer);
    }
    this.transcriptFrameHoldTimer = setTimeout(() => {
      this.transcriptFrameHoldTimer = undefined;
      // Never freeze the pane: resolve whatever transition state remains and
      // show the real buffer, even if the pager misbehaved.
      this.transcriptPendingRows = 0;
      if (this.transcriptWheelClosing) {
        this.finishTranscriptClose();
      }
      this.releaseTranscriptFrameHold();
    }, TRANSCRIPT_TRANSITION_MAX_HOLD_MS);
    this.transcriptFrameHoldTimer.unref?.();
  }

  private releaseTranscriptFrameHold() {
    if (this.transcriptFrameHold === undefined) {
      return;
    }
    this.transcriptFrameHold = undefined;
    if (this.transcriptFrameHoldTimer) {
      clearTimeout(this.transcriptFrameHoldTimer);
      this.transcriptFrameHoldTimer = undefined;
    }
    this.publishFrame();
  }

  private publishFrame() {
    this.updateRevision = ++revisionCounter;
    this.emit();
  }

  private scheduleSynchronizedOutputRecovery() {
    // A legitimate synchronized redraw can span several PTY chunks. Restart
    // the timer for each parsed chunk so an active redraw is never exposed
    // halfway through. If the closing marker was interrupted, end the stale
    // local mode after the stream has gone quiet; the resulting parse event
    // publishes the recovered frame and restores normal updates.
    this.clearSynchronizedOutputRecovery();
    this.synchronizedOutputRecovery = setTimeout(() => {
      this.synchronizedOutputRecovery = undefined;
      if (this.terminal.modes.synchronizedOutputMode) {
        this.terminal.write("\x1b[?2026l");
      }
    }, SYNCHRONIZED_OUTPUT_RECOVERY_IDLE_MS);
    this.synchronizedOutputRecovery.unref?.();
  }

  private clearSynchronizedOutputRecovery() {
    if (!this.synchronizedOutputRecovery) {
      return;
    }
    clearTimeout(this.synchronizedOutputRecovery);
    this.synchronizedOutputRecovery = undefined;
  }

  // Subscribe to panel updates (output, resize, scroll). The rendered
  // <Terminal> subscribes so terminal output repaints only its own subtree
  // instead of forcing a full-app re-render. Returns an unsubscribe fn.
  // Arrow property so it can be passed straight to useSyncExternalStore.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Read the current revision (useSyncExternalStore snapshot).
  getSnapshot = (): number => this.updateRevision;

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  get cols() {
    return this.terminal.cols;
  }

  get rows() {
    return this.terminal.rows;
  }

  // Bump the revision so the next render redraws this panel even though it
  // didn't emit output (used when it becomes the active pane). The tab switch
  // that calls this already re-renders the grid, which reads the new snapshot.
  touch() {
    this.updateRevision = ++revisionCounter;
  }

  usesAlternateBuffer() {
    return this.terminal.buffer.active.type === "alternate";
  }

  hasMouseTracking() {
    return this.terminal.modes.mouseTrackingMode !== "none";
  }

  private get persist() {
    return this.options.persist && hasTmux() ? this.options.persist : undefined;
  }

  start() {
    if (this.child) {
      return;
    }
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const shell = Bun.env.SHELL ?? "/bin/bash";
    const inner =
      this.options.command ?? interactiveShellCommand(shell, this.cwd);

    // Build the command the shell runs inside the PTY. `exec` replaces the
    // shell so signals and exit codes pass straight through to the child / tmux
    // client. The PTY winsize is set by Bun.Terminal, so no stty is needed.
    let command: string;
    const env: Record<string, string> = {
      ...Bun.env,
      ...this.options.env,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
    };
    if (this.options.env?.FORCE_COLOR) {
      // Harnesses opt into color explicitly; a parent-shell NO_COLOR would
      // otherwise win in many CLI color detectors.
      delete env.NO_COLOR;
    }
    const persist = this.persist;
    if (persist) {
      restartServerIfPermissionStale(persist.socketPath, this.cwd);
      configureExistingTmuxServer(persist.socketPath);
      // Run inside (or re-attach to) a persistent tmux session on a dedicated
      // socket. -A attaches if it exists, otherwise creates it and runs `inner`.
      // Drop TMUX so our private server never collides with an outer tmux the
      // editor itself may be running inside.
      delete env.TMUX;
      delete env.TMUX_PANE;
      const envFlags = Object.entries(this.options.env ?? {})
        .map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
        .join(" ");
      const tmux = [
        `tmux -S ${shellQuote(persist.socketPath)} -f ${shellQuote(ensureTmuxConf())} new-session -A -D`,
        `-s ${shellQuote(persist.name)}`,
        `-x ${cols} -y ${rows}`,
        // The private tmux server is shared by every workspace. Pass the pane
        // start directory explicitly so tmux never inherits another client's
        // cwd when it creates this session.
        `-c ${shellQuote(this.cwd)}`,
        envFlags,
        shellQuote(inner),
      ]
        .filter(Boolean)
        .join(" ");
      command = `exec ${tmux}`;
    } else {
      command = inner;
    }

    // Attach a real pseudo-terminal so the child sees a TTY (colors, cursor
    // control, raw input). Bun.Terminal wraps openpty() on Linux and macOS,
    // replacing the old `script(1)` shim whose flags and stdin-must-be-a-tty
    // requirement differed between util-linux and BSD (the latter failed with
    // `tcgetattr/ioctl: Operation not supported on socket`).
    const pty = new Bun.Terminal({
      cols,
      rows,
      name: "xterm-256color",
      data: (_pty, bytes) => {
        terminalTrace("panel-pty", {
          bytes: bytes.byteLength,
          panel: this.traceId,
        });
        this.terminal.write(bytes);
      },
    });
    this.pty = pty;
    const argv = hasSetsid()
      ? ["setsid", "-c", "/bin/sh", "-c", command]
      : ["/bin/sh", "-c", command];
    this.child = Bun.spawn(argv, {
      cwd: this.cwd,
      env,
      terminal: pty,
    });
    this.schedulePersistentTuiRedraw();
  }

  resize(cols: number, rows: number) {
    terminalTrace("panel-resize-request", {
      cols,
      panel: this.traceId,
      rows,
    });
    if (this.pendingResize?.cols === cols && this.pendingResize.rows === rows) {
      return;
    }
    if (
      !this.pendingResize &&
      cols === this.terminal.cols &&
      rows === this.terminal.rows
    ) {
      return;
    }
    const generation = ++this.resizeGeneration;
    this.pendingResize = { cols, generation, rows };
    if (this.resizeScheduled) {
      return;
    }
    this.resizeScheduled = true;
    queueMicrotask(() => {
      this.resizeScheduled = false;
      const pending = this.pendingResize;
      this.pendingResize = undefined;
      // Only the newest layout generation may resize xterm and the child PTY.
      // Older effects can still run after a newer React layout has committed;
      // dropping them here prevents multiple SIGWINCH redraws at stale sizes.
      if (!pending || pending.generation !== this.resizeGeneration) {
        return;
      }
      if (
        pending.cols === this.terminal.cols &&
        pending.rows === this.terminal.rows
      ) {
        return;
      }
      this.terminal.resize(pending.cols, pending.rows);
      this.snapFollowingViewportToBottom();
      // Propagate the winning generation so the program (or tmux client) gets
      // one SIGWINCH and reflows to the same dimensions as the rendered box.
      this.pty?.resize(pending.cols, pending.rows);
      this.schedulePersistentTuiRedraw();
      this.updateRevision = ++revisionCounter;
      this.emit();
    });
  }

  scrollLines(lines: number) {
    terminalTrace("panel-scroll", { lines, panel: this.traceId });
    this.terminal.scrollLines(lines);
    this.updateFollowOutput();
    // The local mirror already bumps a revision, so the indicator repaints for
    // free — only the highlight needs arming.
    this.markScrollActive();
    this.updateRevision = ++revisionCounter;
    this.emit();
  }

  scrollPages(pages: number) {
    this.terminal.scrollPages(pages);
    this.updateFollowOutput();
    this.markScrollActive();
    this.updateRevision = ++revisionCounter;
    this.emit();
  }

  scrollToBottom() {
    this.followOutput = true;
    this.terminal.scrollToBottom();
    this.updateRevision = ++revisionCounter;
    this.emit();
  }

  write(data: string) {
    // Safety net: a keystroke should never hit a dead panel even if the
    // resize-driven lazy start has not fired yet.
    if (!this.child) {
      this.start();
    }
    this.snapToBottomIfScrolled();
    this.exitTmuxCopyModeIfNeeded();
    if (this.exitWheelTranscript(data)) {
      return;
    }
    this.writeToChild(data);
  }

  // Forward pasted text to the child PTY. Silvery captures bracketed paste on
  // the OUTER terminal and hands us the plain text via useInput's onPaste; we
  // re-emit it to the inner program. When that program has bracketed paste
  // enabled (DEC 2004), wrap the payload so it's treated as a paste (no
  // auto-run of embedded newlines); otherwise translate newlines to CR like a
  // terminal emulator so a shell executes pasted lines.
  paste(text: string) {
    if (!text) {
      return;
    }
    if (!this.child) {
      this.start();
    }
    this.snapToBottomIfScrolled();
    this.exitTmuxCopyModeIfNeeded();
    const formatted = this.formatPaste(text);
    if (this.exitWheelTranscript(formatted)) {
      return;
    }
    this.writeToChild(formatted);
  }

  // Re-anchor the viewport to the bottom on user input. Without this, scrolling
  // up (wheel/PageUp over a primary-buffer pane) parks `viewportY` above
  // `baseY`, and since xterm only auto-scrolls when already at the bottom, the
  // prompt — anchored to the bottom — drifts downward off the pane as the
  // program keeps emitting output. Snapping on every keystroke/paste matches
  // every real terminal: typing means you're done reading, so jump to the
  // prompt. No-op (and free) when already at the bottom or on the alternate
  // buffer, where `viewportY === baseY === 0`.
  private snapToBottomIfScrolled() {
    this.followOutput = true;
    if (this.snapFollowingViewportToBottom()) {
      this.updateRevision = ++revisionCounter;
      this.emit();
    }
  }

  private snapFollowingViewportToBottom(): boolean {
    if (!this.followOutput) {
      return false;
    }
    const buffer = this.terminal.buffer.active;
    if (buffer.viewportY >= buffer.baseY) {
      return false;
    }
    this.terminal.scrollToBottom();
    return true;
  }

  private updateFollowOutput() {
    const buffer = this.terminal.buffer.active;
    this.followOutput = buffer.viewportY >= buffer.baseY;
  }

  private formatPaste(text: string): string {
    if (this.terminal.modes.bracketedPasteMode) {
      // Strip any end marker in the payload so a paste can't terminate
      // bracketed mode early (and smuggle following bytes as real keystrokes).
      const safe = text.replaceAll("\x1b[201~", "");
      return `\x1b[200~${safe}\x1b[201~`;
    }
    return text.replace(/\r\n?|\n/g, "\r");
  }

  sendViewportKey(data: string): boolean {
    if (
      this.options.wheelNavigation === "transcript" &&
      (this.transcriptWheelOpen || this.transcriptWheelClosing)
    ) {
      if (!this.child) {
        this.start();
      }
      if (
        this.transcriptWheelOpen &&
        /^(?:\x1b\[[ABHF]|\x1b\[[56]~)$/.test(data)
      ) {
        this.writeToChild(data);
      } else {
        this.exitWheelTranscript(data);
      }
      return true;
    }
    if (!(this.usesAlternateBuffer() || this.hasMouseTracking())) {
      return false;
    }
    if (!this.child) {
      this.start();
    }
    this.writeToChild(data);
    return true;
  }

  // Forward a wheel gesture as `count` SGR reports in a single PTY write.
  // Silvery coalesces same-direction wheel bursts into one event whose delta
  // carries the accumulated step count; emitting one report per event would
  // silently shrink fast flicks. tmux copy-mode then never scrolls back far
  // enough to exit at the bottom, leaving the pane parked in scrollback with
  // the composer out of view.
  sendMouseWheel(
    col: number,
    row: number,
    direction: "up" | "down",
    count = 1
  ): boolean {
    // Prefer the application's native mouse protocol when an alternate-screen
    // TUI is active. tmux itself advertises mouse tracking even when its child
    // is an older inline Codex, so mouse mode alone cannot distinguish them.
    // Once the inline transcript fallback opens, keep routing through it until
    // it closes even though that overlay temporarily enters the alternate
    // screen.
    if (
      this.options.wheelNavigation === "transcript" &&
      (this.transcriptWheelOpen ||
        this.transcriptWheelClosing ||
        !this.childUsesNativeMouse())
    ) {
      const steps = Math.max(1, Math.floor(count));
      if (this.transcriptWheelClosing) {
        if (direction === "up") {
          // A reversal mid-close must not vanish: reopen once the close
          // resolves so the gesture still lands.
          this.transcriptReopenSteps += steps;
        }
        return true;
      }
      let data = "";
      if (direction === "up") {
        this.transcriptWheelMovingDown = false;
        this.transcriptWheelDebt += steps;
        this.clearTranscriptWheelSettle();
        if (
          this.transcriptPendingRows > 0 ||
          this.transcriptFrameHold === "open"
        ) {
          // The pager is still starting; keys written now would be discarded.
          // Fold this gesture into the queued rows instead.
          this.transcriptPendingRows = Math.min(
            transcriptBurstCap(this.terminal.rows),
            this.transcriptPendingRows +
              transcriptBurstRows(steps, this.terminal.rows)
          );
        } else if (this.transcriptWheelOpen || this.transcriptVisible()) {
          data += transcriptWheelKeys("up", steps, this.terminal.rows);
        } else {
          // Open the pager with Ctrl+T alone. Codex discards arrow keys that
          // arrive during the pager's startup window, so the scroll rows are
          // queued and flushed once the header paints (onWriteParsed).
          data += "\x14";
          this.transcriptPendingRows = transcriptBurstRows(
            steps,
            this.terminal.rows
          );
          this.beginTranscriptFrameHold("open");
        }
        this.transcriptWheelOpen = true;
      } else if (this.transcriptWheelOpen) {
        this.transcriptWheelMovingDown = true;
        this.transcriptWheelDebt = Math.max(
          0,
          this.transcriptWheelDebt - steps
        );
        if (
          this.transcriptPendingRows > 0 ||
          this.transcriptFrameHold === "open"
        ) {
          // Still starting: shrink the queued rows instead of writing keys
          // the pager would discard. The at-bottom grep is also unreliable
          // here — the primary screen may contain a literal "100%".
          this.transcriptPendingRows = Math.max(
            0,
            this.transcriptPendingRows -
              transcriptBurstRows(steps, this.terminal.rows)
          );
          if (this.transcriptWheelDebt === 0) {
            this.scheduleTranscriptWheelClose(true);
          }
        } else if (
          this.transcriptWheelDebt === 0 ||
          this.transcriptAtBottom()
        ) {
          this.scheduleTranscriptWheelClose(true);
        } else {
          data = transcriptWheelKeys("down", steps, this.terminal.rows);
          this.scheduleTranscriptWheelClose(true);
        }
      }
      terminalTrace("panel-wheel", {
        direction,
        navigation: "transcript",
        panel: this.traceId,
        transcriptOpen: this.transcriptWheelOpen,
        steps,
        wheelDebt: this.transcriptWheelDebt,
      });
      if (!data) {
        return true;
      }
      if (!this.child) {
        this.start();
      }
      this.writeToChild(data);
      return true;
    }
    if (!this.hasMouseTracking()) {
      return false;
    }
    const steps = Math.max(1, Math.floor(count));
    terminalTrace("panel-wheel", {
      col,
      direction,
      panel: this.traceId,
      row,
      steps,
    });
    if (!this.child) {
      this.start();
    }
    // tmux enters copy mode on wheel-up when the pane itself is not tracking
    // the mouse. Remember that possibility so the next real input can return
    // to the live pane before forwarding the key or paste.
    if (direction === "up" && this.persist) {
      this.tmuxCopyModePossible = true;
    }
    const button = direction === "up" ? 64 : 65;
    const report = `\x1b[<${button};${Math.max(1, Math.floor(col) + 1)};${Math.max(1, Math.floor(row) + 1)}M`;
    this.writeToChild(report.repeat(steps));
    // tmux may have entered copy-mode for this gesture; track its offset so the
    // pane can show a thumb. No-op for panes without a persistent session.
    this.beginScrollTracking();
    return true;
  }

  private childUsesNativeMouse(): boolean {
    const persist = this.options.persist;
    if (!persist) {
      return this.usesAlternateBuffer() && this.hasMouseTracking();
    }
    const now = performance.now();
    if (
      this.tmuxNativeMouseCache &&
      now - this.tmuxNativeMouseCache.at < TMUX_MOUSE_MODE_CACHE_MS
    ) {
      return this.tmuxNativeMouseCache.active;
    }
    try {
      const result = Bun.spawnSync(
        [
          "tmux",
          "-S",
          persist.socketPath,
          "display-message",
          "-p",
          "-t",
          persist.name,
          "#{alternate_on} #{mouse_any_flag}",
        ],
        { stderr: "ignore", stdout: "pipe" }
      );
      if (result.exitCode === 0) {
        const active = new TextDecoder().decode(result.stdout).trim() === "1 1";
        this.tmuxNativeMouseCache = { active, at: now };
        return active;
      }
    } catch {
      // Fall through to xterm's view when the private tmux server disappears.
    }
    return this.usesAlternateBuffer() && this.hasMouseTracking();
  }

  private exitTmuxCopyModeIfNeeded() {
    if (!this.tmuxCopyModePossible) {
      return;
    }
    this.tmuxCopyModePossible = false;
    const persist = this.persist;
    if (!persist) {
      return;
    }
    try {
      Bun.spawnSync(
        [
          "tmux",
          "-S",
          persist.socketPath,
          "copy-mode",
          "-q",
          "-t",
          persist.name,
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
    } catch {
      // The session may have exited between the wheel and the next input.
    }
    // The pane is back at the live edge, so retire the poll and the thumb.
    this.stopScrollTracking();
  }

  // A wheel-opened Codex transcript must close before composer input. Consume
  // Escape as "close transcript" and let an explicit Ctrl+T close it directly;
  // ordinary typing closes the overlay first, then reaches the composer.
  private exitWheelTranscript(data?: string): boolean {
    if (this.transcriptWheelClosing) {
      if (data && data !== "\x1b" && data !== "\x14") {
        this.pendingTranscriptInput += data;
      }
      return true;
    }
    if (!this.transcriptWheelOpen) {
      return false;
    }
    this.transcriptWheelOpen = false;
    this.transcriptWheelClosing = true;
    this.transcriptWheelMovingDown = false;
    this.transcriptWheelDebt = 0;
    this.transcriptPendingRows = 0;
    this.clearTranscriptWheelSettle();
    this.beginTranscriptFrameHold("close");
    if (data === "\x14") {
      this.writeToChild(data);
      return true;
    }
    this.writeToChild("\x14");
    if (data && data !== "\x1b") {
      this.pendingTranscriptInput += data;
    }
    return true;
  }

  private closeWheelTranscript() {
    this.transcriptWheelOpen = false;
    this.transcriptWheelClosing = true;
    this.transcriptWheelMovingDown = false;
    this.transcriptWheelDebt = 0;
    this.transcriptPendingRows = 0;
    this.clearTranscriptWheelSettle();
    this.beginTranscriptFrameHold("close");
    this.writeToChild("\x14");
  }

  private scheduleTranscriptWheelClose(reset: boolean) {
    if (reset) {
      this.clearTranscriptWheelSettle();
    } else if (this.transcriptWheelSettle) {
      return;
    }
    this.transcriptWheelSettle = setTimeout(() => {
      this.transcriptWheelSettle = undefined;
      if (
        this.transcriptWheelOpen &&
        this.transcriptWheelMovingDown &&
        (this.transcriptWheelDebt === 0 || this.transcriptAtBottom())
      ) {
        this.closeWheelTranscript();
      }
    }, TRANSCRIPT_WHEEL_SETTLE_MS);
    this.transcriptWheelSettle.unref?.();
  }

  private clearTranscriptWheelSettle() {
    if (!this.transcriptWheelSettle) {
      return;
    }
    clearTimeout(this.transcriptWheelSettle);
    this.transcriptWheelSettle = undefined;
  }

  // Visible rows of the bottom page, as plain text.
  private viewportRows(): string[] {
    const buffer = this.terminal.buffer.active;
    const rows: string[] = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      rows.push(
        buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ""
      );
    }
    return rows;
  }

  private transcriptVisible(): boolean {
    const buffer = this.terminal.buffer.active;
    for (let row = 0; row < this.terminal.rows; row += 1) {
      if (
        buffer
          .getLine(buffer.baseY + row)
          ?.translateToString(true)
          .includes("T R A N S C R I P T")
      ) {
        return true;
      }
    }
    return false;
  }

  private transcriptAtBottom(): boolean {
    const buffer = this.terminal.buffer.active;
    for (let row = 0; row < this.terminal.rows; row += 1) {
      if (
        /(?:^|\s)100%(?:\s|$)/.test(
          buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ""
        )
      ) {
        return true;
      }
    }
    return false;
  }

  // Thumb geometry for the pane's scroll overlay, or undefined when this pane
  // has no readable scroll position (an alternate-screen CLI that owns the
  // mouse scrolls itself and reports nothing) or is sitting at the live edge.
  scrollIndicator(): (ScrollThumb & { active: boolean }) | undefined {
    const thumb = scrollThumb(this.terminal.rows, this.scrollPosition());
    if (!thumb) {
      return;
    }
    return { ...thumb, active: this.scrollHighlight };
  }

  private scrollPosition(): PaneScrollPosition | undefined {
    // 1. Codex's transcript pager: a percentage is all it publishes.
    if (
      this.options.wheelNavigation === "transcript" &&
      this.transcriptWheelOpen &&
      this.transcriptPercent !== undefined
    ) {
      return {
        approximate: true,
        offsetRows: this.transcriptPercent,
        scrollableRows: 100,
        source: "transcript",
      };
    }
    // 2. tmux copy-mode owns scrolling for persistent panes whose program is
    //    not mouse-aware; `scrollPosition` counts rows up from the bottom.
    const tmux = this.tmuxScroll;
    if (tmux) {
      return {
        approximate: false,
        offsetRows: Math.max(0, tmux.historySize - tmux.scrollPosition),
        scrollableRows: tmux.historySize,
        source: "tmux",
      };
    }
    // 3. Our own xterm mirror, for non-persistent panes. `followOutput` is
    //    false exactly when the user scrolled it via scrollLines/scrollPages.
    const buffer = this.terminal.buffer.active;
    if (!this.followOutput && buffer.baseY > 0) {
      return {
        approximate: false,
        offsetRows: buffer.viewportY,
        scrollableRows: buffer.baseY,
        source: "xterm",
      };
    }
    return;
  }

  // Light up the thumb while a scroll gesture is in flight, then dim it. This
  // only changes color, so it fires once per gesture and never re-arms itself.
  private markScrollActive() {
    if (!this.scrollHighlight) {
      this.scrollHighlight = true;
      this.publishFrame();
    }
    if (this.scrollHighlightTimer) {
      clearTimeout(this.scrollHighlightTimer);
    }
    this.scrollHighlightTimer = setTimeout(() => {
      this.scrollHighlightTimer = undefined;
      this.scrollHighlight = false;
      this.publishFrame();
    }, SCROLL_HIGHLIGHT_MS);
    this.scrollHighlightTimer.unref?.();
  }

  // Track a persistent pane's tmux copy-mode offset while it is scrolling.
  // Read-only, async, and self-retiring: after SCROLL_POLL_IDLE_TICKS samples
  // that do not move the thumb it stops instead of re-arming, so an idle or
  // parked pane spawns nothing.
  private beginScrollTracking() {
    this.markScrollActive();
    const persist = this.persist;
    if (!persist || this.scrollPollTimer) {
      return;
    }
    this.scrollPollIdleTicks = 0;
    const tick = async () => {
      this.scrollPollTimer = undefined;
      const next = await tmuxScrollPosition(persist.socketPath, persist.name);
      // The pane may have been detached while the query was in flight.
      if (!this.pty) {
        return;
      }
      const before = this.scrollIndicator();
      this.tmuxScroll = next;
      const after = this.scrollIndicator();
      if (sameScrollThumb(before, after)) {
        this.scrollPollIdleTicks += 1;
        if (this.scrollPollIdleTicks >= SCROLL_POLL_IDLE_TICKS) {
          return;
        }
      } else {
        this.scrollPollIdleTicks = 0;
        this.publishFrame();
      }
      this.scrollPollTimer = setTimeout(tick, SCROLL_POLL_MS);
      this.scrollPollTimer.unref?.();
    };
    this.scrollPollTimer = setTimeout(tick, SCROLL_POLL_MS);
    this.scrollPollTimer.unref?.();
  }

  private stopScrollTracking() {
    if (this.scrollPollTimer) {
      clearTimeout(this.scrollPollTimer);
      this.scrollPollTimer = undefined;
    }
    this.scrollPollIdleTicks = 0;
    if (this.tmuxScroll) {
      this.tmuxScroll = undefined;
      this.publishFrame();
    }
  }

  private writeToChild(data: string) {
    this.pty?.write(data);
  }

  private schedulePersistentTuiRedraw() {
    const persist = this.persist;
    if (!(persist && this.options.command)) {
      return;
    }
    if (this.persistentTuiRedrawTimer) {
      clearTimeout(this.persistentTuiRedrawTimer);
    }
    this.persistentTuiRedrawTimer = setTimeout(() => {
      this.persistentTuiRedrawTimer = undefined;
      try {
        const result = Bun.spawnSync(
          [
            "tmux",
            "-S",
            persist.socketPath,
            "display-message",
            "-p",
            "-t",
            persist.name,
            "#{pane_pid}",
          ],
          { stderr: "ignore", stdout: "pipe" }
        );
        const panePid = Number(new TextDecoder().decode(result.stdout).trim());
        if (
          result.exitCode === 0 &&
          Number.isSafeInteger(panePid) &&
          panePid > 1
        ) {
          // Harness commands run as the pane's process group, so the signal
          // reaches the foreground TUI rather than only its shell wrapper.
          process.kill(-panePid, "SIGWINCH");
        }
      } catch {
        // The pane may have closed or changed owner before the delayed redraw.
      }
    }, PERSISTENT_TUI_REDRAW_DELAY_MS);
    this.persistentTuiRedrawTimer.unref?.();
  }

  getLines(): readonly (readonly TerminalCell[])[] {
    const buffer = this.terminal.buffer.active;
    const start = buffer.viewportY;
    const rows: TerminalCell[][] = [];
    const workCell = buffer.getNullCell();

    for (let row = 0; row < this.terminal.rows; row++) {
      const line = buffer.getLine(start + row);
      const cells: TerminalCell[] = [];
      for (let col = 0; col < this.terminal.cols; col++) {
        const cell = line?.getCell(col, workCell);
        cells.push(cell ? terminalCell(cell) : blankCell());
      }
      rows.push(cells);
    }
    if (terminalTraceEnabled()) {
      const rowIds: number[] = [];
      for (let row = 0; row < this.terminal.rows; row += 1) {
        const fingerprint =
          buffer
            .getLine(start + row)
            ?.translateToString(false, 0, this.terminal.cols) ?? "";
        rowIds.push(terminalTraceRowId(fingerprint));
      }
      terminalTrace("panel-snapshot", {
        baseY: buffer.baseY,
        panel: this.traceId,
        revision: this.updateRevision,
        rowIds,
        viewportY: buffer.viewportY,
      });
      terminalTracePresentedPanel(this.traceId, this.updateRevision, rowIds);
    }
    return rows;
  }

  private traceBuffer(event: string) {
    if (!terminalTraceEnabled()) {
      return;
    }
    const buffer = this.terminal.buffer.active;
    terminalTrace(event, {
      baseY: buffer.baseY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      panel: this.traceId,
      synchronizedOutput: this.terminal.modes.synchronizedOutputMode,
      viewportY: buffer.viewportY,
    });
  }

  getCursor(): TerminalCursor {
    const buffer = this.terminal.buffer.active;
    // `getLines()` renders starting at `viewportY`, but xterm reports `cursorY`
    // relative to `baseY` (the bottom page). Translate into a row within the
    // rendered viewport so the caret tracks the real cell even while the user
    // has scrolled up through scrollback.
    const y = buffer.cursorY + (buffer.baseY - buffer.viewportY);
    const onScreen = y >= 0 && y < this.terminal.rows;
    return {
      x: buffer.cursorX,
      y,
      // Honor the focused program's DECTCEM state. Many full-screen CLIs (and
      // tmux) hide the cursor while redrawing/streaming and leave it parked at
      // a resting spot (often the bottom-left); hardcoding `visible: true` drew
      // a stale caret there. Also hide it when scrolled out of the viewport.
      visible: onScreen && !this.isCursorHidden(),
    };
  }

  // xterm-headless has no public getter for DECTCEM (`CSI ?25 h/l`) state, so
  // read it off the core service. Defensive: any shape change just falls back
  // to "visible" rather than throwing.
  private isCursorHidden(): boolean {
    const core = (
      this.terminal as unknown as {
        _core?: { coreService?: { isCursorHidden?: boolean } };
      }
    )._core;
    return core?.coreService?.isCursorHidden === true;
  }

  // Stop our local view of the PTY. With a persistent (tmux) panel this only
  // detaches the client; the session keeps running for the next launch.
  detach() {
    this.clearSynchronizedOutputRecovery();
    this.clearTranscriptWheelSettle();
    if (this.transcriptFrameHoldTimer) {
      clearTimeout(this.transcriptFrameHoldTimer);
      this.transcriptFrameHoldTimer = undefined;
    }
    this.transcriptFrameHold = undefined;
    this.transcriptWheelOpen = false;
    this.transcriptWheelClosing = false;
    this.transcriptWheelMovingDown = false;
    this.transcriptWheelDebt = 0;
    this.transcriptPendingRows = 0;
    this.transcriptReopenSteps = 0;
    this.pendingTranscriptInput = "";
    if (this.persistentTuiRedrawTimer) {
      clearTimeout(this.persistentTuiRedrawTimer);
      this.persistentTuiRedrawTimer = undefined;
    }
    if (this.scrollPollTimer) {
      clearTimeout(this.scrollPollTimer);
      this.scrollPollTimer = undefined;
    }
    if (this.scrollHighlightTimer) {
      clearTimeout(this.scrollHighlightTimer);
      this.scrollHighlightTimer = undefined;
    }
    this.scrollPollIdleTicks = 0;
    this.scrollHighlight = false;
    this.transcriptPercent = undefined;
    this.tmuxScroll = undefined;
    // The next attach repaints the live screen, so a viewport the user had
    // parked in local scrollback must not survive as a stale scroll position.
    this.followOutput = true;
    this.pendingResize = undefined;
    this.resizeGeneration += 1;
    try {
      this.child?.kill();
    } catch {
      // Ignore shutdown races.
    }
    try {
      this.pty?.close();
    } catch {
      // Ignore shutdown races.
    }
    this.child = undefined;
    this.pty = undefined;
  }

  // Permanently tear down the panel, including its persistent tmux session.
  kill() {
    killPersistentTmuxSession(this.persist);
    this.detach();
  }
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function terminalCell(cell: IBufferCell): TerminalCell {
  let fg = cellColor(cell, "fg");
  let bg = cellColor(cell, "bg");
  if (cell.isInverse()) {
    [fg, bg] = [bg ?? TERM_BG(), fg ?? TERM_FG()];
  }
  const width = cell.getWidth();
  return {
    char: cell.getChars() || " ",
    fg: fg ?? null,
    bg: bg ?? null,
    bold: !!cell.isBold(),
    dim: PRESERVE_DIM && !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    strikethrough: !!cell.isStrikethrough(),
    inverse: false,
    wide: width === 2,
    continuation: width === 0,
  };
}

function blankCell(): TerminalCell {
  return {
    char: " ",
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false,
  };
}

function cellColor(
  cell: IBufferCell,
  layer: "fg" | "bg"
): { r: number; g: number; b: number } | undefined {
  const isDefault = layer === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    // Default background stays transparent so the pane shows through. Default
    // foreground renders as the terminal's real fg (brighter when bold) instead
    // of the app theme's muted default, which made plain agent text look washed.
    if (layer === "bg") {
      return;
    }
    return cell.isBold() ? TERM_FG_BOLD() : TERM_FG();
  }
  let color = layer === "fg" ? cell.getFgColor() : cell.getBgColor();
  const isRgb = layer === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
  }
  // Standard terminal behavior (drawBoldTextInBrightColors): bold text using one
  // of the 8 base ANSI colors renders in the matching bright color (8-15). Agent
  // CLIs lean on bold+color for headers/status; without this it looks muted.
  if (layer === "fg" && color < 8 && cell.isBold()) {
    color += 8;
  }
  if (layer === "bg" && color < ANSI_BG_16.length) {
    return rgb(ANSI_BG_16[color]);
  }
  return PALETTE_256[color] ?? undefined;
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export function terminalInputForKey(
  input: string,
  key: Key
): string | undefined {
  if (key.ctrl && input.length === 1) {
    const code = input.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(code - 96);
    }
  }

  if (key.return) {
    return "\r";
  }
  if (key.backspace) {
    return "\x7f";
  }
  // Shift+Tab must send the CSI Z back-tab so CLIs (and shells) can reverse
  // their own focus/completion cycling; plain Tab stays a literal tab.
  if (key.tab) {
    return key.shift ? "\x1b[Z" : "\t";
  }
  if (key.escape) {
    return "\x1b";
  }
  if (key.upArrow) {
    return "\x1b[A";
  }
  if (key.downArrow) {
    return "\x1b[B";
  }
  if (key.rightArrow) {
    return "\x1b[C";
  }
  if (key.leftArrow) {
    return "\x1b[D";
  }
  if (key.home) {
    return "\x1b[H";
  }
  if (key.end) {
    return "\x1b[F";
  }
  if (key.delete) {
    return "\x1b[3~";
  }
  // For text insertion use key.text, NOT input: silvery normalizes `input` to
  // base keys (e.g. shifted "!" -> "1", "A" -> "a"), so feeding `input` to the
  // PTY mangles every shifted symbol and capital letter. `text` is the literal
  // typed character; fall back to `input` for backends that don't populate it.
  const text = key.text ?? input;
  if (text.length > 0 && !key.ctrl && !key.meta) {
    return text;
  }
  return;
}
