export interface HarnessCommand {
  command: string;
  env?: Record<string, string>;
}

export interface HarnessSpec {
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
    installHint:
      "Install Cursor CLI and make `cursor-agent` available on PATH.",
    command: () => ({ command: "cursor-agent" }),
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Anthropic Claude Code CLI",
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
    installHint: "Install Gemini CLI and make `gemini` available on PATH.",
    command: () => ({ command: "gemini" }),
  },
  {
    id: "goose",
    label: "Goose",
    description: "Block Goose CLI",
    installHint: "Install Goose and make `goose` available on PATH.",
    command: () => ({ command: "goose" }),
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI",
    installHint: "Install OpenCode and make `opencode` available on PATH.",
    command: () => ({ command: "opencode" }),
  },
];

export function defaultHarnessId() {
  return (
    Bun.env.WORKBENCH_UI_HARNESS_ID || Bun.env.WORKBENCH_UI_AGENT_ID || "cursor"
  );
}

export function harnessSpec(id: string): HarnessSpec {
  return harnessSpecs.find((spec) => spec.id === id) ?? harnessSpecs[0];
}
