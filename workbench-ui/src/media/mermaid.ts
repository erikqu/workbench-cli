import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Render Mermaid code blocks to PNG via the mermaid CLI (`mmdc`) and cache the
// result on disk, keyed by content. The PNG is then displayed through the same
// image pipeline as any other picture (Kitty/Ghostty graphics, tmux passthrough,
// or half-block ASCII fallback), so diagrams show as real images wherever the
// terminal supports it and degrade gracefully where it doesn't.

const SCALE = "2";

const RENDER_STYLES = {
  dark: { theme: "dark", background: "#19191b" },
  light: { theme: "default", background: "#ffffff" },
} as const;

const cacheDir = join(Bun.env.HOME ?? homedir(), ".workbench", "mermaid-cache");

const BROWSER_COMMANDS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "brave-browser-stable",
  "brave-browser",
  "microsoft-edge-stable",
  "microsoft-edge",
  "chrome",
] as const;

const BROWSER_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
} as const;

export function findBrowserExecutable(
  explicitPath = Bun.env.PUPPETEER_EXECUTABLE_PATH,
  which: (command: string) => string | null = Bun.which,
  fileExists: (path: string) => boolean = existsSync,
  platform = process.platform
): string | undefined {
  if (explicitPath && fileExists(explicitPath)) {
    return explicitPath;
  }
  for (const command of BROWSER_COMMANDS) {
    const path = which(command);
    if (path) {
      return path;
    }
  }
  const knownPaths =
    platform === "darwin"
      ? BROWSER_PATHS.darwin
      : platform === "linux"
        ? BROWSER_PATHS.linux
        : [];
  return knownPaths.find(fileExists);
}

export interface MermaidBlock {
  endRow: number;
  source: string;
  startRow: number;
}

const MAX_BLOCK_ROWS = 200;
const MAX_SOURCE_LENGTH = 20_000;

// Mirrors Mermaid's built-in diagram detectors. Keeping this deliberately
// anchored prevents prose that merely mentions Mermaid from becoming an
// expensive Chromium render attempt.
const diagramDeclaration =
  /^\s*(?:C4(?:Context|Container|Component|Dynamic|Deployment)|graph\b|flowchart\b|erDiagram\b|gitGraph\b|gantt\b|info\b|pie\b|quadrantChart\b|xychart(?:-beta)?\b|requirement(?:Diagram)?\b|sequenceDiagram\b|classDiagram(?:-v2)?\b|stateDiagram(?:-v2)?\b|journey\b|timeline\b|mindmap\b|kanban\b|sankey(?:-beta)?\b|packet(?:-beta)?\b|radar-beta\b|block(?:-beta)?\b|treeView-beta\b|architecture\b|ishikawa(?:-beta)?\b|venn-beta\b|treemap\b)/i;

const mermaidFence = /^\s*(`{3,}|~{3,})\s*mermaid(?:\s+[^`]*)?\s*$/i;
const renderedBullet = /^\s*[•●◦·]\s+/;
const renderedGutter = /^\s*(?:\d+\s+)?[│┃]\s?/;
const mermaidStatement =
  /^\s*(?:%%|accDescr|accTitle|activate|actor|alt|and|autonumber|axisFormat|branch|break|checkout|classDef|click|commit|critical|dateFormat|deactivate|direction|else|end\b|exclude|gitGraph|include|linkStyle|loop|merge|note|opt|par|participant|rect|section|state|style|subgraph|title|todayMarker|x-axis|y-axis)|(?:.*(?:-->|---|==>|->>|-->>|-.->|<--|<->).*)$/i;

function isDiagramDeclaration(line: string): boolean {
  return diagramDeclaration.test(normalizeDeclaration(line));
}

function normalizeDeclaration(line: string): string {
  return stripRenderedGutter(line).replace(renderedBullet, "");
}

function stripRenderedGutter(line: string): string {
  return line.replace(renderedGutter, "");
}

