import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { workbenchDir } from "./workbench-paths";

export interface InstanceOwner {
  pid: number;
  startedAt: string;
  tty: string;
}

// Two instances sharing one workbench namespace fight over the same tmux
// sessions: panes attach with `new-session -A -D`, so whichever mounts a pane
// last detaches the other, and the loser keeps painting a stale mirror at its own
// size — an agent's bottom-anchored input box simply disappears. Isolation keeps
// hot-reload launches out of the real namespace; this lock covers the remaining
// case of two ordinary launches, so the collision is announced instead of
// silently corrupting a view.
function lockPath(): string {
  return join(workbenchDir(), "instance.lock");
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readInstanceOwner(): InstanceOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath(), "utf8")) as InstanceOwner;
    if (
      typeof raw?.pid === "number" &&
      raw.pid !== process.pid &&
      processAlive(raw.pid)
    ) {
      return raw;
    }
  } catch {
    // Missing, unreadable, or malformed: treat the namespace as unowned.
  }
  return;
}

// Record this process as the namespace owner. Returns the previous live owner, if
// any, so the caller can surface the collision. Claiming anyway is deliberate:
// refusing to start would strand a user whose previous run was killed in a way
// that left the lock behind but the pid reused.
export function claimInstanceLock(): InstanceOwner | undefined {
  const previous = readInstanceOwner();
  try {
    mkdirSync(workbenchDir(), { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tty: ttyName(),
      } satisfies InstanceOwner)
    );
  } catch {
    // A read-only home should not stop the workbench from running.
  }
  return previous;
}

export function releaseInstanceLock() {
  try {
    if (!existsSync(lockPath())) {
      return;
    }
    const raw = JSON.parse(readFileSync(lockPath(), "utf8")) as InstanceOwner;
    // Only clear our own claim, never one a newer instance has taken.
    if (raw?.pid === process.pid) {
      writeFileSync(lockPath(), "{}");
    }
  } catch {
    // Nothing to release.
  }
}

function ttyName(): string {
  try {
    return readlinkSync("/proc/self/fd/1");
  } catch {
    // Not Linux, or no procfs: the pid alone still identifies the instance.
    return "unknown";
  }
}
