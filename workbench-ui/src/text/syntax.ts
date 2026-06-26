import { extname } from "node:path";

export function filetypeForPath(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".rs":
      return "rust";
    case ".json":
      return "json";
    case ".toml":
      return "toml";
    case ".md":
      return "markdown";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".sh":
    case ".bash":
      return "bash";
    case ".html":
      return "html";
    case ".css":
      return "css";
    case ".lua":
      return "lua";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return;
  }
}

// Keywords across the supported languages. Deliberately excludes words that are
// also common method/identifier names in this codebase (map, get, set, of, is,
// and, or, not, range) to avoid coloring ordinary calls like `.map()`/`.get()`.
const keywordPattern =
  /^(abstract|as|async|await|break|case|catch|class|const|constructor|continue|crate|debugger|declare|def|default|defer|delete|do|dyn|elif|else|enum|except|export|extends|extern|fallthrough|false|finally|fn|for|from|func|function|global|goto|if|impl|implements|import|in|infer|instanceof|interface|keyof|lambda|let|loop|match|mod|move|mut|namespace|new|nil|nonlocal|null|override|package|pass|private|protected|pub|public|raise|readonly|ref|return|satisfies|self|static|struct|super|switch|this|throw|trait|true|try|type|typeof|undefined|unsafe|use|var|void|where|while|with|yield)$/;

const tokenPattern =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|#.*|\b[A-Za-z_][\w-]*\b|\b\d+(?:\.\d+)?\b|[=:[\]{}(),.;+\-*/<>!&|]+|\s+|.)/g;

export function highlightFallback(_path: string, content: string) {
  return content;
}

export interface HighlightToken {
  group?: string;
  text: string;
}

export function highlightLineTokens(
  path: string,
  content: string
): HighlightToken[][] {
  const filetype = filetypeForPath(path);
  return content.split("\n").map((line) => {
    let tomlKey = filetype === "toml";
    const tokens: HighlightToken[] = [];
    for (const match of line.matchAll(tokenPattern)) {
      const text = match[0];
      const group = tokenGroup(text, tomlKey);
      tokens.push(group ? { text, group } : { text });
      if (tomlKey && text === "=") {
        tomlKey = false;
      }
    }
    return tokens.length > 0 ? tokens : [{ text: " " }];
  });
}

export interface HighlightRange {
  end: number;
  group: string;
  start: number;
}

// Regex-based highlight ranges for the editable buffer, used when tree-sitter
// has no grammar for the filetype or fails (e.g. worker init errors).
export function fallbackHighlightRanges(
  path: string,
  content: string
): HighlightRange[] {
  const filetype = filetypeForPath(path);
  const ranges: HighlightRange[] = [];
  let offset = 0;

  for (const line of content.split("\n")) {
    let tomlKey = filetype === "toml";
    for (const match of line.matchAll(tokenPattern)) {
      const token = match[0];
      const group = tokenGroup(token, tomlKey);
      if (group) {
        const start = offset + (match.index ?? 0);
        ranges.push({ start, end: start + token.length, group });
      }
      if (tomlKey && token === "=") {
        tomlKey = false;
      }
    }
    offset += line.length + 1;
  }

  return ranges;
}

function tokenGroup(token: string, tomlKey: boolean): string | undefined {
  if (/^\s+$/.test(token)) {
    return;
  }
  if (token.startsWith("//") || token.startsWith("#")) {
    return "comment";
  }
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return "string";
  }
  if (/^\d/.test(token)) {
    return "number";
  }
  if (token === "true" || token === "false" || token === "null") {
    return "boolean";
  }
  if (keywordPattern.test(token)) {
    return "keyword";
  }
  if (tomlKey && /^[A-Za-z_][\w-]*$/.test(token)) {
    return "property";
  }
  // PascalCase identifiers (with at least one lowercase letter) read as type /
  // class names — this is what makes a TS/Rust file look highlighted rather than
  // a wall of plain text. ALL_CAPS constants are intentionally excluded.
  if (/^[A-Z][A-Za-z0-9]*$/.test(token) && /[a-z]/.test(token)) {
    return "type";
  }
  return;
}