function normalizedPresentationLine(line: string): string {
  return normalizeDeclaration(line).trim();
}

function sourceHasDeclaration(source: string): boolean {
  return source
    .split("\n")
    .slice(0, 30)
    .some((line) => isDiagramDeclaration(line));
}

function isRenderedBoundary(line: string, bodyIndent: number): boolean {
  const withoutGutter = stripRenderedGutter(line);
  if (renderedBullet.test(withoutGutter)) {
    return true;
  }
  if (bodyIndent < 2) {
    return false;
  }
  if (
    isDiagramDeclaration(withoutGutter) ||
    mermaidStatement.test(withoutGutter)
  ) {
    return false;
  }
  // Harness Markdown gives the contents of a rendered code block a stable
  // indentation level. Prose and tables that follow it may still be indented,
  // but less deeply. Treat that dedent as the end of the diagram; accepting
  // every whitespace-prefixed line here made the renderer ingest the rest of
  // a response and silently fail on otherwise valid Mermaid.
  return leadingSpaces(withoutGutter) < bodyIndent;
}

function leadingSpaces(line: string): number {
  return stripRenderedGutter(line).match(/^ */)?.[0].length ?? 0;
}

function nextNonEmptyRow(
  lines: readonly string[],
  start: number
): number | null {
  for (let row = start; row < lines.length; row += 1) {
    if ((lines[row] ?? "").trim() !== "") {
      return row;
    }
  }
  return null;
}

function continuesRenderedDiagram(
  lines: readonly string[],
  row: number,
  bodyIndent: number
): boolean {
  const line = lines[row] ?? "";
  if (line.trim() !== "") {
    return !isRenderedBoundary(line, bodyIndent);
  }
  const nextRow = nextNonEmptyRow(lines, row + 1);
  if (nextRow === null) {
    return false;
  }
  // Harness renderers indent every source line under the leading language
  // bullet. That indentation is a reliable way to distinguish an intentional
  // blank inside the diagram from the prose paragraph that follows it.
  const next = lines[nextRow] ?? "";
  return (
    !isRenderedBoundary(next, bodyIndent) &&
    (leadingSpaces(next) >= 2 || mermaidStatement.test(next))
  );
}

/**
 * Find complete Mermaid definitions in the visible terminal grid. This
 * accepts canonical Markdown fences as well as the two forms commonly left by
 * harness Markdown renderers: a `mermaid` language row followed by source, or
 * fence-stripped source beginning directly with its diagram declaration.
 */
export function extractMermaidBlocks(lines: readonly string[]): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];

  for (let row = 0; row < lines.length; row += 1) {
    const fence = normalizedPresentationLine(lines[row] ?? "").match(
      mermaidFence
    );
    if (fence) {
      const marker = fence[1] ?? "```";
      const closeFence = new RegExp(
        `^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`
      );
      for (
        let end = row + 1;
        end < lines.length && end - row <= MAX_BLOCK_ROWS;
        end += 1
      ) {
        if (!closeFence.test(normalizedPresentationLine(lines[end] ?? ""))) {
          continue;
        }
        const source = lines
          .slice(row + 1, end)
          .map(stripRenderedGutter)
          .join("\n")
          .trim();
        if (
          source.length <= MAX_SOURCE_LENGTH &&
          sourceHasDeclaration(source)
        ) {
          blocks.push({ startRow: row, endRow: end, source });
        }
        row = end;
        break;
      }
      continue;
    }

    const languageRow =
      normalizedPresentationLine(lines[row] ?? "").toLowerCase() === "mermaid";
    const sourceStart = languageRow ? row + 1 : row;
    if (
      !(
        isDiagramDeclaration(lines[sourceStart] ?? "") ||
        (languageRow &&
          sourceHasDeclaration(lines.slice(sourceStart).join("\n")))
      )
    ) {
      continue;
    }

    const firstBodyRow = nextNonEmptyRow(lines, sourceStart + 1);
    const bodyIndent =
      firstBodyRow === null ? 0 : leadingSpaces(lines[firstBodyRow] ?? "");
    let end = sourceStart;
    while (
      end + 1 < lines.length &&
      end - sourceStart + 1 < MAX_BLOCK_ROWS &&
      continuesRenderedDiagram(lines, end + 1, bodyIndent)
    ) {
      end += 1;
    }
    const sourceLines = lines
      .slice(sourceStart, end + 1)
      .map(stripRenderedGutter);
    sourceLines[0] = normalizeDeclaration(sourceLines[0] ?? "");
    const source = sourceLines.join("\n").trim();
    if (source.length <= MAX_SOURCE_LENGTH) {
      blocks.push({
        startRow: languageRow ? row : sourceStart,
        endRow: end,
        source,
      });
    }
    row = end;
  }

  return blocks;
}

