#!/usr/bin/env bun

import { resolve } from "node:path";
import { runWorkbench } from "./app/WorkbenchApp";
import { setCellAspect } from "./media/image";
import {
  inMultiplexer,
  probedGraphicsSupport,
  setGraphicsSupport,
} from "./media/image-protocol";
import { probeTerminal } from "./terminal/terminal-probe";

const args = process.argv.slice(2);
let cwdArg: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--harness" || arg === "--agent") {
    const value = args[index + 1];
    if (value) {
      process.env.WORKBENCH_UI_HARNESS_ID = value;
      index += 1;
    }
    continue;
  }
  if (arg.startsWith("--harness=")) {
    process.env.WORKBENCH_UI_HARNESS_ID = arg.slice("--harness=".length);
    continue;
  }
  if (arg.startsWith("--agent=")) {
    process.env.WORKBENCH_UI_HARNESS_ID = arg.slice("--agent=".length);
    continue;
  }
  if (!arg.startsWith("-")) {
    cwdArg = arg;
  }
}

const cwd = resolve(cwdArg ?? process.env.WORKBENCH_UI_CWD ?? ".");

// Kitty graphics is the default image protocol. Silvery's <Image> only emits
// graphics when its own profile (which it derives purely from TERM/TERM_PROGRAM)
// agrees, and there's no way to inject a capability into the component — so we
// spoof TERM to a value it recognizes. Default to xterm-kitty; the active probe
// below downgrades to Sixel only when a terminal positively advertises Sixel but
// not Kitty. Opt out entirely with WORKBENCH_UI_IMAGE_PROTOCOL=halfblock.
//
// Skipped inside tmux (we use the passthrough-placeholder path there; spoofing
// would make Silvery write raw escapes tmux swallows) and in the screenshot
// harness. Child agent PTYs set their own TERM at spawn, so this is local to our
// own rendering, never inherited by the agents.
const imageOverride = (
  process.env.WORKBENCH_UI_IMAGE_PROTOCOL ?? ""
).toLowerCase();

// Actively probe the terminal before the renderer grabs stdin: cell geometry
// (so images aren't stretched) and which graphics protocol it actually speaks.
// Best effort — null on non-TTY / busy stdin; kitty stays the default anyway.
if (process.env.WORKBENCH_UI_SCREENSHOT !== "1") {
  try {
    const probe = await probeTerminal();
    if (probe?.aspect && !process.env.WORKBENCH_UI_CELL_ASPECT) {
      setCellAspect(probe.aspect);
    }
    if (probe && imageOverride !== "halfblock") {
      setGraphicsSupport({ kitty: probe.kitty, sixel: probe.sixel });
    }
  } catch {
    // keep defaults
  }
}

if (
  process.env.WORKBENCH_UI_SCREENSHOT !== "1" &&
  imageOverride !== "halfblock" &&
  !inMultiplexer()
) {
  const support = probedGraphicsSupport();
  const sixelOnly = support?.sixel && !support.kitty;
  const explicitSixel = imageOverride === "sixel";
  const wanted = sixelOnly || explicitSixel ? "foot" : "xterm-kitty";
  if (process.env.TERM !== wanted) {
    process.env.TERM = wanted;
  }
}

runWorkbench({ cwd }).catch((error) => {
  console.error(error);
  process.exit(1);
});
