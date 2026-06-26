import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

const root = join(import.meta.dir, "..");
const screenshotDir = join(root, "artifacts", "screenshots");
const port = Number(Bun.env.WORKBENCH_SCREENSHOT_PORT ?? "4177");

mkdirSync(screenshotDir, { recursive: true });

const server = Bun.spawn(["bun", "test-harness/server.ts"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...Bun.env,
    WORKBENCH_SCREENSHOT_PORT: String(port),
    // Diff polling is skipped in screenshot mode by default; force it on so the
    // Changes tab populates against the working tree for the diff check below.
    WORKBENCH_UI_FORCE_DIFF: "1",
  },
});

const failures: string[] = [];

try {
  await waitForServer(server.stdout as ReadableStream<Uint8Array>);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1840, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(
    () =>
      Boolean(
        (window as any).__workbenchReady && (window as any).__workbenchSawOutput
      ),
    {
      timeout: 8000,
    }
  );
  // Give the active session's workbench chat PTY time to spawn and draw.
  await page.waitForTimeout(2500);

  // 1. The default harness tab should render and remain live. Some harnesses
  // do not echo typed text immediately, so input fidelity is covered by the
  // terminal tab check below.
  const harnessVisible = await waitForText(page, "Claude Code", 8000);
  report("default harness pane renders", harnessVisible);
  await page.screenshot({ path: join(screenshotDir, "workbench.png") });

  // 2. Clicking the Terminal 1 tab focuses its shell; typing should reach it.
  const terminalTab = await findCell(page, "Terminal 1");
  if (terminalTab) {
    await click(page, terminalTab.col + 2, terminalTab.row + 1);
    await page.waitForTimeout(500);
    await send(page, "echo TERMINAL_OK\r");
    const terminalEcho = await waitForText(page, "TERMINAL_OK", 4000);
    report("terminal tab receives keystrokes", terminalEcho);
  } else {
    report("Terminal 1 tab located", false);
  }

  // 3. Back on the harness tab, clicking a file in the explorer opens the editor.
  const chatTab = await findCell(page, "Claude Code");
  if (chatTab) {
    await click(page, chatTab.col + 2, chatTab.row + 1);
    await page.waitForTimeout(400);
  }
  const fileCell = await findCell(page, "sample.ts", 26, 56);
  if (fileCell) {
    await click(page, fileCell.col + 2, fileCell.row + 1);
    const editorOpened = await waitForText(page, "FIXTURE_MARKER", 4000);
    report("explorer click opens file in editor", editorOpened);
    report(
      "editor pane syntax parses keywords",
      await keywordIsHighlighted(page)
    );
    for (let i = 0; i < 8; i++) {
      await wheel(page, 90, 20, 1);
    }
    const editorScrolled = await waitForText(
      page,
      "SCROLL_TARGET_SENTINEL",
      3000
    );
    report("editor pane scrolls with wheel", editorScrolled);
    await page.screenshot({
      path: join(screenshotDir, "workbench-editor.png"),
    });
  } else {
    report("explorer shows sample.ts", false);
  }

  // 3b. The README.md tab renders markdown (heading shown without its "# ").
  const mdTab = await findCell(page, "README.md");
  if (mdTab) {
    await click(page, mdTab.col + 2, mdTab.row + 1);
    await page.waitForTimeout(600);
    const buffer = await bufferText(page);
    const renderedHeading =
      buffer.includes("Workbench") && !buffer.includes("# Workbench");
    report("markdown tab renders formatted markdown", renderedHeading);
    await page.screenshot({
      path: join(screenshotDir, "workbench-markdown.png"),
    });
  } else {
    report("README.md tab located", false);
  }

  // 3c. The image tab decodes and renders as colored half-blocks (no "(binary file)").
  const imgTab = await findCell(page, "sample.png");
  if (imgTab) {
    await click(page, imgTab.col + 2, imgTab.row + 1);
    const halfBlocksDrawn = await waitForText(page, "\u2580", 5000);
    const notBinary = !(await bufferText(page)).includes("(binary file)");
    report("image tab renders half-block art", halfBlocksDrawn && notBinary);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotDir, "workbench-image.png") });
  } else {
    report("sample.png tab located", false);
  }

  // 3c-ii. A markdown file with a ```mermaid block renders the diagram as an
  // image (half-block art in screenshot mode), not as raw source.
  const diagramTab = await findCell(page, "diagram.md");
  if (diagramTab) {
    await click(page, diagramTab.col + 2, diagramTab.row + 1);
    await waitForText(page, "test-harness/diagram.md", 4000);
    // mermaid-cli renders to a cached PNG on first view; wait for the loading
    // placeholder to clear (returns immediately when the PNG is already cached).
    await waitForTextGone(page, "rendering diagram", 15_000);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: join(screenshotDir, "workbench-mermaid.png"),
    });
    const buffer = await bufferText(page);
    // Success replaces the raw source with half-block art, so the diagram's
    // source ("graph TD") must be gone and block glyphs (▀) present.
    const diagramDrawn =
      buffer.includes("\u2580") && !buffer.includes("graph TD");
    report("mermaid block renders as a diagram image", diagramDrawn);
  } else {
    report("diagram.md tab located", false);
  }

  // 3c-iii. The PDF tab rasterizes page 1 (via pdftoppm) and renders it as
  // half-block art, with a "PDF page 1" header, not as "(binary file)".
  const pdfTab = await findCell(page, "sample.pdf");
  if (pdfTab) {
    await click(page, pdfTab.col + 2, pdfTab.row + 1);
    const headerShown = await waitForText(page, "PDF page 1", 4000);
    const pdfDrawn = await waitForText(page, "\u2580", 12_000);
    const notBinary = !(await bufferText(page)).includes("(binary file)");
    report(
      "pdf tab renders page as half-block art",
      headerShown && pdfDrawn && notBinary
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(screenshotDir, "workbench-pdf.png") });
  } else {
    report("sample.pdf tab located", false);
  }

  // 3c-iv. The video tab probes the clip and starts ffmpeg frame extraction,
  // showing the scrubber controls once ready (not "(binary file)"). The frame
  // shown depends on playback timing, so this is asserted by text only and not
  // captured as a golden screenshot. Space pauses playback afterward.
  const videoTab = await findCell(page, "sample.mp4");
  if (videoTab) {
    await click(page, videoTab.col + 2, videoTab.row + 1);
    const controlsShown = await waitForText(page, "Space play/pause", 12_000);
    const notBinary = !(await bufferText(page)).includes("(binary file)");
    report(
      "video tab probes clip and renders scrubber",
      controlsShown && notBinary
    );
    await send(page, " ");
    await page.waitForTimeout(300);
  } else {
    report("sample.mp4 tab located", false);
  }

  // 3d. The Changes tab shows the working-tree diff: an aggregate header
  // ("vs HEAD") plus a unified patch for the selected file.
  const changesTab =
    (await findCell(page, "Changes", 26)) ??
    (await findCell(page, "\u25cf", 26));
  if (changesTab) {
    await click(page, changesTab.col + 2, changesTab.row + 1);
    const headerShown = await waitForText(page, "vs HEAD", 4000);
    const patchShown = await waitForText(page, "@@", 4000);
    report("changes tab renders working-tree diff", headerShown && patchShown);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: join(screenshotDir, "workbench-changes.png"),
    });
  } else {
    report("Changes tab located", false);
  }

  // Restore the code tab as the active editor tab for the later session-restore
  // check. The tab strip is row 0, so an unbounded search matches it first.
  const codeTab = await findCell(page, "sample.ts");
  if (codeTab) {
    await click(page, codeTab.col + 2, codeTab.row + 1);
    await page.waitForTimeout(400);
  }

  // 4. "+ New workspace" + Enter adds a second session to the sidebar.
  const newAgent = await findCell(page, "+ New workspace", 0, 26);
  if (newAgent) {
    await click(page, newAgent.col + 2, newAgent.row + 1);
    const dialogOpen = await waitForText(page, "Workspace folder", 3000);
    if (dialogOpen) {
      await page.waitForTimeout(300);
      await page.screenshot({
        path: join(screenshotDir, "workbench-dialog.png"),
      });
      await send(page, "\r");
      const secondSession = await waitForText(page, "workbench-ui (2)", 4000);
      report("new agent dialog creates a second session", secondSession);
    } else {
      report("new agent dialog opens", false);
    }
  } else {
    report("sessions sidebar shows + New workspace", false);
  }

  // 5. The top-right [+] menu adds another terminal tab.
  const plus = await findPlusButton(page);
  if (plus) {
    await click(page, plus.col + 1, plus.row + 1);
    const menuOpen = await waitForText(page, "New Harness", 3000);
    if (menuOpen) {
      await page.waitForTimeout(200);
      await page.screenshot({
        path: join(screenshotDir, "workbench-plusmenu.png"),
      });
    }
    const newTerminalRow = menuOpen
      ? await findCell(page, "New Terminal")
      : null;
    if (newTerminalRow) {
      await click(page, newTerminalRow.col + 2, newTerminalRow.row + 1);
      const secondTerminal = await waitForText(page, "Terminal 2", 4000);
      report("+ menu creates Terminal 2 tab", secondTerminal);
      await page.waitForTimeout(500);
      await page.screenshot({
        path: join(screenshotDir, "workbench-sessions.png"),
      });

      // Clicking a tab's x button closes it.
      const term2 = await findCell(page, "Terminal 2");
      if (term2) {
        await click(page, term2.col + "Terminal 2".length + 2, term2.row + 1);
        report(
          "tab x button closes the tab",
          await waitForTextGone(page, "Terminal 2", 4000)
        );
      } else {
        report("tab x button closes the tab", false);
      }
    } else {
      report("+ menu opens", false);
    }
  } else {
    report("top-right + button located", false);
  }

  // 6. Tab sets are per-session: switching back to the first session restores
  // its tab strip and active editor tab (the file opened in check 3).
  const firstSession = await findCell(page, "workbench-ui", 0, 26);
  if (firstSession) {
    await click(page, firstSession.col + 2, firstSession.row + 1);
    const editorRestored = await waitForText(page, "FIXTURE_MARKER", 4000);
    report("switching sessions restores that session's tabs", editorRestored);
  } else {
    report("first session row located", false);
  }

  // 7. Quick-switch: Option+2 (ESC+"2") jumps to the second main tab (Terminal 1)
  // in the active session and moves focus there, so typed text reaches its shell.
  await send(page, "\x1b2");
  await page.waitForTimeout(500);
  await send(page, "echo QUICKSWITCH_OK\r");
  const quickSwitched = await waitForText(page, "QUICKSWITCH_OK", 4000);
  report("Option+digit quick-switches tabs and routes input", quickSwitched);

  if (failures.length > 0) {
    console.error("\n--- final terminal buffer ---");
    console.error(await bufferText(page));
  }
  await browser.close();
  console.log(join(screenshotDir, "workbench.png"));
} finally {
  server.kill();
}

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}