let mmdcPath: string | null | undefined;
function findMmdc(): string | null {
  if (mmdcPath === undefined) {
    mmdcPath = Bun.which("mmdc");
  }
  return mmdcPath;
}

export function mermaidAvailable(): boolean {
  return findMmdc() !== null;
}

let puppeteerConfigPath: string | undefined;
function ensurePuppeteerConfig(): string {
  if (!puppeteerConfigPath) {
    const path = join(cacheDir, "puppeteer.json");
    // --no-sandbox keeps Chromium happy under containers / root; the headless
    // "new" mode avoids the deprecated-headless warning on stderr.
    const executablePath = findBrowserExecutable();
    writeFileSync(
      path,
      JSON.stringify({
        headless: "new",
        args: ["--no-sandbox", "--disable-gpu"],
        ...(executablePath ? { executablePath } : {}),
      })
    );
    puppeteerConfigPath = path;
  }
  return puppeteerConfigPath;
}

const inFlight = new Map<string, Promise<string | null>>();
// Serialize renders so a markdown file with many diagrams doesn't spawn a
// browser per block at once.
let chain: Promise<unknown> = Promise.resolve();

// Returns a path to a cached PNG for the given Mermaid source, or null if the
// diagram could not be rendered (mmdc missing or the source failed to parse).
export function renderMermaidToPng(
  source: string,
  mode: keyof typeof RENDER_STYLES = "dark"
): Promise<string | null> {
  const trimmed = source.trim();
  if (!trimmed) {
    return Promise.resolve(null);
  }

  const style = RENDER_STYLES[mode];

  const key = createHash("sha256")
    .update(`${style.theme}|${style.background}|${SCALE}|${trimmed}`)
    .digest("hex");
  const outPath = join(cacheDir, `${key}.png`);
  if (existsSync(outPath)) {
    return Promise.resolve(outPath);
  }

  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const pending = (async () => {
    const mmdc = findMmdc();
    if (!mmdc) {
      return null;
    }
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch {
      return null;
    }
    // Queue behind any in-progress render.
    const run = chain.then(() => runMmdc(mmdc, key, trimmed, outPath, style));
    chain = run.catch(() => {});
    return run;
  })();

  inFlight.set(key, pending);
  void pending.finally(() => inFlight.delete(key));
  return pending;
}

async function runMmdc(
  mmdc: string,
  key: string,
  source: string,
  outPath: string,
  style: (typeof RENDER_STYLES)[keyof typeof RENDER_STYLES]
): Promise<string | null> {
  const inPath = join(cacheDir, `${key}.mmd`);
  try {
    writeFileSync(inPath, source);
  } catch {
    return null;
  }

  try {
    const proc = Bun.spawn(
      [
        mmdc,
        "-i",
        inPath,
        "-o",
        outPath,
        "-t",
        style.theme,
        "-b",
        style.background,
        "-s",
        SCALE,
        "-p",
        ensurePuppeteerConfig(),
      ],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore", env: { ...Bun.env } }
    );
    const code = await proc.exited;
    if (code === 0 && existsSync(outPath)) {
      return outPath;
    }
    return null;
  } catch {
    return null;
  }
}
