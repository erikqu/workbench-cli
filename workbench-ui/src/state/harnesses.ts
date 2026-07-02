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
    command: () => ({ command: "claude --continue || claude" }),
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
    command: () => ({ command: "codex" }),
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
// of these is actually installed wins. Cursor first, then Claude Code.
const DEFAULT_HARNESS_PREFERENCE = ["cursor", "claude"];

let detectedDefaultHarnessId: string | undefined;

function detectDefaultHarnessId(): string {
  if (detectedDefaultHarnessId) {
    return detectedDefaultHarnessId;
  }
  for (const id of DEFAULT_HARNESS_PREFERENCE) {
    const spec = harnessSpecs.find((candidate) => candidate.id === id);
    if (spec && Bun.which(spec.bin)) {
      detectedDefaultHarnessId = id;
      return id;
    }
  }
  // Nothing detected (or Bun.which unavailable): fall back to the first spec so
  // the picker still opens on a sensible agent the user can install.
  detectedDefaultHarnessId = harnessSpecs[0].id;
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
  return harnessSpecs.find((spec) => spec.id === id) ?? harnessSpecs[0];
}
