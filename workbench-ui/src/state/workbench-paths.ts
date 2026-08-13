import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Where this instance keeps its private tmux socket and its persisted layout.
//
// A normal launch uses `~/.workbench`. A hot-reload launch uses a sibling
// directory keyed to the source checkout it is running, because the two are
// otherwise guaranteed to collide: `work --hot` inside a development checkout
// runs that checkout's sources but would still attach the same tmux sessions and
// write the same state file as the everyday `work`. Since panes attach with
// `new-session -A -D`, whichever instance mounted a pane last silently detached
// the other, leaving the loser painting a stale mirror at the wrong height — the
// symptom being an agent's input box scrolled out of view.
//
// The namespace is derived from the checkout path rather than randomised per
// launch, because hot reload *must* reattach the same running agents after every
// restart. Two different checkouts still get separate namespaces.
function hotNamespace(root: string): string {
  return `hot-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

function resolveWorkbenchDir(): string {
  const home = Bun.env.HOME ?? homedir();
  const base = join(home, ".workbench");
  if (Bun.env.WORKBENCH_CLI_HOT !== "1") {
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
