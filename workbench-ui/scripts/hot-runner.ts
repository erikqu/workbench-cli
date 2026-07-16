#!/usr/bin/env bun

import { join } from "node:path";
import chokidar from "chokidar";

const appRoot = join(import.meta.dir, "..");
const entry = join(appRoot, "src", "index.ts");
const bun = Bun.which("bun") ?? process.execPath;
const args = process.argv.slice(2);
const restartDelayMs = 100;

let child: ReturnType<typeof Bun.spawn> | undefined;
let closing = false;
let restarting = false;
let restartQueued = false;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let resolveDone: (() => void) | undefined;

const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});
const watcher = chokidar.watch(join(appRoot, "src"), {
  awaitWriteFinish: {
    pollInterval: 20,
    stabilityThreshold: 60,
  },
  ignoreInitial: true,
});

watcher.on("all", scheduleRestart);
watcher.on("error", (error) => {
  void stop(1, error);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop(signal === "SIGINT" ? 130 : 143);
  });
}

launch();
await done;

function launch() {
  const next = Bun.spawn([bun, entry, ...args], {
    cwd: process.cwd(),
    env: {
      ...Bun.env,
      WORKBENCH_CLI_HOT: "1",
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  child = next;
  void next.exited.then((code) => {
    if (child !== next) {
      return;
    }
    child = undefined;
    if (!(closing || restarting)) {
      void stop(code);
    }
  });
}

function scheduleRestart() {
  if (closing) {
    return;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    void restart();
  }, restartDelayMs);
}

async function restart() {
  if (closing) {
    return;
  }
  if (restarting) {
    restartQueued = true;
    return;
  }
  restarting = true;
  const previous = child;
  if (previous) {
    previous.kill("SIGTERM");
    await previous.exited;
    if (child === previous) {
      child = undefined;
    }
  }
  if (!closing) {
    launch();
  }
  restarting = false;
  if (restartQueued) {
    restartQueued = false;
    await restart();
  }
}

async function stop(code: number, error?: unknown) {
  if (closing) {
    return;
  }
  closing = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  await watcher.close();
  const running = child;
  if (running) {
    running.kill("SIGTERM");
    await running.exited;
  }
  if (error) {
    console.error(error);
  }
  process.exitCode = code;
  resolveDone?.();
}
