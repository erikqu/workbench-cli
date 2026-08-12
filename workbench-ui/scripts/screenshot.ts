import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { defaultHarnessId, harnessSpec } from "../src/state/harnesses";

const root = join(import.meta.dir, "..");
const screenshotDir = join(root, "artifacts", "screenshots");
const port = Number(Bun.env.WORKBENCH_SCREENSHOT_PORT ?? "4177");
const lightTheme = Bun.env.WORKBENCH_UI_THEME === "light";
const screenshotQuery = normalizeQuery(
  Bun.env.WORKBENCH_SCREENSHOT_QUERY ??
    (lightTheme ? "terminalTheme=light" : undefined)
);
const defaultHarnessLabel = harnessSpec(defaultHarnessId()).label;
// Sort immediately after package.json so the compact Changes viewport exposes
// both a textual patch first and this binary-image regression fixture second.
const diffImagePath = join(root, "q-diff-preview.png");

mkdirSync(screenshotDir, { recursive: true });
copyFileSync(join(root, "test-harness", "sample.png"), diffImagePath);

const server = Bun.spawn(["bun", "test-harness/server.ts"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...Bun.env,
    WORKBENCH_SCREENSHOT_PORT: String(port),
    WORKBENCH_UI_CWD: root,
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
  await page.goto(`http://127.0.0.1:${port}/${screenshotQuery}`);
  await page.waitForFunction(
    () =>
      Boolean(
        (window as any).__workbenchReady && (window as any).__workbenchSawOutput
      ),
    {
      timeout: 8000,
    }
  );
  if (Bun.env.WORKBENCH_CAPTURE_SPLASH === "1") {
    await page
      .waitForFunction(
        () => {
          const text = (window as any).__bufferText();
          return (
            text.includes("Starting up...") &&
            (text.match(/▀/g)?.length ?? 0) > 100
          );
        },
        undefined,
        { timeout: 1500 }
      )
      .catch(() => undefined);
    report(
      "splash renders the park-bench image instead of binary glyphs",
      await splashUsesImageArt(page)
    );
    await page.screenshot({
      path: join(screenshotDir, "workbench-splash.png"),
    });
  }
  // Give the active session's workbench chat PTY time to spawn and draw.
  await page.waitForTimeout(2500);

  report(
    "screenshot terminal prefers JetBrains Mono",
    await page.evaluate(
      () =>
        (window as any).__terminalFontLoaded() &&
        (window as any)
          .__terminalFontFamily()
          .startsWith("'Workbench JetBrains Mono'")
    )
  );

  // 1. The default harness tab should render and remain live. Some harnesses
  // do not echo typed text immediately, so input fidelity is covered by the
  // terminal tab check below.
  const harnessVisible = await waitForText(page, defaultHarnessLabel, 8000);
  report("default harness pane renders", harnessVisible);
  report(
    "top tabs show explicit Option shortcuts",
    await waitForText(page, `⌥1 ${defaultHarnessLabel}`, 2000)
  );
  report(
    "selected session renders its name inside an outlined card",
    await sessionCardOutlined(page, "1 workbench-ui")
  );
  report(
    "selected session surface fills only its card",
    await selectedSessionCardSurface(page)
  );
  report(
    "session card hover changes its themed surface",
    await sessionCardHoverChangesSurface(page)
  );
  report(
    "Help button hover changes its surface and foreground",
    await helpButtonHoverChangesSurface(page)
  );
  report(
    "panel collapse buttons show themed hover feedback",
    await collapseButtonsShowHoverFeedback(page)
  );
  report(
    "harness restart control renders beside switch",
    await waitForText(page, "↻ switch ...", 2000)
  );
  await page.screenshot({ path: join(screenshotDir, "workbench.png") });

  await send(page, "\x1b[63;6u");
  const helpOpened = await waitForText(page, "Workbench help", 3000);
  report("Ctrl+? opens the Workbench help overlay", helpOpened);
  if (helpOpened) {
    await page.screenshot({ path: join(screenshotDir, "workbench-help.png") });
    await send(page, "\x1b[63;6u");
    report(
      "Ctrl+? closes the Workbench help overlay",
      await waitForTextGone(page, "Workbench help", 3000)
    );
  }

  // 1b. Both vertical pane borders are draggable. Move each six columns right,
  // assert its new position, then restore the default geometry so subsequent
  // coordinate-bounded checks keep their stable fixture ranges.
  await drag(page, 25, 10, 31, 10);
  await page.waitForTimeout(250);
  report("sessions sidebar border is draggable", await hasBorderAt(page, 31));
  await drag(page, 31, 10, 25, 10);
  await page.waitForTimeout(250);
  await drag(page, 25, 10, 10, 10);
  await page.waitForTimeout(250);
  report("sessions sidebar enforces its minimum", await hasBorderAt(page, 17));
  await drag(page, 17, 10, 25, 10);
  await page.waitForTimeout(250);

  await drag(page, 55, 10, 61, 10);
  await page.waitForTimeout(250);
  report("file explorer border is draggable", await hasBorderAt(page, 61));
  await drag(page, 61, 10, 55, 10);
  await page.waitForTimeout(250);
  await drag(page, 55, 10, 35, 10);
  await page.waitForTimeout(250);
  report("file explorer enforces its minimum", await hasBorderAt(page, 45));
  await drag(page, 45, 10, 55, 10);
  await page.waitForTimeout(250);
  report(
    "pane resizing keeps the screen anchored",
    await screenIsAnchored(page)
  );

  // 2. Clicking the Terminal 1 tab focuses its shell; typing should reach it.
  const terminalTab = await findCell(page, "Terminal 1");
  if (terminalTab) {
    await click(page, terminalTab.col + 2, terminalTab.row + 1);
    await page.waitForTimeout(500);
    await send(page, "echo TERMINAL_OK\r");
    const terminalEcho = await waitForText(page, "TERMINAL_OK", 4000);
    report("terminal tab receives keystrokes", terminalEcho);
    const terminalMarker = await findCell(page, "TERMINAL_OK", 26);
    if (terminalMarker) {
      const before = await clipboardState(page);
      await drag(
        page,
        terminalMarker.col,
        terminalMarker.row,
        terminalMarker.col + "TERMINAL_OK".length,
        terminalMarker.row
      );
      await send(page, "\x03");
      await waitForClipboardWrite(page, before.writes + 1, 3000);
      report(
        "regular terminal selection copies with Ctrl+C",
        (await clipboardState(page)).text.includes("TERMINAL_OK")
      );
    } else {
      report("regular terminal selection copies with Ctrl+C", false);
    }
  } else {
    report("Terminal 1 tab located", false);
  }

  // 3. Back on the harness layout, open the existing source tab and exercise
  // selection through the full outer-terminal clipboard path.
  const chatTab = await findCell(page, defaultHarnessLabel);
  if (chatTab) {
    await send(page, "\x1b1");
    await page.waitForTimeout(500);
  }
  await send(page, "\x1b3");
  const editorOpened = await waitForText(page, "FIXTURE_MARKER", 4000);
  report("source file opens in editor", editorOpened);
  if (editorOpened) {
    report(
      "editor pane syntax parses keywords",
      await keywordIsHighlighted(page)
    );
    const marker = await findCell(page, "FIXTURE_MARKER", 56);
    if (marker) {
      const before = await clipboardState(page);
      await drag(
        page,
        marker.col,
        marker.row,
        marker.col + "FIXTURE_MARKER".length,
        marker.row
      );
      await send(page, "\x03");
      await waitForClipboardWrite(page, before.writes + 1, 3000);
      report(
        "file viewer selection copies with Ctrl+C",
        (await clipboardState(page)).text === "FIXTURE_MARKER"
      );
    } else {
      report("file viewer selection copies with Ctrl+C", false);
    }
    for (let i = 0; i < 16; i++) {
      await wheel(page, 90, 20, 1);
      await page.waitForTimeout(40);
    }
    const editorScrolled = await waitForText(
      page,
      "SCROLL_TARGET_SENTINEL",
      3000
    );
    report("editor pane scrolls with wheel", editorScrolled);
    report(
      "scrollable file viewer shows a scrollbar",
      await hasScrollbar(page, 56)
    );
    await page.screenshot({
      path: join(screenshotDir, "workbench-editor.png"),
    });
  } else {
    report("file viewer selection copies with Ctrl+C", false);
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
    if (lightTheme) {
      report(
        "light theme markdown preview uses dark text",
        await textHasDarkRgbForeground(page, "The Bun", 26)
      );
    }
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
    report(
      "image preview preserves RGB colors",
      await regionHasRgbVariation(page, 56)
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotDir, "workbench-image.png") });
  } else {
    report("sample.png tab located", false);
  }

  // 3c-i. Animated GIFs use the frame player rather than freezing on the first
  // image. The shared playback controls prove ffmpeg probing/extraction started.
  const gifTab = await findCell(page, "sample.gif");
  if (gifTab) {
    await click(page, gifTab.col + 2, gifTab.row + 1);
    const controlsShown = await waitForText(page, "Space play/pause", 12_000);
    const frameDrawn = await waitForText(page, "\u2580", 12_000);
    const notBinary = !(await bufferText(page)).includes("(binary file)");
    report(
      "animated GIF tab renders in the frame player",
      controlsShown && frameDrawn && notBinary
    );
    await page.screenshot({ path: join(screenshotDir, "workbench-gif.png") });
    await send(page, " ");
    await page.waitForTimeout(300);
  } else {
    report("sample.gif tab located", false);
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
    const tableHeading = await findCell(page, "Wide table bounds", 56);
    const lines = buffer.split("\n");
    const tableRowsBounded = tableHeading
      ? lines
          .slice(tableHeading.row, tableHeading.row + 5)
          .every((line) => line[179] === "│")
      : false;
    report(
      "wide markdown tables stay inside the preview border",
      tableRowsBounded
    );
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
    await click(page, changesTab.col + 2, changesTab.row + 2);
    const headerShown = await waitForText(page, "vs HEAD", 4000);
    const patchShown = await waitForText(page, "@@", 4000);
    report("changes tab renders working-tree diff", headerShown && patchShown);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: join(screenshotDir, "workbench-changes.png"),
    });
    const changesSidebar = await findCell(page, "Changes", 26, 56);
    let diffImage = changesSidebar
      ? await findCellBelow(page, "preview.png", 26, 56, changesSidebar.row + 1)
      : null;
    for (let step = 0; changesSidebar && !diffImage && step < 30; step++) {
      await send(page, "\x1b[B");
      await page.waitForTimeout(25);
      diffImage = await findCellBelow(
        page,
        "preview.png",
        26,
        56,
        changesSidebar.row + 1
      );
    }
    if (diffImage) {
      await click(page, diffImage.col + 2, diffImage.row + 1);
      const imageDrawn = await waitForText(page, "▀", 5000);
      const buffer = await bufferText(page);
      report(
        "image diff renders terminal art instead of a binary label",
        imageDrawn && !buffer.includes("Binary file")
      );
    } else {
      report("image diff fixture appears in Changes", false);
    }
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
      const secondSession = await waitForText(page, "2 workbench", 4000);
      report("new agent dialog creates a second session", secondSession);
      report(
        "new session uses the same outlined card structure",
        await sessionCardOutlined(page, "2 workbench")
      );
      report(
        "inactive session uses the sessions panel background",
        await inactiveSessionMatchesPanel(page)
      );
      report(
        "session cards have no vertical gap",
        await sessionCardsAreContiguous(page)
      );
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

  // The Explorer control collapses the complete workspace side pane to a
  // narrow rail, whose inverse caret expands it again.
  const collapseExplorer = await findExplorerCollapse(page);
  if (collapseExplorer) {
    await click(page, collapseExplorer.col + 2, collapseExplorer.row + 1);
    await page.waitForTimeout(300);
    const expandExplorer = await findCell(page, ">", 26, 30);
    report(
      "Explorer header collapses the complete file panel",
      (await findCell(page, "Explorer", 26, 56)) === null &&
        expandExplorer !== null
    );
    if (expandExplorer) {
      await click(page, expandExplorer.col + 1, expandExplorer.row + 1);
      report(
        "collapsed file panel can be expanded again",
        await waitForText(page, "Explorer", 3000)
      );
    }
  } else {
    report("Explorer collapse control located", false);
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
  rmSync(diffImagePath, { force: true });
}

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}

