import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import {
  renderSimulatedAgentFrame,
  renderSimulatedInlineBlock,
  type SimulatedAgentFrame,
  type SimulatedAgentState,
  simulatedConversationRows,
} from "../test-harness/simulated-agent-model";

interface FixtureEnvelope {
  cols: number;
  cursor: { visible: boolean; x: number; y: number };
  pid: number;
  rows: number;
  state: SimulatedAgentState;
  term: string;
}

interface Grid {
  cols: number;
  lines: string[];
  rows: number;
}

interface Location {
  fixture: FixtureEnvelope;
  frame: SimulatedAgentFrame;
  x: number;
  y: number;
}

const root = join(import.meta.dir, "..");
const options = parseOptions(process.argv.slice(2));
const appRoot = resolve(options.appRoot ?? root);
const [initialCols, initialRows] = parseSize(options.size ?? "120x40");
const runLabel =
  options.label ??
  `${basename(appRoot)}${options.inline ? "-inline" : ""}-${initialCols}x${initialRows}-${Date.now()}`;
const artifactDir = join(root, "artifacts", "terminal-regression", runLabel);
// tmux's Unix socket path is capped at roughly 100 bytes. On macOS tmpdir()
// expands under /var/folders/... and the isolated HOME plus
// /.workbench/tmux-ui.sock can exceed that before the rendering fixture starts.
// Keep the test root deliberately short so the suite exercises the terminal,
// not a platform-specific socket-path failure.
const tempRoot = mkdtempSync("/tmp/wbtr-");
const home = join(tempRoot, "home");
const codexHome = join(tempRoot, "codex-home");
const workspace = options.liveCodex ? join(tempRoot, "workspace") : appRoot;
const agentStatePath = join(tempRoot, "simulated-agent-state.json");
const tracePath = join(artifactDir, "ansi-trace.ndjson");
const frameTracePath = join(artifactDir, "frame-trace.ndjson");
const metadataPath = join(artifactDir, "failure.json");
const screenshotPath = join(artifactDir, "failure.png");
const port = 20_000 + ((process.pid * 31 + Date.now()) % 20_000);
// Rows above the inline agent's bottom block must be the exact tail of the
// conversation it printed: no duplicated, missing, or displaced rows after
// tmux copy-mode scrollback churn. Twelve rows is deep enough to cover a
// streamed response burst while staying inside the pane at every tested size.
const INLINE_TAIL_ROWS = 12;

mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });
if (options.liveCodex) {
  mkdirSync(codexHome, { recursive: true });
  const authPath = join(Bun.env.HOME ?? "", ".codex", "auth.json");
  if (existsSync(authPath)) {
    copyFileSync(authPath, join(codexHome, "auth.json"));
  }
  writeFileSync(
    join(codexHome, "config.toml"),
    "[tui]\nanimations = false\nnotifications = false\n"
  );
}
mkdirSync(artifactDir, { recursive: true });

const server = Bun.spawn(
  ["bun", "test-harness/terminal-regression-server.ts"],
  {
    cwd: root,
    env: {
      ...Bun.env,
      HOME: home,
      CODEX_HOME: options.liveCodex ? codexHome : Bun.env.CODEX_HOME,
      WORKBENCH_E2E_AGENT_INLINE: options.inline ? "1" : "",
      WORKBENCH_E2E_AGENT_CODEX: options.codex ? "1" : "",
      WORKBENCH_E2E_CODEX_STICKY_TRANSCRIPT: options.stickyTranscript
        ? "1"
        : "",
      WORKBENCH_E2E_LIVE_CODEX: options.liveCodex ? "1" : "",
      WORKBENCH_E2E_REAL_CODEX: options.liveCodex
        ? (Bun.which("codex") ?? "")
        : "",
      WORKBENCH_E2E_AGENT_STATE: agentStatePath,
      WORKBENCH_E2E_APP_ROOT: appRoot,
      WORKBENCH_E2E_CHUNK_SEED:
        options.chunkSeed === undefined ? "" : String(options.chunkSeed),
      WORKBENCH_E2E_COLS: String(initialCols),
      WORKBENCH_E2E_PORT: String(port),
      WORKBENCH_E2E_ROWS: String(initialRows),
      WORKBENCH_E2E_TRACE: tracePath,
      WORKBENCH_E2E_HARNESS_ID: options.codex ? "codex" : "cursor",
      WORKBENCH_E2E_WORKSPACE: workspace,
      WORKBENCH_UI_THEME: options.theme ?? Bun.env.WORKBENCH_UI_THEME ?? "dark",
      WORKBENCH_TERMINAL_TRACE:
        options.liveCodex || options.traceFrames ? frameTracePath : "",
    },
    stderr: "pipe",
    stdout: "pipe",
  }
);

let page: Page | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let lastFailure: Record<string, unknown> | undefined;
const serverErrors: string[] = [];
void collectStream(server.stderr as ReadableStream<Uint8Array>, serverErrors);