function report(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures.push(name);
  }
}

async function send(page: Page, data: string) {
  await page.evaluate((payload) => (window as any).__send(payload), data);
}

async function bufferText(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__bufferText());
}

// Simulate a left click via SGR mouse reports (1-based col/row), which the
// workbench's renderer parses the same way as real terminal mouse input.
async function click(page: Page, col: number, row: number) {
  await send(page, `\x1b[<0;${col};${row}M`);
  await send(page, `\x1b[<0;${col};${row}m`);
}

async function wheel(page: Page, col: number, row: number, direction: 1 | -1) {
  await send(page, `\x1b[<${direction > 0 ? 65 : 64};${col};${row}M`);
}

// Find the 0-based buffer row/col of `needle` within [colStart, colEnd).
async function findCell(
  page: Page,
  needle: string,
  colStart = 0,
  colEnd = Number.POSITIVE_INFINITY
): Promise<{ row: number; col: number } | null> {
  const lines = (await bufferText(page)).split("\n");
  for (let row = 0; row < lines.length; row++) {
    const slice = Number.isFinite(colEnd)
      ? lines[row].slice(colStart, colEnd)
      : lines[row].slice(colStart);
    const index = slice.indexOf(needle);
    if (index !== -1) {
      return { row, col: colStart + index };
    }
  }
  return null;
}

