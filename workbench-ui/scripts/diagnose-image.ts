#!/usr/bin/env bun
//
// Image-rendering diagnostic. Run this INSIDE the terminal where you launch
// `workbench-cli` (not over SSH from another machine, not piped):
//
//   cd workbench-ui && bun scripts/diagnose-image.ts
//
// It reports what Silvery's detection thinks of your terminal and then emits a
// real Kitty graphics test image. If you see a colored square below the report,
// your terminal supports Kitty graphics and the fix is detection (use the
// WORKBENCH_UI_IMAGE_PROTOCOL=kitty override). If you see nothing / gibberish,
// the terminal itself cannot render Kitty graphics.

import { Jimp } from "jimp";
import {
  createTerminalProfile,
  encodeKittyImage,
  isKittyGraphicsSupported,
  isSixelSupported,
} from "silvery";
import {
  buildKittyPlaceholderText,
  buildKittyVirtualTransmit,
  wrapForMultiplexer,
  writeRawStdout,
} from "../src/media/image-protocol";
import { detectCellAspect } from "../src/terminal/cell-size";
import { probeTerminal } from "../src/terminal/terminal-probe";

const env = process.env;
const envKeys = [
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "KITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
  "WEZTERM_EXECUTABLE",
  "KONSOLE_VERSION",
  "WT_SESSION",
  "TMUX",
  "STY",
  "COLORTERM",
];

console.log("=== Image rendering diagnostic ===\n");
console.log("Environment:");
for (const key of envKeys) {
  console.log(`  ${key} = ${env[key] ?? "(unset)"}`);
}

const profile = createTerminalProfile();
console.log("\nSilvery terminal profile:");
console.log(`  emulator.program = ${profile.emulator.program || "(empty)"}`);
console.log(`  emulator.TERM    = ${profile.emulator.TERM || "(empty)"}`);
console.log(`  caps.kittyGraphics = ${profile.caps.kittyGraphics}`);
console.log(`  caps.sixel         = ${profile.caps.sixel}`);
console.log(`  isKittyGraphicsSupported() = ${isKittyGraphicsSupported()}`);
console.log(`  isSixelSupported()         = ${isSixelSupported()}`);

const probe = await probeTerminal(400);
console.log("\nActive terminal probe (what the UI now uses to decide):");
if (probe) {
  console.log(`  kitty graphics replied = ${probe.kitty}`);
  console.log(`  sixel (DA1 attr 4)     = ${probe.sixel}`);
  console.log(
    `  cell aspect            = ${probe.aspect ? probe.aspect.toFixed(3) : "(no reply)"}`
  );
  if (!(probe.kitty || probe.sixel)) {
    console.log(
      "  -> No graphics reply. If you KNOW this terminal supports Kitty,"
    );
    console.log(
      "     launch with WORKBENCH_UI_IMAGE_PROTOCOL=kitty to force it."
    );
  }
} else {
  console.log("  (probe skipped: not a TTY / stdin busy)");
}

if (env.TMUX) {
  console.log(
    "\n[!] You are inside tmux. tmux blocks the Kitty graphics protocol unless\n" +
      "    'set -g allow-passthrough on' is set AND the outer terminal supports it."
  );
}

console.log(
  "\nEmitting a live Kitty graphics test image (32x32 magenta square)..."
);
console.log(
  "If Kitty graphics work, a colored square appears on the next lines:\n"
);

const image = new Jimp({ width: 64, height: 64, color: 0xcc_44_cc_ff });
const png = await image.getBuffer("image/png");
process.stdout.write(encodeKittyImage(png, { width: 16, height: 8 }));
// Reserve vertical space so the square isn't overwritten by the prompt.
process.stdout.write("\n\n\n\n\n\n\n\n");
console.log(
  "(Direct test: if blank/gibberish above, the host terminal can't do Kitty here — e.g. tmux ate it.)"
);

const detectedAspect = await detectCellAspect();
console.log(
  `\nCell aspect (width/height): ${
    detectedAspect
      ? detectedAspect.toFixed(3) + " (auto-detected)"
      : "not detected — using default 0.5"
  }`
);
if (!detectedAspect) {
  console.log(
    "  If images look stretched, set WORKBENCH_UI_CELL_ASPECT to your terminal's\n" +
      "  cell width/height ratio (e.g. 0.5 for 2:1 cells). Lower = taller image."
  );
}

if (env.TMUX) {
  const aspect = detectedAspect ?? 0.5;
  console.log(
    "\nNow the tmux-passthrough path (what the Workbench UI uses inside tmux):"
  );
  console.log("A teal SQUARE should appear below (source is a square image).");
  console.log(
    "If it's a rectangle, the cell aspect is off — set WORKBENCH_UI_CELL_ASPECT.\n"
  );
  const base64 = png.toString("base64");
  const id = 31;
  const cols = 20;
  const rows = Math.max(1, Math.round(cols * aspect)); // square source -> cols*1*aspect
  // Transmit out-of-band, wrapped in tmux passthrough, then draw placeholder
  // cells colored with the image id for the terminal to composite over.
  writeRawStdout(
    buildKittyVirtualTransmit(base64, id, cols, rows)
      .map(wrapForMultiplexer)
      .join("")
  );
  const placeholder = buildKittyPlaceholderText(cols, rows);
  process.stdout.write(`\x1b[38;5;${id}m${placeholder}\x1b[0m\n`);
  console.log(
    "\nIf nothing appeared, enable tmux passthrough and retry:\n" +
      "  tmux set -g allow-passthrough on   (tmux >= 3.3)\n" +
      "and make sure the OUTER terminal (Ghostty) supports Kitty graphics."
  );
}