try {
  await waitForServer(server.stdout as ReadableStream<Uint8Array>);
  browser = await chromium.launch();
  page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: {
      height: Math.max(900, initialRows * 20 + 80),
      width: Math.max(1400, initialCols * 10 + 80),
    },
  });
  await page.goto(
    `http://127.0.0.1:${port}/?cols=${initialCols}&rows=${initialRows}`
  );
  await page.waitForFunction(
    () =>
      Boolean(
        (window as any).__workbenchReady &&
          (window as any).__workbenchSocketOpen &&
          (window as any).__workbenchSawOutput
      ),
    undefined,
    { timeout: 10_000 }
  );

  // A normal (non-screenshot) Workbench starts with its splash. The first
  // interaction dismisses it and is intentionally not forwarded to the pane.
  // Wait for the splash frame itself: strict terminal emulators make the first
  // render slower, and sending Escape after only the startup control sequences
  // can race the input handler and leave the splash covering the fixture.
  await waitForText(page, "Workbench", 5000);
  await waitForOutputSettled(page, 5000);
  await send(page, "\x1b");
  let location: Location | undefined;
  if (options.liveCodex) {
    const startup = await waitForAnyText(
      page,
      ["OpenAI Codex (v", "Do you trust the contents"],
      20_000
    );
    if (startup === "Do you trust the contents") {
      await send(page, "\r");
    }
    await waitForText(page, "OpenAI Codex (v", 20_000);
  } else {
    location = await waitForReference(page, () => true, 12_000);
  }
  // A clean painted frame can precede the nested tmux client's input attach by
  // a few milliseconds. Match human interaction timing before the first key.
  await Bun.sleep(50);
  report(
    options.liveCodex
      ? "initial live Codex frame"
      : `initial reference frame (${location?.fixture.term || "TERM unset"})`
  );
  const frameTraceStart = options.traceFrames
    ? latestTraceSequence(frameTracePath)
    : 0;
  if (options.chunkSeed !== undefined) {
    await send(page, "\0WORKBENCH_CHUNK_OUTPUT");
  }

  if (options.idleOnly) {
    await assertIdleWindows(page, options.idleSamples);
  } else if (options.liveCodex) {
    await runLiveCodexScenario(page);
  } else if (options.inline) {
    await runInlineAgentScenario(page, location!);
    await assertIdleWindows(page, options.idleSamples);
  } else if (options.plainOnly) {
    await runPlainShellScenario(page);
    await send(page, "\x1b1");
    await waitForReference(page, () => true, 8000);
    await assertIdleWindows(page, options.idleSamples);
  } else {
    location = await runSimulatedAgentScenario(page, location!);
    await runPlainShellScenario(page);
    await send(page, "\x1b1");
    location = await waitForReference(page, () => true, 8000);
    if (options.soak > 0) {
      location = await runSoak(page, location, options.soak);
    }
    await waitForReference(page, (fixture) => !fixture.state.working, 8000);
    await assertIdleWindows(page, options.idleSamples);
  }

  if (options.traceFrames) {
    await Bun.sleep(100);
    assertNoPersistentFrameMismatch(frameTracePath, frameTraceStart);
  }

  console.log(`PASS terminal regression ${runLabel}`);
  await send(page, "\x11");
} catch (error) {
  const grid = page ? await safeGrid(page) : undefined;
  const cursor = page
    ? await page
        .evaluate(() => (window as any).__cursorState?.())
        .catch(() => null)
    : undefined;
  lastFailure = {
    appRoot,
    cursor,
    error: error instanceof Error ? error.stack : String(error),
    grid,
    initialCols,
    initialRows,
    runLabel,
    serverErrors,
  };
  writeFileSync(metadataPath, JSON.stringify(lastFailure, null, 2));
  if (page) {
    await page.screenshot({ path: screenshotPath }).catch(() => undefined);
  }
  console.error(`FAIL terminal regression ${runLabel}`);
  console.error(lastFailure.error);
  console.error(`artifacts: ${artifactDir}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  try {
    server.kill();
  } catch {
    // The server may already have exited with the app.
  }
  await server.exited.catch(() => undefined);
  killIsolatedTmux(home);
  if (!(lastFailure || options.keepArtifacts)) {
    rmSync(artifactDir, { force: true, recursive: true });
  }
  rmSync(tempRoot, { force: true, recursive: true });
}

async function runSimulatedAgentScenario(page: Page, initial: Location) {
  let location = initial;
  const originalAgentPid = location.fixture.pid;
  await typeCharacters(page, "restart probe");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "restart probe",
    Bun.env.SILVERY_STRICT_TERMINAL ? 20_000 : 5000
  );
  if (Bun.env.SILVERY_STRICT_TERMINAL) {
    await send(page, "\x1b");
    location = await waitForReference(
      page,
      (fixture) => fixture.state.composer === "",
      8000
    );
  } else {
    await send(page, "\x1b[104;5u");
    await waitForText(page, "Switch CLI harness", 3000);
    await waitForText(
      page,
      `${options.codex ? "Codex" : "Cursor"}  refresh`,
      3000
    );
    await send(page, "\r");
    location = await waitForReference(
      page,
      (fixture) =>
        fixture.pid !== originalAgentPid && fixture.state.composer === "",
      8000
    );
    // The first clean frame can arrive just before tmux finishes attaching the
    // replacement pane's input side. Avoid donating the first test character
    // to that handoff; real users naturally take longer than one event-loop turn.
    await Bun.sleep(50);
    report("re-selecting the active harness restarts its pane in place");
  }

  const sessionRow = await findCell(page, "1 workbench-ui");
  if (!sessionRow) {
    throw new Error("could not locate the active session for its context menu");
  }
  await rightMouseDown(page, sessionRow.x + 3, sessionRow.y);
  await waitForText(page, "Close to the Top", 3000);
  await waitForText(page, "Close to the Bottom", 3000);
  await rightMouseUp(page, sessionRow.x + 3, sessionRow.y);
  await send(page, "\x1b");
  await waitForTextAbsent(page, "Close to the Top", 3000);
  location = await waitForReference(page, () => true, 5000);
  report("right-click session menu exposes vertical close actions");

  const terminalTab = await findCell(page, "Terminal 1");
  if (!terminalTab) {
    throw new Error("could not locate Terminal 1 for its context menu");
  }
  await rightMouseDown(page, terminalTab.x + 2, terminalTab.y);
  await waitForText(page, "Close Others", 3000);
  await waitForText(page, "Close to the Left", 3000);
  await waitForText(page, "Close to the Right", 3000);
  await rightMouseUp(page, terminalTab.x + 2, terminalTab.y);
  await send(page, "\x1b");
  location = await waitForReference(page, () => true, 5000);
  report("right-click tab menu exposes directional close actions");

  const longDraft = "long composer input ".repeat(24).trim();
  await paste(page, longDraft);
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === longDraft,
    5000
  );
  report("long wrapped composer remains visible inside the pane");
  await send(page, "\x1b");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "",
    5000
  );

  await typeCharacters(page, "first prompt");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "first prompt",
    5000
  );
  report("character-by-character composer input");

  // Move focus to the workspace side pane, then click inside the embedded
  // harness grid. The terminal's own mouse boundary must restore harness focus
  // before the next key is routed.
  await send(page, `\x1b[<0;${location.x};${location.y + 2}M`);
  await send(page, `\x1b[<0;${location.x};${location.y + 2}m`);
  await send(page, `\x1b[<0;${location.x + 3};${location.y + 3}M`);
  await send(page, `\x1b[<0;${location.x + 3};${location.y + 3}m`);
  await typeCharacters(page, " click", 4);
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "first prompt click",
    5000
  );
  report("clicking the harness grid focuses it for keyboard input");

  const clipboardBefore = await clipboardState(page);
  await drag(page, location.x + 1, location.y, location.x + "[META]".length);
  await waitForClipboardWrite(page, clipboardBefore.writes + 1, 3000);
  const afterSelection = await clipboardState(page);
  if (!afterSelection.text.includes("META")) {
    throw new Error(
      `Harness selection copied unexpected text: ${JSON.stringify(afterSelection)}`
    );
  }
  const beforeCopy = readFixture();
  if (!beforeCopy) {
    throw new Error("Simulated agent state disappeared before Ctrl+C");
  }
  const interruptsBeforeCopy = beforeCopy.state.controlCCount;
  await send(page, "\x03");
  await Bun.sleep(50);
  const afterCopy = readFixture();
  if (!afterCopy) {
    throw new Error("Simulated agent state disappeared after Ctrl+C");
  }
  if (afterCopy.state.controlCCount !== interruptsBeforeCopy) {
    throw new Error(
      "Ctrl+C interrupted the harness instead of copying its selection"
    );
  }
  report("Ctrl+C copies a harness selection");

  // Keep this click outside Silvery's double-click window. Otherwise it
  // intentionally selects a word, and the following Ctrl+C should copy rather
  // than exercise the no-selection interrupt path.
  await Bun.sleep(500);
  await send(page, `\x1b[<0;${location.x + 3};${location.y + 3}M`);
  await send(page, `\x1b[<0;${location.x + 3};${location.y + 3}m`);
  await send(page, "\x03");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.controlCCount === interruptsBeforeCopy + 1,
    3000
  );
  report("Ctrl+C remains a harness interrupt without a selection");

  await page.evaluate(() => (window as any).__setClipboard(" pasted"));
  await send(page, "\x16");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "first prompt click pasted",
    5000
  );
  report("Ctrl+V pastes the host clipboard into the harness composer");

  await send(page, "\r");
  location = await waitForReference(
    page,
    (fixture) =>
      fixture.state.submittedPrompts === 1 &&
      (Boolean(Bun.env.SILVERY_STRICT_TERMINAL) || fixture.state.working),
    Bun.env.SILVERY_STRICT_TERMINAL ? 20_000 : 5000
  );
  report("working indicator and streamed response begin");

  await typeCharacters(page, "draft while working", 9);
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "draft while working",
    5000
  );
  report("composer remains editable during feedback");

  await wheel(page, location.x + 5, location.y + 5, "up");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.scrollOffset === 3,
    5000
  );
  report("one wheel gesture produces one agent scroll step");
  await wheel(page, location.x + 5, location.y + 5, "down");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.scrollOffset === 0,
    5000
  );
  report("agent history returns to the live composer");

  // The user-reported corruption shape: scroll a conversation up and down
  // multiple times in a row. Each cycle overscrolls past the top clamp and
  // past the bottom clamp so wheel events keep arriving while the fixture is
  // already pinned, like a human flicking a wheel.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let step = 0; step < 10; step += 1) {
      await wheel(page, location.x + 5, location.y + 5, "up");
      await Bun.sleep(8);
    }
    for (let step = 0; step < 14; step += 1) {
      await wheel(page, location.x + 5, location.y + 5, "down");
      await Bun.sleep(8);
    }
  }
  location = await waitForReference(
    page,
    (fixture) => fixture.state.scrollOffset === 0,
    8000
  );
  report("repeated scroll cycles settle back on a clean composer");

  await send(page, "X\x7f");
  await paste(page, "\nsecond composer line");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer.endsWith("second composer line"),
    5000
  );
  report("backspace and multiline paste preserve one composer");

  await resizeOuter(page, 80, 24);
  location = await waitForReference(page, () => true, 8000);
  report("outer terminal resize during streaming");
  await resizeOuter(page, 120, 40);
  location = await waitForReference(page, () => true, 8000);

  // Resize the workspace side panel using the same SGR mouse path as a real
  // drag. The border immediately left of [META] owns that resize handle.
  await drag(page, location.x - 1, Math.max(5, location.y + 2), location.x + 4);
  location = await waitForReference(page, () => true, 8000);
  report("side panel resize during streaming");

  await send(page, "\x1b2");
  await waitForText(page, "Terminal 1", 5000);
  await send(page, "\x1b1");
  location = await waitForReference(page, () => true, 8000);
  report("switch away from and back to the agent");

  location = await waitForReference(
    page,
    (fixture) => !fixture.state.working,
    8000
  );
  await send(page, "\r");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.working && fixture.state.submittedPrompts === 2,
    5000
  );
  await typeCharacters(page, "next draft", 8);
  await resizeOuter(page, 120, 40);
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "next draft",
    8000
  );
  report("second submitted prompt survives feedback and resize");
  return location;
}

// Opt-in smoke test for the locally installed Codex TUI. Unlike --codex,
// which uses the deterministic Codex-shaped fixture in CI, this exercises the
// real application without resuming or writing to the user's conversation
// store. It is intentionally structural: model prose is nondeterministic, but
// duplicate status rows and a lost/duplicated composer are not.
async function runLiveCodexScenario(page: Page) {
  const draftMarker = `LIVE-CODEX-DRAFT-${process.pid}`;
  await waitForText(page, "OpenAI Codex (v", 20_000);
  await waitForOutputSettled(page, 5000);
  await Bun.sleep(100);

  await typeCharacters(page, `${draftMarker}x`, 8);
  await waitForText(page, `${draftMarker}x`, 5000);
  await send(page, "\x7f");
  await waitForText(page, draftMarker, 5000);
  assertVisibleCount(await bufferGrid(page), draftMarker, 1);
  report("live Codex composer accepts character input and backspace");

  await send(page, "\x15");
  await waitForTextAbsent(page, draftMarker, 5000);
  await exerciseLiveCodexResponse(page, "FIRST", 80, true);

  await typeCharacters(page, draftMarker, 6);
  await waitForText(page, draftMarker, 8000);
  assertVisibleCount(await bufferGrid(page), draftMarker, 1);
  report("live Codex scroll/stream/resize returns to one editable composer");

  await send(page, "\x15");
  await waitForTextAbsent(page, draftMarker, 5000);
  const cliHeader = await findCell(page, "CLI: Codex");
  if (cliHeader) {
    await drag(page, cliHeader.x - 2, 12, cliHeader.x + 4);
    await Bun.sleep(150);
  }
  await exerciseLiveCodexResponse(page, "SECOND", 100, false);
  await send(page, "\x1b2");
  await waitForText(page, "workspace$", 8000);
  await Bun.sleep(100);
  const traceCheckpoint = latestTraceSequence(frameTracePath);
  const shellMarker = `[LIVE-SHELL-${process.pid}]90`;
  await typeCharacters(
    page,
    `seq 1 90 | sed 's/^/[LIVE-SHELL-${process.pid}]/'`,
    2
  );
  await send(page, "\r");
  await waitForText(page, shellMarker, 8000);
  await Bun.sleep(500);
  assertNoPersistentFrameMismatch(frameTracePath, traceCheckpoint);
  await send(page, "\x1b1");
  await waitForText(page, "CLI: Codex", 5000);
  await Bun.sleep(100);
  await typeCharacters(page, draftMarker, 6);
  await waitForText(page, draftMarker, 8000);
  assertVisibleCount(await bufferGrid(page), draftMarker, 1);
  report("second live Codex prompt survives panel resize and tab switching");

  await send(page, "\x15");
  await send(page, "\x1b[104;5u");
  await waitForText(page, "Switch CLI harness", 3000);
  await waitForText(page, "Codex  refresh", 3000);
  const replayTraceStart = latestTraceSequence(frameTracePath);
  await send(page, "\r");
  await waitForText(page, "CLI: Codex", 5000);
  await Bun.sleep(1500);
  const replayDraft = `LIVE-REPLAY-DRAFT-${process.pid}`;
  await typeCharacters(page, replayDraft, 6);
  await waitForText(page, replayDraft, 8000);
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let step = 0; step < 12; step += 1) {
      await wheel(page, initialCols - 12, initialRows - 8, "up");
    }
    for (let step = 0; step < 18; step += 1) {
      await wheel(page, initialCols - 12, initialRows - 8, "down");
    }
  }
  await Bun.sleep(250);
  assertVisibleCount(await bufferGrid(page), replayDraft, 1);
  assertNoPersistentFrameMismatch(frameTracePath, replayTraceStart);
  report("resumed live Codex history returns to one editable composer");
}

function latestTraceSequence(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  let sequence = 0;
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    try {
      const entry = JSON.parse(line) as { sequence?: unknown };
      if (typeof entry.sequence === "number") {
        sequence = Math.max(sequence, entry.sequence);
      }
    } catch {
      // The trace can end with its currently buffered partial line.
    }
  }
  return sequence;
}

function assertNoPersistentFrameMismatch(path: string, afterSequence: number) {
  if (!existsSync(path)) {
    throw new Error("live frame trace was not written");
  }
  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const runs = new Map<string, { count: number; rows: number[] }>();
  for (const entry of entries) {
    if (
      entry.event !== "outer-grid" ||
      typeof entry.sequence !== "number" ||
      entry.sequence <= afterSequence ||
      entry.matchesExpected !== false ||
      typeof entry.expectedPanel !== "number" ||
      typeof entry.expectedRevision !== "number" ||
      !Array.isArray(entry.mismatchRows)
    ) {
      continue;
    }
    const rows = entry.mismatchRows.filter(
      (row): row is number => typeof row === "number"
    );
    // Whole-screen startup/layout handoffs precede a stable panel revision.
    // The corruption case is a partial terminal frame that remains displaced
    // while unrelated UI writes continue around it.
    if (rows.length === 0 || rows.length === Number(entry.rows)) {
      continue;
    }
    const key = `${entry.expectedPanel}:${entry.expectedRevision}`;
    const run = runs.get(key) ?? { count: 0, rows };
    run.count += 1;
    runs.set(key, run);
  }
  const persistent = [...runs.entries()].find(([, run]) => run.count >= 3);
  if (persistent) {
    const [revision, run] = persistent;
    throw new Error(
      `outer terminal diverged from panel ${revision} for ${run.count} frames ` +
        `(rows ${run.rows.join(",")})`
    );
  }
}

async function exerciseLiveCodexResponse(
  page: Page,
  prefix: string,
  rows: number,
  resize: boolean
) {
  const finalRow = String(rows - 1).padStart(3, "0");
  const responseEndMarker = `LIVE-${prefix}-END-${process.pid}`;
  const prompt =
    `Print ${rows} short lines numbered LIVE-${prefix}-000 through ` +
    `LIVE-${prefix}-${finalRow}, then concatenate and print ` +
    `"LIVE-${prefix}-END-" and "${process.pid}". ` +
    "Do not use tools and do not add other text.";
  await paste(page, prompt);
  await waitForText(page, "Do not use tools", 5000);
  await send(page, "\r");
  await waitForText(page, "Working", 5000);

  const wheelCol = Math.max(10, initialCols - 12);
  const wheelRow = Math.max(8, initialRows - 8);
  const deadline = Date.now() + 60_000;
  let sawWorking = true;
  let sawResponseEnd = false;
  let cycle = 0;
  while (Date.now() < deadline && !sawResponseEnd) {
    for (let step = 0; step < 8; step += 1) {
      await wheel(page, wheelCol, wheelRow, "up");
    }
    for (let step = 0; step < 12; step += 1) {
      await wheel(page, wheelCol, wheelRow, "down");
    }
    if (resize && cycle === 1) {
      await resizeOuter(page, 80, 24);
    } else if (resize && cycle === 2) {
      await resizeOuter(page, initialCols, initialRows);
    }
    cycle += 1;
    const grid = await bufferGrid(page);
    const text = grid.lines.join("\n");
    const workingCount = grid.lines.filter((line) =>
      line.includes("Working")
    ).length;
    if (workingCount > 1) {
      throw new Error(
        `live Codex duplicated its working row ${workingCount} times after scrolling`
      );
    }
    sawWorking ||= workingCount === 1;
    sawResponseEnd = text.includes(responseEndMarker);
    await Bun.sleep(75);
  }
  if (!sawWorking) {
    throw new Error("live Codex never displayed a working indicator");
  }
  if (!sawResponseEnd) {
    throw new Error("live Codex did not finish the marked response");
  }

  // Codex handles Workbench wheel events in its native transcript pager. It
  // may automatically leave that pager when a down-wheel reaches the live
  // edge, so only send pager keys while its header remains visible.
  if (
    (await bufferGrid(page)).lines.join("\n").includes("T R A N S C R I P T")
  ) {
    await send(page, "\x1b[F");
    await Bun.sleep(100);
    if (
      (await bufferGrid(page)).lines.join("\n").includes("T R A N S C R I P T")
    ) {
      await send(page, "q");
    }
  }
  await Bun.sleep(250);
}

function assertVisibleCount(grid: Grid, marker: string, expected: number) {
  const count = grid.lines.join("\n").split(marker).length - 1;
  if (count !== expected) {
    throw new Error(
      `${JSON.stringify(marker)} appears ${count} times; expected ${expected}`
    );
  }
}

// Claude-Code-shaped agents render inline on the primary buffer without mouse
// tracking, so wheel gestures make tmux enter and leave copy-mode with a full
// pane redraw each time. This is the reported real-world corruption shape:
// scroll a conversation up and down several times and the input box breaks.
async function runInlineAgentScenario(page: Page, initial: Location) {
  let location = initial;
  const wheelAt = () => ({
    x: location.x + 5,
    y: Math.max(2, location.y - 5),
  });
  // delayMs 0 models flick/momentum scrolling, where the terminal delivers a
  // burst of SGR wheel reports in a single read; a small delay models slow
  // deliberate ticks. Users mix both, so the cycles below do too.
  const wheelCycles = async (
    cycles: number,
    up: number,
    down: number,
    delayMs: number
  ) => {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let step = 0; step < up; step += 1) {
        const at = wheelAt();
        await wheel(page, at.x, at.y, "up");
        if (delayMs > 0) {
          await Bun.sleep(delayMs);
        }
      }
      await Bun.sleep(60);
      for (let step = 0; step < down; step += 1) {
        const at = wheelAt();
        await wheel(page, at.x, at.y, "down");
        if (delayMs > 0) {
          await Bun.sleep(delayMs);
        }
      }
      await Bun.sleep(60);
    }
  };

  await typeCharacters(page, "inline prompt");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "inline prompt",
    5000
  );
  report("inline agent composer input");

  if (options.codex) {
    for (let step = 0; step < 80; step += 1) {
      const at = wheelAt();
      await wheel(page, at.x, at.y, "up");
    }
    const scrolledGrid = await waitForTranscriptGrid(page, 5000);
    const scrolledText = scrolledGrid.lines.join("\n");
    for (const marker of ["[META]", "[CMP0]", "[CMP1]", "[CMP2]", "[CMP3]"]) {
      const count = scrolledText.split(marker).length - 1;
      if (count !== 0) {
        throw new Error(
          `Codex wheel-up did not leave the live composer: expected 0 ${marker} markers, found ${count}`
        );
      }
    }
    const visibleHistoryMarkers = scrolledText.match(/\[H\d{3}\]/g) ?? [];
    if (new Set(visibleHistoryMarkers).size < 3) {
      throw new Error(
        `Codex wheel-up exposed only ${visibleHistoryMarkers.length} conversation markers`
      );
    }
    if (new Set(visibleHistoryMarkers).size !== visibleHistoryMarkers.length) {
      throw new Error("Codex wheel-up duplicated conversation history markers");
    }
    for (let step = 0; step < 80; step += 1) {
      const at = wheelAt();
      await wheel(page, at.x, at.y, "down");
    }
    await Bun.sleep(200);
    {
      const at = wheelAt();
      await wheel(page, at.x, at.y, "down");
    }
    location = await waitForReference(
      page,
      (fixture) => fixture.state.composer === "inline prompt",
      5000
    );
    report("Codex wheel scroll reveals history and returns to one composer");
  }

  await wheelCycles(5, 8, 12, 8);
  await wheelCycles(6, 30, 40, 0);
  if (options.codex) {
    await Bun.sleep(200);
    const at = wheelAt();
    await wheel(page, at.x, at.y, "down");
  }
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "inline prompt",
    8000
  );
  report(
    options.codex
      ? "Codex wheel navigation keeps duplicated redraws out of the viewport"
      : "idle copy-mode scroll cycles settle on a clean inline frame"
  );

  await send(page, "\r");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.working && fixture.state.submittedPrompts === 1,
    5000
  );
  await wheelCycles(3, 8, 14, 8);
  await wheelCycles(3, 24, 32, 0);
  location = await waitForReference(
    page,
    (fixture) => !fixture.state.working,
    10_000
  );
  report("copy-mode scroll cycles during streaming settle cleanly");

  for (let step = 0; step < 6; step += 1) {
    const at = wheelAt();
    await wheel(page, at.x, at.y, "up");
    await Bun.sleep(8);
  }
  await Bun.sleep(100);
  await typeCharacters(page, "back at bottom");
  location = await waitForReference(
    page,
    (fixture) => fixture.state.composer === "back at bottom",
    5000
  );
  report("typing while scrolled up returns to a live inline composer");
  return location;
}

async function runPlainShellScenario(page: Page) {
  await send(page, "\x1b2");
  await Bun.sleep(500);
  await send(page, "PS1='[SHELL-PROMPT] '; export PS1\r");
  // The command can wrap between `export` and `PS1` at narrow pane widths,
  // so readiness is keyed to the resulting prompt rather than command echo.
  await waitForText(page, "[SHELL-PROMPT]", 5000);

  await typeCharacters(page, "printf '[SHELL-TYPE] okx", 4);
  await send(page, "\x7f'\r");
  await waitForPromptAfter(page, "[SHELL-TYPE] ok", 5000);
  report("real shell character input and backspace");

  await paste(page, "printf '[SHELL-PASTE] ok'");
  // A real user cannot press Enter in the same sub-millisecond timeslice as a
  // paste. Let the bracketed-paste end marker reach the inner shell first.
  await Bun.sleep(20);
  await send(page, "\r");
  await waitForPromptAfter(page, "[SHELL-PASTE] ok", 5000);
  report("real shell bracketed paste");

  await send(
    page,
    "for i in 1 2 3 4 5 6 7 8; do printf '[SHELL-STREAM-%s]\\n' \"$i\"; sleep .06; done\r"
  );
  await waitForText(page, "[SHELL-STREAM-2]", 5000);
  await wheel(page, 60, 12, "up");
  await Bun.sleep(100);
  // Any real input exits tmux copy mode before it reaches the shell. Backspace
  // is harmless while the foreground streaming loop owns the terminal.
  await send(page, "\x7f");
  await resizeOuter(page, 100, 30);
  await resizeOuter(page, 120, 40);
  await waitForText(page, "[SHELL-STREAM-8]", 5000);
  await send(page, "printf '[SHELL-AFTER] ok'\r");
  await waitForPromptAfter(page, "[SHELL-AFTER] ok", 5000);
  report("real shell streaming, scroll, resize, and resumed input");

  await send(
    page,
    "clear; for i in $(seq 1 120); do printf '[SHELL-EDGE-%03d] row\\n' \"$i\"; sleep .01; done\r"
  );
  await waitForConsecutiveShellRows(page, "SHELL-EDGE", 120, 8000);
  report("real shell scrolls past the pane bottom without repeated rows");

  await send(
    page,
    "clear; for i in $(seq 1 240); do printf '[SHELL-BATCH-%03d] row\\n' \"$i\"; if ((i % 8 == 0)); then sleep .04; fi; done\r"
  );
  await waitForConsecutiveShellRows(page, "SHELL-BATCH", 240, 10_000);
  report("real shell multi-row frames do not corrupt the bottom edge");

  await send(
    page,
    "clear; for i in $(seq 1 2000); do printf '[SHELL-BURST-%04d] row\\n' \"$i\"; done\r"
  );
  await waitForConsecutiveShellRows(page, "SHELL-BURST", 2000, 10_000);
  report("real shell unthrottled burst does not corrupt the bottom edge");

  await send(
    page,
    "clear; for i in $(seq 1 160); do printf '[SHELL-WHEEL-%03d] row\\n' \"$i\"; sleep .01; done\r"
  );
  await waitForConsecutiveShellRows(page, "SHELL-WHEEL", 160, 10_000, true);
  report("real shell bottom-edge output survives scrollback and return");

  await send(
    page,
    "clear; for i in $(seq 1 180); do printf '[SHELL-UNICODE-%03d] ● 工作 … ↻\\n' \"$i\"; sleep .005; done\r"
  );
  await waitForConsecutiveShellRows(page, "SHELL-UNICODE", 180, 10_000, true);
  report("real shell Unicode rows preserve wide-cell alignment at the bottom");

  // Repeated tmux copy-mode enter/exit cycles over an idle prompt: the
  // user-reported "scroll up and down multiple times" path for panes whose
  // program does not track the mouse, where tmux owns the scrollback.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let step = 0; step < 6; step += 1) {
      await wheel(page, 60, 12, "up");
      await Bun.sleep(8);
    }
    for (let step = 0; step < 12; step += 1) {
      await wheel(page, 60, 12, "down");
      await Bun.sleep(8);
    }
  }
  report("repeated idle copy-mode scroll cycles");

  const finalCommand =
    "clear; for i in 1 2 3 4 5 6 7 8; do printf '[S%03d] reference row\\n' \"$i\"; done\r";
  await send(page, finalCommand);
  await waitForText(page, "[S008] reference row", 5000);
  const grid = await bufferGrid(page);
  for (let index = 1; index <= 8; index += 1) {
    const marker = `[S${String(index).padStart(3, "0")}]`;
    const count = grid.lines.join("\n").split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`plain shell marker ${marker} appears ${count} times`);
    }
  }
  report("real shell settled grid has no duplicate or missing rows");
}

async function runSoak(page: Page, initial: Location, operations: number) {
  let location = initial;
  let seed = 0x5e_ed_20_26;
  const sizes = [
    [80, 24],
    [120, 40],
    [200, 68],
    [257, 68],
  ] as const;
  for (let index = 0; index < operations; index += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    switch (seed % 9) {
      case 0:
      case 1:
      case 2:
        await send(page, String.fromCharCode(97 + (seed % 26)));
        break;
      case 3:
        await send(page, "\x7f");
        break;
      case 4:
        await send(page, "\x1b[5~");
        break;
      case 5:
        await send(page, "\x1b[6~");
        break;
      case 6:
        await paste(page, `p${index}`);
        break;
      case 7: {
        const size = sizes[(seed >>> 8) % sizes.length] ?? sizes[1];
        await resizeOuter(page, size[0], size[1]);
        break;
      }
      default:
        await send(page, "\x1b2");
        // Legacy Alt+digit is ESC-prefixed. Leave enough separation for the
        // input parser's ESC ambiguity window, then prove we returned to the
        // agent before subsequent soak keys can reach the shell.
        await Bun.sleep(100);
        await send(page, "\x1b1");
        location = await waitForReference(page, () => true, 3000);
        break;
    }
    if ((index + 1) % 25 === 0) {
      location = await waitForReference(page, () => true, 10_000);
    }
  }
  report(`${operations}-operation deterministic soak`);
  return location;
}

async function assertIdleWindows(page: Page, count: number) {
  const noisy: { bytes: number; sample: number }[] = [];
  // Diff discovery can legitimately cause one startup frame after the first
  // agent frame is visible. Require a full period of quiescence before calling
  // the terminal idle; the removed cursor timer could never satisfy this gate.
  await waitForOutputQuiet(page, 1250, 6000);
  for (let index = 0; index < count; index += 1) {
    await waitForReference(page, (fixture) => !fixture.state.working, 8000);
    await waitForOutputQuiet(page, 250, 3000);
    const before = await outputStats(page);
    await Bun.sleep(1100);
    const after = await outputStats(page);
    const bytes = after.outputBytes - before.outputBytes;
    if (bytes === 0) {
      report(`idle output sample ${index + 1}/${count}: zero bytes`);
    } else {
      noisy.push({ bytes, sample: index + 1 });
      console.log(
        `RED  idle output sample ${index + 1}/${count}: emitted ${bytes} bytes`
      );
    }
  }
  if (noisy.length > 0) {
    throw new Error(
      `idle terminal emitted periodic output in ${noisy.length}/${count} samples: ${noisy.map(({ bytes, sample }) => `${sample}:${bytes}`).join(", ")}`
    );
  }
}

async function waitForOutputQuiet(
  page: Page,
  quietMs: number,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  let previous = await outputStats(page);
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(25);
    const current = await outputStats(page);
    if (current.outputBytes !== previous.outputBytes) {
      previous = current;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs) {
      return;
    }
  }
  throw new Error(`terminal output did not become quiet within ${timeoutMs}ms`);
}

async function waitForReference(
  page: Page,
  predicate: (fixture: FixtureEnvelope) => boolean,
  timeoutMs: number
): Promise<Location> {
  const deadline = Date.now() + timeoutMs;
  let mismatch = "fixture state has not been written";
  while (Date.now() < deadline) {
    const fixture = readFixture();
    if (!(fixture && predicate(fixture))) {
      await Bun.sleep(10);
      continue;
    }
    const frame = options.inline
      ? renderSimulatedInlineBlock(fixture.state, fixture.cols)
      : renderSimulatedAgentFrame(fixture.state, fixture.cols, fixture.rows);
    const grid = await bufferGrid(page);
    const found = locateFrame(grid, frame);
    if (found.ok) {
      const next = readFixture();
      if (next?.state.generation !== fixture.state.generation) {
        await Bun.sleep(5);
        continue;
      }
      const cursor = await page.evaluate(() => (window as any).__cursorState());
      const expectedCursor = {
        visible: frame.cursor.visible,
        x: found.x + frame.cursor.x,
        y: found.y + frame.cursor.y,
      };
      const cursorCell = await page.evaluate(
        ({ x, y }) => (window as any).__cellState(x, y),
        expectedCursor
      );
      const cursorPositioned =
        cursor.x === expectedCursor.x && cursor.y === expectedCursor.y;
      const cursorPainted = cursor.visible || cursorCell?.inverse === true;
      if (!(options.idleOnly || (cursorPositioned && cursorPainted))) {
        mismatch = `cursor ${JSON.stringify(cursor)} cell=${JSON.stringify(cursorCell)} != ${JSON.stringify(expectedCursor)}`;
        await Bun.sleep(10);
        continue;
      }
      validateMarkers(grid, fixture);
      if (options.inline) {
        validateInlineTail(grid, fixture, found.x, found.y);
      }
      return { fixture, frame, x: found.x, y: found.y };
    }
    mismatch = found.reason;
    await Bun.sleep(10);
  }
  throw new Error(`settled frame never matched clean reference: ${mismatch}`);
}

function locateFrame(
  grid: Grid,
  frame: SimulatedAgentFrame
): { ok: true; x: number; y: number } | { ok: false; reason: string } {
  const meta = frame.lines[0]?.trimEnd() ?? "[META]";
  for (let y = 0; y < grid.lines.length; y += 1) {
    const x = grid.lines[y]?.indexOf(meta) ?? -1;
    if (x === -1) {
      continue;
    }
    for (let row = 0; row < frame.lines.length; row += 1) {
      const expected = frame.lines[row] ?? "";
      const actual = grid.lines[y + row]?.slice(x, x + expected.length);
      if (actual !== expected) {
        return {
          ok: false,
          reason: `row ${row} differs at outer ${x},${y + row}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
        };
      }
    }
    return { ok: true, x, y };
  }
  return {
    ok: false,
    reason: `missing reference meta row ${JSON.stringify(meta)}`,
  };
}

function validateInlineTail(
  grid: Grid,
  fixture: FixtureEnvelope,
  x: number,
  y: number
) {
  const conversation = simulatedConversationRows(fixture.state, fixture.cols);
  let headerY = -1;
  for (let row = y - 1; row >= 0; row -= 1) {
    if (grid.lines[row]?.slice(x).startsWith(" CLI:")) {
      headerY = row;
      break;
    }
  }
  const visibleConversationRows = Math.max(0, y - headerY - 1);
  const depth = Math.min(
    INLINE_TAIL_ROWS,
    conversation.length,
    visibleConversationRows
  );
  for (let offset = 1; offset <= depth; offset += 1) {
    const expected = conversation[conversation.length - offset] ?? "";
    const actual = grid.lines[y - offset]?.slice(x, x + expected.length);
    if (actual !== expected) {
      throw new Error(
        `inline tail row ${offset} above the block differs at outer ${x},${y - offset}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
      );
    }
  }
}

function validateMarkers(grid: Grid, fixture: FixtureEnvelope) {
  const text = grid.lines.join("\n");
  for (const marker of ["[META]", "[CMP0]", "[CMP1]", "[CMP2]", "[CMP3]"]) {
    const count = text.split(marker).length - 1;
    if (count !== 1) {
      throw new Error(`${marker} appears ${count} times in settled outer grid`);
    }
  }
  const workingCount = text.split("[WORK]").length - 1;
  if (workingCount !== (fixture.state.working ? 1 : 0)) {
    throw new Error(
      `[WORK] appears ${workingCount} times; expected ${fixture.state.working ? 1 : 0}`
    );
  }
}

function readFixture(): FixtureEnvelope | undefined {
  if (!existsSync(agentStatePath)) {
    return;
  }
  try {
    return JSON.parse(readFileSync(agentStatePath, "utf8")) as FixtureEnvelope;
  } catch {
    return;
  }
}

async function bufferGrid(page: Page): Promise<Grid> {
  return page.evaluate(() => (window as any).__bufferGrid());
}

async function waitForTranscriptGrid(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const grid = await bufferGrid(page);
    const text = grid.lines.join("\n");
    const markers = text.match(/\[H\d{3}\]/g) ?? [];
    if (text.includes("T R A N S C R I P T") && new Set(markers).size >= 3) {
      return grid;
    }
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for a settled Codex transcript frame");
}

async function clipboardState(
  page: Page
): Promise<{ text: string; writes: number }> {
  return page.evaluate(() => (window as any).__clipboardState());
}

async function waitForClipboardWrite(
  page: Page,
  writes: number,
  timeoutMs: number
) {
  await page.waitForFunction(
    (expected) => (window as any).__clipboardState().writes >= expected,
    writes,
    { timeout: timeoutMs }
  );
}

async function safeGrid(page: Page): Promise<Grid | undefined> {
  return bufferGrid(page).catch(() => undefined);
}

async function outputStats(page: Page): Promise<{
  outputBytes: number;
  outputEvents: number;
  parsedWrites: number;
}> {
  return page.evaluate(() => (window as any).__outputStats());
}

async function send(page: Page, data: string) {
  await page.evaluate((payload) => (window as any).__send(payload), data);
}

async function paste(page: Page, data: string) {
  await page.evaluate((payload) => (window as any).__paste(payload), data);
}

async function resizeOuter(page: Page, cols: number, rows: number) {
  await page.evaluate(
    ({ cols, rows }) => (window as any).__resizeTerminal(cols, rows),
    { cols, rows }
  );
  await Bun.sleep(20);
}

async function typeCharacters(page: Page, value: string, delayMs = 6) {
  for (const char of value) {
    await send(page, char);
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }
  }
}

async function drag(page: Page, fromCol: number, row: number, toCol: number) {
  await send(page, `\x1b[<0;${fromCol + 1};${row + 1}M`);
  await send(page, `\x1b[<32;${toCol + 1};${row + 1}M`);
  await send(page, `\x1b[<0;${toCol + 1};${row + 1}m`);
}

async function wheel(
  page: Page,
  col: number,
  row: number,
  direction: "up" | "down"
) {
  await send(page, `\x1b[<${direction === "up" ? 64 : 65};${col};${row}M`);
}

async function rightMouseDown(page: Page, col: number, row: number) {
  await send(page, `\x1b[<2;${col + 1};${row + 1}M`);
}

async function rightMouseUp(page: Page, col: number, row: number) {
  await send(page, `\x1b[<2;${col + 1};${row + 1}m`);
}

async function findCell(
  page: Page,
  needle: string
): Promise<{ x: number; y: number } | undefined> {
  const grid = await bufferGrid(page);
  for (let y = 0; y < grid.lines.length; y += 1) {
    const x = grid.lines[y]?.indexOf(needle) ?? -1;
    if (x !== -1) {
      return { x, y };
    }
  }
}

async function waitForText(page: Page, needle: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const grid = await bufferGrid(page);
    if (grid.lines.join("\n").includes(needle)) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
}

async function waitForAnyText(
  page: Page,
  needles: string[],
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await bufferGrid(page)).lines.join("\n");
    const match = needles.find((needle) => text.includes(needle));
    if (match) {
      return match;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for any of ${JSON.stringify(needles)}`);
}

async function waitForOutputSettled(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let settledSince = 0;
  while (Date.now() < deadline) {
    const settled = await page.evaluate(() => {
      const stats = (window as any).__outputStats?.();
      return Boolean(stats && stats.outputEvents === stats.parsedWrites);
    });
    if (settled) {
      settledSince ||= Date.now();
      // Silvery's asynchronous DEC width-mode probes are scheduled shortly
      // after the splash paint. Give all four queries time to reach xterm and
      // their replies time to return before the test's first real keypress.
      if (Date.now() - settledSince >= 250) {
        return;
      }
    } else {
      settledSince = 0;
    }
    await Bun.sleep(10);
  }
  throw new Error("outer terminal output did not settle");
}

async function waitForTextAbsent(
  page: Page,
  needle: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const grid = await bufferGrid(page);
    if (!grid.lines.join("\n").includes(needle)) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)} to close`);
}

async function waitForPromptAfter(
  page: Page,
  marker: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await bufferGrid(page)).lines.join("\n");
    const markerAt = text.lastIndexOf(marker);
    const promptAt = text.lastIndexOf("[SHELL-PROMPT]");
    if (markerAt !== -1 && promptAt > markerAt) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out waiting for shell prompt after ${JSON.stringify(marker)}`
  );
}

async function waitForConsecutiveShellRows(
  page: Page,
  prefix: string,
  finalRow: number,
  timeoutMs: number,
  exerciseScrollback = false
) {
  const marker = new RegExp(`\\[${prefix}-(\\d+)\\]`, "g");
  const deadline = Date.now() + timeoutMs;
  let scrolled = false;
  while (Date.now() < deadline) {
    const { grid, outputSettled, synchronizedOutputMode } =
      await settledBufferGrid(page);
    const values = grid.lines.flatMap((line) =>
      [...line.matchAll(marker)].map((match) => Number(match[1]))
    );
    if (outputSettled && !synchronizedOutputMode) {
      const unique = new Set(values);
      if (unique.size !== values.length) {
        throw new Error(
          `${prefix} contains repeated visible rows: ${values.join(",")}`
        );
      }
      for (let index = 1; index < values.length; index += 1) {
        if (values[index] !== values[index - 1] + 1) {
          throw new Error(
            `${prefix} visible rows are displaced: ${values.join(",")}`
          );
        }
      }
    }
    const latest = values.at(-1) ?? 0;
    if (exerciseScrollback && !scrolled && latest >= 30) {
      for (let index = 0; index < 4; index += 1) {
        await wheel(page, 60, 12, "up");
      }
      await Bun.sleep(120);
      // Exercise the user's actual path: scroll naturally back to the live
      // bottom while output continues, without using a key to leave copy mode.
      for (let index = 0; index < 12; index += 1) {
        await wheel(page, 60, 12, "down");
      }
      scrolled = true;
    }
    const text = grid.lines.join("\n");
    if (
      outputSettled &&
      !synchronizedOutputMode &&
      latest === finalRow &&
      text.lastIndexOf("[SHELL-PROMPT]") >
        text.lastIndexOf(
          `[${prefix}-${String(finalRow).padStart(
            Math.max(3, String(finalRow).length),
            "0"
          )}]`
        )
    ) {
      if (values.length < 8) {
        throw new Error(
          `${prefix} exposed only ${values.length} rows at the bottom edge`
        );
      }
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`${prefix} did not settle on row ${finalRow}`);
}

async function settledBufferGrid(page: Page): Promise<{
  grid: Grid;
  outputSettled: boolean;
  synchronizedOutputMode: boolean;
}> {
  return page.evaluate(() => {
    const stats = (window as any).__outputStats?.();
    return {
      grid: (window as any).__bufferGrid(),
      outputSettled: Boolean(
        stats && stats.outputEvents === stats.parsedWrites
      ),
      synchronizedOutputMode: Boolean(
        (window as any).__synchronizedOutputMode?.()
      ),
    };
  });
}

function killIsolatedTmux(homePath: string) {
  const socket = join(homePath, ".workbench", "tmux-ui.sock");
  if (!existsSync(socket)) {
    return;
  }
  Bun.spawnSync(["tmux", "-S", socket, "kill-server"], {
    stderr: "ignore",
    stdout: "ignore",
  });
}

async function waitForServer(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(
        `terminal regression server exited before ready: ${output}`
      );
    }
    output += decoder.decode(value, { stream: true });
    if (output.includes("READY ")) {
      return;
    }
  }
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  output: string[]
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    output.push(decoder.decode(value, { stream: true }));
  }
}

function report(message: string) {
  console.log(`PASS ${message}`);
}

function parseSize(value: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`invalid --size ${value}; expected COLSxROWS`);
  }
  return [Number(match[1]), Number(match[2])];
}

function parseOptions(args: string[]) {
  const result = {
    appRoot: undefined as string | undefined,
    chunkSeed: undefined as number | undefined,
    codex: false,
    idleOnly: false,
    idleSamples: 1,
    inline: false,
    keepArtifacts: false,
    liveCodex: false,
    label: undefined as string | undefined,
    plainOnly: false,
    size: undefined as string | undefined,
    soak: 0,
    stickyTranscript: false,
    theme: undefined as string | undefined,
    traceFrames: false,
  };
  for (const arg of args) {
    if (arg === "--idle-only") {
      result.idleOnly = true;
    } else if (arg === "--codex") {
      result.codex = true;
    } else if (arg === "--inline") {
      result.inline = true;
    } else if (arg === "--keep-artifacts") {
      result.keepArtifacts = true;
    } else if (arg === "--live-codex") {
      result.liveCodex = true;
      result.codex = true;
    } else if (arg === "--plain-only") {
      result.plainOnly = true;
    } else if (arg.startsWith("--app-root=")) {
      result.appRoot = arg.slice("--app-root=".length);
    } else if (arg.startsWith("--chunk-seed=")) {
      result.chunkSeed = Number(arg.slice("--chunk-seed=".length));
    } else if (arg.startsWith("--idle-samples=")) {
      result.idleSamples = Number(arg.slice("--idle-samples=".length));
    } else if (arg.startsWith("--label=")) {
      result.label = arg.slice("--label=".length);
    } else if (arg.startsWith("--size=")) {
      result.size = arg.slice("--size=".length);
    } else if (arg.startsWith("--soak=")) {
      result.soak = Number(arg.slice("--soak=".length));
    } else if (arg === "--sticky-transcript") {
      result.stickyTranscript = true;
      result.codex = true;
      result.inline = true;
    } else if (arg.startsWith("--theme=")) {
      result.theme = arg.slice("--theme=".length);
    } else if (arg === "--trace-frames") {
      result.traceFrames = true;
    }
  }
  if (
    !(
      result.idleSamples > 0 &&
      result.soak >= 0 &&
      (result.chunkSeed === undefined || Number.isInteger(result.chunkSeed))
    )
  ) {
    throw new Error(
      "idle samples must be positive and soak must be non-negative"
    );
  }
  if (result.liveCodex && (result.inline || result.plainOnly)) {
    throw new Error("--live-codex cannot be combined with fixture scenarios");
  }
  return result;
}
