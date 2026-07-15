import { mkdirSync, writeFileSync } from "node:fs";
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

export interface TerminalPanelOptions {
  command?: string;
  env?: Record<string, string>;
  // When set, the PTY command runs inside a persistent tmux session on a private
  // tmux server addressed by an explicit socket path (`-S`), so the process
  // survives the editor closing and is re-attached on the next launch. Using a
  // socket path under the app's own directory keeps this server fully separate
  // from the user's tmux (default server and any `-L` named servers).
  persist?: { socketPath: string; name: string };
}

let tmuxAvailable: boolean | undefined;
function hasTmux(): boolean {
  if (tmuxAvailable === undefined) {
    tmuxAvailable = Bun.which("tmux") !== null;
  }
  return tmuxAvailable;
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
const TMUX_CONF = [
  "set -g status off",
  "set -g mouse on",
  "set -g escape-time 1",
  "set -g history-limit 20000",
  "set -g focus-events on",
  "setw -g aggressive-resize on",
  "",
].join("\n");

let tmuxConfPath: string | undefined;
function ensureTmuxConf(): string {
  if (!tmuxConfPath) {
    const dir = join(Bun.env.HOME ?? ".", ".workbench");
    const path = join(dir, "workbench-ui-tmux.conf");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, TMUX_CONF);
    } catch {
      // Fall back to default config if we can't write ours.
    }
    tmuxConfPath = path;
  }
  return tmuxConfPath;
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

export class TerminalPanel implements TerminalReadable {
  private terminal: Terminal;
  private child?: ReturnType<typeof Bun.spawn>;
  private pty?: Bun.Terminal;
  private updateRevision = ++revisionCounter;
  private listeners = new Set<() => void>();
  private followOutput = true;
  private tmuxCopyModePossible = false;

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
    this.terminal.onWriteParsed(() => {
      // Full-screen TUIs such as Codex wrap redraws in synchronized-output mode
      // (DEC private mode 2026). Do not expose partially parsed frames while the
      // mode is active; repaint once the closing sequence has been processed.
      // Rendering every PTY chunk defeats the mode and produces transient stale
      // borders/text ("artifacts") during Codex's frequent composer redraws.
      if (this.terminal.modes.synchronizedOutputMode) {
        return;
      }
      this.snapFollowingViewportToBottom();
      this.updateRevision = ++revisionCounter;
      this.emit();
    });
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
    const inner = this.options.command ?? `${shell} -l`;

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
        `tmux -S ${shellQuote(persist.socketPath)} -f ${shellQuote(ensureTmuxConf())} new-session -A`,
        `-s ${shellQuote(persist.name)}`,
        `-x ${cols} -y ${rows}`,
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
  }

  resize(cols: number, rows: number) {
    if (cols === this.terminal.cols && rows === this.terminal.rows) {
      return;
    }
    this.terminal.resize(cols, rows);
    this.snapFollowingViewportToBottom();
    // Propagate to the child PTY so the program (or tmux client) gets SIGWINCH
    // and reflows to match the newly rendered box.
    this.pty?.resize(cols, rows);
    this.updateRevision = ++revisionCounter;
    this.emit();
  }

  scrollLines(lines: number) {
    this.terminal.scrollLines(lines);
    this.updateFollowOutput();
    this.updateRevision = ++revisionCounter;
    this.emit();
  }

  scrollPages(pages: number) {
    this.terminal.scrollPages(pages);
    this.updateFollowOutput();
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
    this.writeToChild(this.formatPaste(text));
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
    if (!(this.usesAlternateBuffer() || this.hasMouseTracking())) {
      return false;
    }
    if (!this.child) {
      this.start();
    }
    this.writeToChild(data);
    return true;
  }

  sendMouseWheel(col: number, row: number, direction: "up" | "down"): boolean {
    if (!this.hasMouseTracking()) {
      return false;
    }
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
    this.writeToChild(
      `\x1b[<${button};${Math.max(1, Math.floor(col) + 1)};${Math.max(1, Math.floor(row) + 1)}M`
    );
    return true;
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
  }

  private writeToChild(data: string) {
    this.pty?.write(data);
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
    return rows;
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
    const persist = this.persist;
    if (persist) {
      try {
        Bun.spawnSync(
          [
            "tmux",
            "-S",
            persist.socketPath,
            "kill-session",
            "-t",
            persist.name,
          ],
          {
            stdout: "ignore",
            stderr: "ignore",
          }
        );
      } catch {
        // Session may already be gone.
      }
    }
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
