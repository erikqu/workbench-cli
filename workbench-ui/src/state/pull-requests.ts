import type { HarnessCommand } from "./harnesses";

// The Pull Requests tab embeds the standalone `prs` TUI
// (https://github.com/nandatheguntupalli/prs) the same way harnesses embed
// agent CLIs: a persistent PTY on the private tmux server, so the list keeps
// its place across tab switches and Workbench restarts.

export const PULL_REQUESTS_LABEL = "Pull Requests";
export const PULL_REQUESTS_INSTALL_HINT =
  "Install prs with `brew install nandatheguntupalli/tap/prs`, or set WORKBENCH_PRS_BIN to its path.";

// Passed to the pane through the environment so the script never has to quote
// a path. An absolute path also survives a tmux server started with an older
// PATH.
const BIN_ENV = "WORKBENCH_PRS_BIN";

// prs picks the repository from the pane's working directory and falls back to
// every PR you're involved in outside a GitHub checkout. Quitting it with `q`
// would otherwise leave a dead pane, so wait for Enter and start it again.
// tmux hands the command to the user's shell, which may not be POSIX (fish),
// hence the explicit /bin/sh.
const REOPEN_LOOP = `while :; do "$${BIN_ENV}"; printf "\\n  %s" "Pull requests closed. Press Enter to reopen."; read -r _ || break; done`;

export function resolvePullRequestsBin(
  env: Record<string, string | undefined> = Bun.env,
  which: (bin: string) => string | null = Bun.which
): string | undefined {
  return env[BIN_ENV] || which("prs") || undefined;
}

export function pullRequestsCommand(bin: string): HarnessCommand {
  return {
    command: `/bin/sh -c '${REOPEN_LOOP}'`,
    env: { [BIN_ENV]: bin },
  };
}
