const TMUX_ACTIVITY_WINDOW_MS = 5000;

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