function normalizeQuery(query: string | undefined) {
  if (!query) {
    return "";
  }
  return query.startsWith("?") ? query : `?${query}`;
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

async function splashUsesImageArt(page: Page): Promise<boolean> {
  const text = await bufferText(page);
  const halfBlocks = text.match(/▀/g)?.length ?? 0;
  return (
    text.includes("Starting up...") &&
    halfBlocks > 100 &&
    !/[01]{20}/.test(text)
  );
}

async function clipboardState(
  page: Page
): Promise<{ text: string; writes: number }> {
  return page.evaluate(() => (window as any).__clipboardState());
}

async function waitForClipboardWrite(
  page: Page,
  expected: number,
  timeoutMs: number
) {
  await page.waitForFunction(
    (writes) => (window as any).__clipboardState().writes >= writes,
    expected,
    { timeout: timeoutMs }
  );
}

// Simulate a left click via SGR mouse reports (1-based col/row), which the
// workbench's renderer parses the same way as real terminal mouse input.
async function click(page: Page, col: number, row: number) {
  await send(page, `\x1b[<0;${col};${row}M`);
  await send(page, `\x1b[<0;${col};${row}m`);
}

async function drag(
  page: Page,
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number
) {
  await send(page, `\x1b[<0;${fromCol + 1};${fromRow + 1}M`);
  await send(page, `\x1b[<32;${toCol + 1};${toRow + 1}M`);
  await send(page, `\x1b[<0;${toCol + 1};${toRow + 1}m`);
}

async function hasBorderAt(page: Page, col: number): Promise<boolean> {
  const lines = (await bufferText(page)).split("\n");
  return lines.slice(4, -2).some((line) => line[col] === "│");
}

async function sessionCardOutlined(
  page: Page,
  needle: string
): Promise<boolean> {
  const session = await findCell(page, needle, 0, 26);
  if (!session) {
    return false;
  }
  const lines = (await bufferText(page)).split("\n");
  const top = lines[session.row - 1]?.slice(1, 25) ?? "";
  const middle = lines[session.row]?.slice(1, 25) ?? "";
  const bottom = lines[session.row + 1]?.slice(1, 25) ?? "";
  return (
    top.includes("╭") &&
    top.includes("╮") &&
    middle.includes("│") &&
    bottom.includes("╰") &&
    bottom.includes("╯")
  );
}

async function selectedSessionCardSurface(page: Page): Promise<boolean> {
  const session = await findCell(page, "workbench-ui", 0, 26);
  if (!session) {
    return false;
  }
  return page.evaluate(({ col, row }) => {
    const top = (window as any).__cellState(col, row - 1);
    const middle = (window as any).__cellState(col, row);
    const bottom = (window as any).__cellState(col, row + 1);
    const gap = (window as any).__cellState(col, row + 2);
    return (
      top?.bg !== 0 &&
      top.bg === middle?.bg &&
      top.bg === bottom?.bg &&
      gap?.bg !== top.bg
    );
  }, session);
}

async function inactiveSessionMatchesPanel(page: Page): Promise<boolean> {
  const session = await findCell(page, "1 workbench-ui", 0, 26);
  if (!session) {
    return false;
  }
  return page.evaluate(({ col, row }) => {
    const card = (window as any).__cellState(col, row);
    const panel = (window as any).__cellState(1, row);
    return card?.bg === panel?.bg;
  }, session);
}

async function sessionCardsAreContiguous(page: Page): Promise<boolean> {
  const first = await findCell(page, "1 workbench-ui", 0, 26);
  const second = await findCell(page, "2 workbench", 0, 26);
  return Boolean(first && second && second.row - first.row === 3);
}

async function sessionCardHoverChangesSurface(page: Page): Promise<boolean> {
  const session = await findCell(page, "workbench-ui", 0, 26);
  if (!session) {
    return false;
  }
  const before = await page.evaluate(
    ({ col, row }) => (window as any).__cellState(col, row)?.bg,
    session
  );
  await send(page, `\x1b[<35;${session.col + 1};${session.row + 1}M`);
  await page.waitForTimeout(100);
  const after = await page.evaluate(
    ({ col, row }) => (window as any).__cellState(col, row)?.bg,
    session
  );
  await send(page, "\x1b[<35;100;20M");
  return before !== after;
}

async function helpButtonHoverChangesSurface(page: Page): Promise<boolean> {
  const help = await findCell(page, "? Help", 0, 26);
  if (!help) {
    return false;
  }
  const before = await page.evaluate(
    ({ col, row }) => ({
      bg: (window as any).__cellState(col, row)?.bg,
      fg: (window as any).__cellFg(col, row)?.color,
    }),
    help
  );
  await send(page, `\x1b[<35;${help.col + 1};${help.row + 1}M`);
  await page.waitForTimeout(100);
  const after = await page.evaluate(
    ({ col, row }) => ({
      bg: (window as any).__cellState(col, row)?.bg,
      fg: (window as any).__cellFg(col, row)?.color,
    }),
    help
  );
  await send(page, "\x1b[<35;100;20M");
  return before.bg !== after.bg && before.fg !== after.fg;
}

async function findExplorerCollapse(
  page: Page
): Promise<{ row: number; col: number } | null> {
  const explorer = await findCell(page, "Explorer", 26, 56);
  if (!explorer) {
    return null;
  }
  const line = (await bufferText(page)).split("\n")[explorer.row] ?? "";
  const col = line.lastIndexOf("<", 55);
  return col > explorer.col ? { row: explorer.row, col } : null;
}

async function collapseButtonsShowHoverFeedback(page: Page): Promise<boolean> {
  const explorer = await findExplorerCollapse(page);
  const sessions = await findSessionsCollapse(page);
  if (!(explorer && sessions)) {
    return false;
  }
  return (
    (await hoverChangesSurface(page, explorer)) &&
    (await hoverChangesSurface(page, sessions))
  );
}

async function findSessionsCollapse(
  page: Page
): Promise<{ row: number; col: number } | null> {
  const sessions = await findCell(page, "Sessions", 0, 26);
  if (!sessions) {
    return null;
  }
  const line = (await bufferText(page)).split("\n")[sessions.row] ?? "";
  const col = line.lastIndexOf("<", 25);
  return col > sessions.col ? { row: sessions.row, col } : null;
}

async function hoverChangesSurface(
  page: Page,
  target: { row: number; col: number }
): Promise<boolean> {
  const before = await page.evaluate(
    ({ col, row }) => ({
      bg: (window as any).__cellState(col, row)?.bg,
      fg: (window as any).__cellFg(col, row)?.color,
    }),
    target
  );
  await send(page, `\x1b[<35;${target.col + 1};${target.row + 1}M`);
  await page.waitForTimeout(100);
  const after = await page.evaluate(
    ({ col, row }) => ({
      bg: (window as any).__cellState(col, row)?.bg,
      fg: (window as any).__cellFg(col, row)?.color,
    }),
    target
  );
  await send(page, "\x1b[<35;100;20M");
  return before.bg !== after.bg && before.fg !== after.fg;
}

async function screenIsAnchored(page: Page): Promise<boolean> {
  return (
    (await bufferText(page)).split("\n")[0]?.includes("Workbench") ?? false
  );
}

async function hasScrollbar(
  page: Page,
  contentStart: number
): Promise<boolean> {
  const thumb = new Set("▁▂▃▄▅▆▇█");
  const lines = (await bufferText(page)).split("\n");
  return lines.some((line) =>
    [...line.slice(contentStart)].some((char) => thumb.has(char))
  );
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

async function findCellBelow(
  page: Page,
  needle: string,
  colStart: number,
  colEnd: number,
  rowStart: number
): Promise<{ row: number; col: number } | null> {
  const lines = (await bufferText(page)).split("\n");
  for (let row = rowStart; row < lines.length; row++) {
    const index = lines[row].slice(colStart, colEnd).indexOf(needle);
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

// Verify an "import" keyword in the editor pane renders in the active theme's
// keyword color rather than the default text color, proving highlights applied.
// Polled, because the ListView-backed editor settles its measured viewport over
// a couple of frames after the file opens.
async function keywordIsHighlighted(page: Page): Promise<boolean> {
  const expected = lightTheme ? 0x00_00_ff : 0x56_9c_d6;
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
      if (fg?.rgb && fg.color === expected) {
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function regionHasRgbVariation(
  page: Page,
  colStart: number
): Promise<boolean> {
  return page.evaluate((start) => {
    const colors = new Set<number>();
    for (let row = 0; row < 40; row++) {
      for (let col = start; col < 180; col++) {
        const fg = (window as any).__cellFg(col, row);
        if (fg?.rgb) {
          colors.add(fg.color);
        }
        if (colors.size >= 8) {
          return true;
        }
      }
    }
    return false;
  }, colStart);
}

async function textHasDarkRgbForeground(
  page: Page,
  needle: string,
  colStart: number
): Promise<boolean> {
  const cell = await findCell(page, needle, colStart);
  if (!cell) {
    return false;
  }
  const fg = await page.evaluate(
    ({ col, row }) => (window as any).__cellFg(col, row),
    cell
  );
  if (!fg?.rgb) {
    return false;
  }
  const red = (fg.color >> 16) & 0xff;
  const green = (fg.color >> 8) & 0xff;
  const blue = fg.color & 0xff;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 128;
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