// The [+] button sits at the right edge of the tab row. The first buffer rows
// hold the "Workbench" header banner and the tab strip, so scan the top few.
async function findPlusButton(
  page: Page
): Promise<{ row: number; col: number } | null> {
  const lines = (await bufferText(page)).split("\n");
  for (const row of [0, 1, 2, 3]) {
    const col = lines[row]?.lastIndexOf("+") ?? -1;
    if (col > 100) {
      return { row, col };
    }
  }
  return null;
}

// Verify an "import" keyword in the editor pane renders in the keyword color
// (#569cd6) rather than the default text color, proving highlights applied.
// Polled, because the ListView-backed editor settles its measured viewport over
// a couple of frames after the file opens.
async function keywordIsHighlighted(page: Page): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lines = (await bufferText(page)).split("\n");
    for (let row = 0; row < lines.length; row++) {
      const col = lines[row].indexOf("import {", 25);
      if (col === -1) {
        continue;
      }
      const fg = await page.evaluate(
        ({ col, row }) => (window as any).__cellFg(col, row),
        { col, row }
      );
      if (fg?.rgb && fg.color === 0x56_9c_d6) {
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForText(
  page: Page,
  needle: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await bufferText(page)).includes(needle)) {
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForTextGone(
  page: Page,
  needle: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await bufferText(page)).includes(needle)) {
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForServer(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("screenshot server exited before it was ready");
    }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("READY ")) {
      return;
    }
  }
}
