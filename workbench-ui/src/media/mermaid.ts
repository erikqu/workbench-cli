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
    writeFileSync(
      path,
      JSON.stringify({
        headless: "new",
        args: ["--no-sandbox", "--disable-gpu"],
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
