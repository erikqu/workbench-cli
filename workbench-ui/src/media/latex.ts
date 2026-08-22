import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cacheDir = join(Bun.env.HOME ?? homedir(), ".workbench", "latex-cache");
const MAX_FORMULAS = 12;
const MAX_FORMULA_CHARS = 4000;
const MAX_TIKZ_CHARS = 30_000;
const MAX_TIKZ_ROWS = 400;
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
    const presentationDelimiter = line.replace(/^#{1,6}\s+/, "");
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
      } else if (presentationDelimiter === "[") {
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
  return [...blocks, ...extractTikzBlocks(lines)]
    .sort((left, right) => left.startRow - right.startRow)
    .slice(0, MAX_FORMULAS);
}

function extractTikzBlocks(lines: readonly string[]): DisplayMathBlock[] {
  const blocks: DisplayMathBlock[] = [];
  for (let row = 0; row < lines.length; row += 1) {
    const line = (lines[row] ?? "").trim();
    const completeDocument =
      /^\\documentclass(?:\[[^\]]*\])?\{standalone\}/.test(line);
    const barePicture = /^\\begin\{tikzpicture\}/.test(line);
    if (!(completeDocument || barePicture)) {
      continue;
    }
    const limit = Math.min(lines.length, row + MAX_TIKZ_ROWS);
    for (let pictureEnd = row + 1; pictureEnd < limit; pictureEnd += 1) {
      if (!/^\\end\{tikzpicture\}\s*$/.test((lines[pictureEnd] ?? "").trim())) {
        continue;
      }
      let endRow = pictureEnd;
      if (completeDocument) {
        for (
          let trailing = pictureEnd + 1;
          trailing < Math.min(limit, pictureEnd + 9);
          trailing += 1
        ) {
          const trailingLine = (lines[trailing] ?? "").trim();
          if (trailingLine === "") {
            continue;
          }
          if (/^\\end\{document\}\s*$/.test(trailingLine)) {
            endRow = trailing;
          }
          break;
        }
      }
      const formula = lines
        .slice(row, endRow + 1)
        .join("\n")
        .trim();
      if (formula.length <= MAX_TIKZ_CHARS && parseTikzSource(formula)) {
        blocks.push({ startRow: row, endRow, formula });
      }
      row = endRow;
      break;
    }
  }
  return blocks;
}

interface TikzSource {
  body: string;
  libraries: string[];
}

function parseTikzSource(source: string): TikzSource | null {
  if (source.length > MAX_TIKZ_CHARS) {
    return null;
  }
  const begin = source.search(/\\begin\{tikzpicture\}/);
  const endMatch = /\\end\{tikzpicture\}/g;
  let end = -1;
  for (const match of source.matchAll(endMatch)) {
    end = (match.index ?? -1) + match[0].length;
  }
  if (begin < 0 || end <= begin) {
    return null;
  }
  const body = source.slice(begin, end);
  if (unsafeTex.test(body)) {
    return null;
  }
  const libraries = new Set<string>();
  for (const match of source.matchAll(/\\usetikzlibrary\{([^}]*)\}/g)) {
    for (const name of (match[1] ?? "").split(",")) {
      const library = name.trim();
      if (!/^[a-z][a-z0-9.-]*$/i.test(library)) {
        return null;
      }
      libraries.add(library);
    }
  }
  return { body, libraries: [...libraries] };
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
        parseTikzSource(formula) !== null ||
        (formula.length <= MAX_FORMULA_CHARS && !unsafeTex.test(formula))
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
  const tikz =
    formulas.length === 1 ? parseTikzSource(formulas[0] ?? "") : null;
  if (tikz) {
    const libraries = tikz.libraries.length
      ? `\\usetikzlibrary{${tikz.libraries.join(",")}}\n`
      : "";
    return `\\documentclass[border=18pt]{standalone}
\\usepackage{amsmath,xcolor,tikz}
${libraries}\\pagecolor[HTML]{${background}}
\\color[HTML]{${foreground}}
\\begin{document}
${tikz.body}
\\end{document}
`;
  }
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
