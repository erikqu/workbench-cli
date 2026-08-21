import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Where this instance keeps its private tmux socket and its persisted layout.
//
// A normal launch and `work --hot` both use `~/.workbench`, so a long-running
// local hot test exercises the user's real persisted layout and reattaches all
// existing harness/terminal panes. The application enforces a single owner
// before mounting those panes; sharing this namespace between two live UIs
// would let `new-session -A -D` detach one client and leave it painting a stale
// mirror at the wrong height.
//
// Set WORKBENCH_CLI_HOT_ISOLATED=1 for a throwaway development layout. Its
// namespace is derived from the checkout path rather than randomised because
// hot reload must reattach the same test agents after every watched restart.
function hotNamespace(root: string): string {
  return `hot-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

function resolveWorkbenchDir(): string {
  const home = Bun.env.HOME ?? homedir();
  const base = join(home, ".workbench");
  if (
    Bun.env.WORKBENCH_CLI_HOT !== "1" ||
    Bun.env.WORKBENCH_CLI_HOT_ISOLATED !== "1"
  ) {
    return base;
  }
  // The launcher exports the checkout it decided to run; fall back to this
  // file's own package root when the runner was invoked directly.
  const root =
    Bun.env.WORKBENCH_CLI_HOT_ROOT ?? join(import.meta.dir, "..", "..");
  return join(base, hotNamespace(root));
}

const workbenchDirPath = resolveWorkbenchDir();

export function workbenchDir(): string {
  return workbenchDirPath;
}

export function tmuxSocketPath(): string {
  return join(workbenchDirPath, "tmux-ui.sock");
}

export function persistedStatePath(): string {
  return join(workbenchDirPath, "workbench-ui-state.json");
}

// True when this process is running an isolated hot-reload namespace rather than
// the user's real one. Used to label the instance in diagnostics.
export function isolatedInstance(): boolean {
  return workbenchDirPath !== join(Bun.env.HOME ?? homedir(), ".workbench");
}

export function hotAttachesRealSessions(): boolean {
  return Bun.env.WORKBENCH_CLI_HOT === "1" && !isolatedInstance();
}
