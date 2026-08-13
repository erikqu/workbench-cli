// How long after a pane's last output it still counts as active, for harnesses
// that expose no explicit busy marker. This is the fallback heuristic behind the
// animated session rail, so the window is also how long the rail keeps spinning
// after an agent finishes. Five seconds left it animating well past the point
// the agent went quiet — visibly wrong, and the animation repaints cells the
// whole time. Two seconds still spans ordinary gaps in a streaming response.
const TMUX_ACTIVITY_WINDOW_MS = 2000;

export function parseRecentTmuxActivity(
  output: string,
  nowMs = Date.now(),
  activeWithinMs = TMUX_ACTIVITY_WINDOW_MS
): Set<string> {
  const cutoffSeconds = Math.floor((nowMs - activeWithinMs) / 1000);
  const active = new Set<string>();
  for (const line of output.split("\n")) {
    const [name, activityText, deadText] = line.trim().split("|");
    const activity = Number(activityText);
    if (
      name &&
      deadText === "0" &&
      Number.isFinite(activity) &&
      activity >= cutoffSeconds
    ) {
      active.add(name);
    }
  }
  return active;
}

export async function recentTmuxActivity(
  socketPath: string,
  nowMs = Date.now()
): Promise<Set<string>> {
  try {
    const child = Bun.spawn(
      [
        "tmux",
        "-S",
        socketPath,
        "list-windows",
        "-a",
        "-F",
        "#{session_name}|#{window_activity}|#{pane_dead}",
      ],
      { stdout: "pipe", stderr: "ignore" }
    );
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      return new Set();
    }
    return parseRecentTmuxActivity(output, nowMs);
  } catch {
    return new Set();
  }
}

export async function captureTmuxPane(
  socketPath: string,
  sessionName: string
): Promise<string> {
  try {
    const child = Bun.spawn(
      ["tmux", "-S", socketPath, "capture-pane", "-p", "-t", sessionName],
      { stdout: "pipe", stderr: "ignore" }
    );
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    return exitCode === 0 ? output : "";
  } catch {
    return "";
  }
}

export interface TmuxScrollPosition {
  historySize: number;
  paneHeight: number;
  // Rows scrolled UP from the live bottom, as tmux reports it.
  scrollPosition: number;
}

// Parse `#{pane_in_mode}|#{scroll_position}|#{history_size}|#{pane_height}`.
// tmux leaves `scroll_position` empty unless the pane is scrolled in copy-mode
// (it can report `1||482|40` for a pane in a mode with no offset yet), so both
// the mode flag and a real number are required.
export function parseTmuxScrollPosition(
  output: string
): TmuxScrollPosition | undefined {
  const [inMode, scrollText, historyText, heightText] = output
    .trim()
    .split("|");
  if (inMode !== "1") {
    return;
  }
  const scrollPosition = Number(scrollText);
  const historySize = Number(historyText);
  const paneHeight = Number(heightText);
  if (
    !(
      scrollText &&
      Number.isFinite(scrollPosition) &&
      scrollPosition >= 0 &&
      Number.isFinite(historySize) &&
      historySize >= 0 &&
      Number.isFinite(paneHeight)
    )
  ) {
    return;
  }
  return { historySize, paneHeight, scrollPosition };
}

// Read a pane's copy-mode scroll offset. Strictly read-only: `display-message`
// never alters the pane, which matters because the terminal regression suite
// fails if an idle pane emits any bytes.
export async function tmuxScrollPosition(
  socketPath: string,
  sessionName: string
): Promise<TmuxScrollPosition | undefined> {
  try {
    const child = Bun.spawn(
      [
        "tmux",
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        sessionName,
        "#{pane_in_mode}|#{scroll_position}|#{history_size}|#{pane_height}",
      ],
      { stdout: "pipe", stderr: "ignore" }
    );
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    return exitCode === 0 ? parseTmuxScrollPosition(output) : undefined;
  } catch {
    return;
  }
}

export function harnessAppearsRunning(
  harnessId: string,
  paneText: string,
  recentlyActive: boolean
): boolean {
  const hasBusyMarker =
    /\bworking\s*\([^\n)]*\)|\b(?:esc|ctrl\+c|ctrl-c)\s+to\s+(?:interrupt|cancel)\b/i.test(
      paneText
    );
  if (hasBusyMarker) {
    return true;
  }
  // Codex exposes a stable busy marker even when animations are disabled and
  // no output bytes arrive during a long tool/model wait. For harnesses whose
  // status vocabulary is not yet standardized, recent PTY output remains the
  // conservative fallback.
  return harnessId !== "codex" && recentlyActive;
}
