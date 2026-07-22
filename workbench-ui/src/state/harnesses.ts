export interface HarnessCommand {
  command: string;
  env?: Record<string, string>;
}

export interface HarnessSpec {
  // Executable probed on PATH to decide whether this agent is installed.
  bin: string;
  command(): HarnessCommand;
  description: string;
  id: string;
  installHint: string;
  label: string;
}

const DEFAULT_HARNESS_ID = "codex";
const DEFAULT_HARNESS_PREFERENCE = ["codex", "cursor", "claude"];
const CODEX_HISTORY_REPLAY_OVERRIDE =
  "-c tui.terminal_resize_reflow_max_rows=0";
const CODEX_STABLE_STATUS_OVERRIDE = "-c tui.animations=false";

interface ParsedCodexVersion {
  alpha?: number;
  major: number;
  minor: number;
  patch: number;
}

function parseCodexVersion(
  versionOutput: string
): ParsedCodexVersion | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?(?:\s|$)/.exec(
    versionOutput.trim()
  );
  if (!match) {
    return;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    alpha: match[4] === undefined ? undefined : Number(match[4]),
  };
}

// Codex's capped initial replay could lose finalized transcript rows after a
// stream was consolidated. The upstream repair first appears in 0.145 alpha
// 12; stable 0.144 releases need uncapped replay when resuming a conversation.
export function codexNeedsHistoryReplayWorkaround(
  versionOutput: string
): boolean {
  const version = parseCodexVersion(versionOutput);
  if (!version || version.major !== 0) {
    return false;
  }
  if (version.minor === 144) {
    return true;
  }
  return (
    version.minor === 145 &&
    version.patch === 0 &&
    version.alpha !== undefined &&
    version.alpha < 12
  );
}

export function codexCommand(versionOutput: string): HarnessCommand {
  const replayOverride = codexNeedsHistoryReplayWorkaround(versionOutput)
    ? ` ${CODEX_HISTORY_REPLAY_OVERRIDE}`
    : "";
  return {
    // Animated status frames produce heavy inline redraw traffic. Nested
    // terminals and multiplexers can preserve those transient rows in history
    // after scrolling, so Workbench uses Codex's stable non-animated status.
    command: `codex resume --last${replayOverride} ${CODEX_STABLE_STATUS_OVERRIDE} --dangerously-bypass-approvals-and-sandbox || codex ${CODEX_STABLE_STATUS_OVERRIDE} --dangerously-bypass-approvals-and-sandbox`,
  };
}

let detectedCodexVersion: string | undefined;

function installedCodexVersion(): string {
  if (detectedCodexVersion !== undefined) {
    return detectedCodexVersion;
  }
  try {
    const result = Bun.spawnSync(["codex", "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    detectedCodexVersion = new TextDecoder().decode(result.stdout).trim();
  } catch {
    detectedCodexVersion = "";
  }
  return detectedCodexVersion;
}

export const harnessSpecs: HarnessSpec[] = [
  {
    id: "cursor",
    label: "Cursor",
    description: "Cursor Agent CLI",
    bin: "cursor-agent",
    installHint:
      "Install Cursor CLI and make `cursor-agent` available on PATH.",
    command: () => ({ command: "cursor-agent" }),
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Anthropic Claude Code CLI",
    bin: "claude",
    installHint: "Install Claude Code and make `claude` available on PATH.",
    // Resume the most recent conversation for this directory if one exists,
    // otherwise start fresh. `claude --continue` exits non-zero when there is
    // no prior conversation to resume, so fall back to a clean `claude`.
    // --dangerously-skip-permissions bypasses the per-action approval prompts.
    command: () => ({
      command:
        "claude --continue --dangerously-skip-permissions || claude --dangerously-skip-permissions",
    }),
  },
  {
    id: "gemini",
    label: "Gemini",
    description: "Google Gemini CLI",
    bin: "gemini",
    installHint: "Install Gemini CLI and make `gemini` available on PATH.",
    command: () => ({ command: "gemini" }),
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    bin: "codex",
    installHint: "Install Codex CLI and make `codex` available on PATH.",
    // Resume the most recent session for this directory; `codex resume --last`
    // exits non-zero when there's nothing to resume, so fall back to a fresh
    // `codex`. --dangerously-bypass-approvals-and-sandbox (alias --yolo) skips
    // the approval prompts and sandbox, matching the other harnesses.
    command: () => codexCommand(installedCodexVersion()),
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI",
    bin: "opencode",
    installHint: "Install OpenCode and make `opencode` available on PATH.",
    command: () => ({ command: "opencode" }),
  },
];

// Agents tried, in order, when picking a default for a brand-new user: whichever
// of these is actually installed wins. Codex is the preferred default.
export function selectDefaultHarnessId(
  isInstalled: (bin: string) => boolean
): string {
  for (const id of DEFAULT_HARNESS_PREFERENCE) {
    const spec = harnessSpecs.find((candidate) => candidate.id === id);
    if (spec && isInstalled(spec.bin)) {
      return id;
    }
  }
  return DEFAULT_HARNESS_ID;
}

let detectedDefaultHarnessId: string | undefined;

function detectDefaultHarnessId(): string {
  if (detectedDefaultHarnessId) {
    return detectedDefaultHarnessId;
  }
  detectedDefaultHarnessId = selectDefaultHarnessId((bin) => !!Bun.which(bin));
  return detectedDefaultHarnessId;
}

export function defaultHarnessId() {
  return (
    Bun.env.WORKBENCH_UI_HARNESS_ID ||
    Bun.env.WORKBENCH_UI_AGENT_ID ||
    detectDefaultHarnessId()
  );
}

export function harnessSpec(id: string): HarnessSpec {
  return (
    harnessSpecs.find((spec) => spec.id === id) ??
    harnessSpecs.find((spec) => spec.id === DEFAULT_HARNESS_ID) ??
    harnessSpecs[0]
  );
}
