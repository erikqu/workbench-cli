import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cacheDir = join(Bun.env.HOME ?? homedir(), ".workbench", "latex-cache");
const MAX_FORMULAS = 12;
const MAX_FORMULA_CHARS = 4000;
const COMPILE_TIMEOUT_MS = 12_000;

const unsafeTex =
  /\\(?:catcode|csname|def|documentclass|end\s*\{document|gdef|href|immediate|include|includegraphics|input|loop|newcommand|openin|openout|read|renewcommand|repeat|special|usepackage|write|xdef)\b|\^\^/i;

const mathSignal =
  /(?:\\(?:begin|frac|left|lambda|mathrm|nabla|operatorname|pi|qquad|right|softmax|text|theta)|[_^=]|\b(?:GRU|softmax)\b)/;

export function latexAvailable(): boolean {
  return Bun.which("tectonic") !== null && Bun.which("pdftoppm") !== null;
}

// Extract display-math blocks from the already-rendered terminal transcript.
// Codex currently leaves \[...\] as standalone [ / ] rows, so accept both
// forms but require math syntax inside to avoid treating ordinary prose lists
// as equations.
export interface DisplayMathBlock {
  endRow: number;
  formula: string;
  startRow: number;
}

export function extractDisplayMath(text: string): string[] {
  return extractDisplayMathBlocks(text.replaceAll("\r", "").split("\n")).map(
    (block) => block.formula
  );
}

export function extractDisplayMathBlocks(
  lines: readonly string[]
): DisplayMathBlock[] {
  const blocks: DisplayMathBlock[] = [];
  let delimiter: "]" | "\\]" | "$$" | undefined;
  let pending: string[] = [];
  let startRow = 0;

  const finish = (endRow: number) => {
    const formula = pending.join(" ").trim();
    pending = [];
    delimiter = undefined;
    if (
      !formula ||
      formula.length > MAX_FORMULA_CHARS ||
      unsafeTex.test(formula) ||
      !mathSignal.test(formula) ||
      blocks.some((block) => block.formula === formula)
    ) {
      return;
    }
    blocks.push({ endRow, formula, startRow });
  };

  for (let row = 0; row < lines.length; row += 1) {
    const original = lines[row] ?? "";
    const line = original.trim();
    if (!delimiter) {
      const inline = /^\$\$(.+)\$\$$/.exec(line);
      if (inline) {
        startRow = row;
        pending = [inline[1] ?? ""];
        finish(row);
      } else if (line === "$$") {
        startRow = row;
        delimiter = "$$";
      } else if (line === "\\[") {
        startRow = row;
        delimiter = "\\]";
      } else if (line === "[") {
        startRow = row;
        delimiter = "]";
      }
      continue;
    }
    if (line === delimiter) {
      finish(row);
      if (blocks.length >= MAX_FORMULAS) {
        break;
      }
      continue;
    }
    pending.push(line);
    if (pending.join(" ").length > MAX_FORMULA_CHARS) {
      pending = [];
      delimiter = undefined;
    }
  }
  return blocks;
}

export async function renderLatexToPng(
  formulas: readonly string[],
  mode: "dark" | "light"
): Promise<string | null> {
  const tectonic = Bun.which("tectonic");
  const pdftoppm = Bun.which("pdftoppm");
  if (!(tectonic && pdftoppm && formulas.length > 0)) {
    return null;
  }
  const safe = formulas
    .slice(0, MAX_FORMULAS)
    .filter(
      (formula) =>
        formula.length <= MAX_FORMULA_CHARS && !unsafeTex.test(formula)
    );
  if (safe.length === 0) {
    return null;
  }
  const key = createHash("sha256")
    .update(`${mode}\0${safe.join("\0")}`)
    .digest("hex");
  const pngPath = join(cacheDir, `${key}.png`);
  if (existsSync(pngPath)) {
    return pngPath;
  }
  mkdirSync(cacheDir, { recursive: true });
  const texPath = join(cacheDir, `${key}.tex`);
  const pdfPath = join(cacheDir, `${key}.pdf`);
  const outputPrefix = join(cacheDir, key);
  writeFileSync(texPath, latexDocument(safe, mode));

  const compiled = Bun.spawn(
    [tectonic, "--untrusted", "--outdir", cacheDir, texPath],
    { cwd: cacheDir, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
  );
  if (
    !((await exitsBefore(compiled, COMPILE_TIMEOUT_MS)) && existsSync(pdfPath))
  ) {
    return null;
  }
  const raster = Bun.spawn(
    [pdftoppm, "-png", "-r", "180", "-singlefile", pdfPath, outputPrefix],
    { cwd: cacheDir, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
  );
  return (await raster.exited) === 0 && existsSync(pngPath) ? pngPath : null;
}

function latexDocument(formulas: readonly string[], mode: "dark" | "light") {
  const background = mode === "dark" ? "19191B" : "FFFFFF";
  const foreground = mode === "dark" ? "E4E2DC" : "171717";
  const body = formulas
    .map((formula) => `\\[\n${formula}\n\\]`)
    .join("\n\\vspace{0.8em}\n");
  return `\\documentclass[border=18pt]{standalone}
\\usepackage{amsmath,amssymb,xcolor}
\\pagecolor[HTML]{${background}}
\\color[HTML]{${foreground}}
\\begin{document}
\\begin{minipage}{18cm}
${body}
\\end{minipage}
\\end{document}
`;
}

async function exitsBefore(
  process: ReturnType<typeof Bun.spawn>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      try {
        process.kill();
      } catch {
        // The compiler may have exited between the timeout and the signal.
      }
      resolve(false);
    }, timeoutMs);
  });
  const exited = process.exited.then((code) => code === 0);
  const result = await Promise.race([exited, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}
