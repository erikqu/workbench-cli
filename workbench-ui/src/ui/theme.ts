// Single source of truth for the Workbench UI look. Each named theme derives a
// real Sterling theme from a brand accent, pins its surfaces, then adds an
// app-specific token bag for non-semantic colors (syntax, diff, terminal
// defaults). `themeTokens(name)` is handed to <ThemeProvider> so every Silvery
// component themes correctly. `colors` is a single mutable palette object that
// the rest of the app imports and reads at render time; `applyTheme(name)`
// swaps its values IN PLACE (same reference) so one re-render repaints the whole
// UI without every module having to re-import.

import type { Theme } from "silvery";
import { sterling } from "silvery/theme";

export interface ThemeDef {
  accent: string;
  app: Record<string, string>;
  label: string;
  mode: "dark" | "light";
  pins: Record<string, string>;
}

// Syntax + diff + terminal tokens shared by all the dark themes. Individual
// themes override what they care about (mostly surfaces + accent).
const darkInk = {
  "syntax-keyword": "#569cd6",
  "syntax-type": "#4ec9b0",
  "syntax-string": "#ce9178",
  "syntax-number": "#b5cea8",
  "syntax-property": "#9cdcfe",
  "diff-add-fg": "#73c991",
  "diff-del-fg": "#e06c75",
  "diff-add-bg": "#13241a",
  "diff-del-bg": "#271619",
  "diff-hunk": "#5c9cf5",
  "term-fg": "#eeece6",
  "term-fg-bold": "#ffffff",
} as const;

const lightInk = {
  "syntax-keyword": "#0000ff",
  "syntax-type": "#267f99",
  "syntax-string": "#a31515",
  "syntax-number": "#098658",
  "syntax-property": "#001080",
  "diff-add-fg": "#15803d",
  "diff-del-fg": "#b91c1c",
  "diff-add-bg": "#e6f4ea",
  "diff-del-bg": "#fbe9e9",
  "diff-hunk": "#2563eb",
  "term-fg": "#1f2328",
  "term-fg-bold": "#000000",
} as const;

const DEFS = {
  dark: {
    label: "Teal Dark",
    mode: "dark",
    accent: "#5fa8a8",
    pins: {
      "bg-surface-subtle": "#202023",
      "bg-surface-raised": "#26262a",
      "bg-surface-overlay": "#202023",
      "bg-muted": "#2a2a2e",
      "fg-default": "#e8e6df",
      "fg-muted": "#a5a5ad",
      "border-default": "#2e2e33",
      "border-focus": "#5fa8a8",
      "border-accent": "#5fa8a8",
      "fg-accent": "#5fa8a8",
      "fg-accent-hover": "#8fc6c6",
      "bg-selected": "#24403d",
      "bg-selected-hover": "#2c4d49",
      "fg-on-selected": "#ffffff",
    },
    app: {
      "app-bg": "#19191b",
      "app-activity": "#131315",
      "app-panel-alt": "#161618",
      "app-input": "#1b1b1e",
      "term-bg": "#161618",
      ...darkInk,
    },
  },
  light: {
    label: "Black on White",
    mode: "light",
    accent: "#0e7490",
    pins: {
      "bg-surface-subtle": "#f4f4f5",
      "bg-surface-raised": "#ebebed",
      "bg-surface-overlay": "#ffffff",
      "bg-muted": "#e4e4e7",
      "fg-default": "#18181b",
      "fg-muted": "#5b616b",
      "border-default": "#d4d4d8",
      "border-focus": "#0e7490",
      "border-accent": "#0e7490",
      "fg-accent": "#0e7490",
      "fg-accent-hover": "#0b5b72",
      "bg-selected": "#cfeaf1",
      "bg-selected-hover": "#bfe1ea",
      "fg-on-selected": "#082f3a",
    },
    app: {
      "app-bg": "#ffffff",
      "app-activity": "#f0f0f2",
      "app-panel-alt": "#f6f6f7",
      "app-input": "#ffffff",
      "term-bg": "#ffffff",
      ...lightInk,
    },
  },
  midnight: {
    label: "Midnight",
    mode: "dark",
    accent: "#7c93f5",
    pins: {
      "bg-surface-subtle": "#161925",
      "bg-surface-raised": "#1c2030",
      "bg-surface-overlay": "#161925",
      "bg-muted": "#232838",
      "fg-default": "#e7eaf2",
      "fg-muted": "#9aa3b8",
      "border-default": "#232838",
      "border-focus": "#7c93f5",
      "border-accent": "#7c93f5",
      "fg-accent": "#7c93f5",
      "fg-accent-hover": "#a3b3ff",
      "bg-selected": "#1f2b4d",
      "bg-selected-hover": "#273561",
      "fg-on-selected": "#ffffff",
    },
    app: {
      "app-bg": "#0f1117",
      "app-activity": "#0b0d12",
      "app-panel-alt": "#12141c",
      "app-input": "#131620",
      "term-bg": "#12141c",
      ...darkInk,
      "diff-hunk": "#7c93f5",
    },
  },
  amber: {
    label: "Amber Dark",
    mode: "dark",
    accent: "#f0a85c",
    pins: {
      "bg-surface-subtle": "#221d17",
      "bg-surface-raised": "#2a231b",
      "bg-surface-overlay": "#221d17",
      "bg-muted": "#2e271f",
      "fg-default": "#f1e7db",
      "fg-muted": "#b3a899",
      "border-default": "#2e271f",
      "border-focus": "#f0a85c",
      "border-accent": "#f0a85c",
      "fg-accent": "#f0a85c",
      "fg-accent-hover": "#ffc587",
      "bg-selected": "#3d2e1a",
      "bg-selected-hover": "#4a381f",
      "fg-on-selected": "#fff7ec",
    },
    app: {
      "app-bg": "#1a1714",
      "app-activity": "#141110",
      "app-panel-alt": "#18140f",
      "app-input": "#1c1813",
      "term-bg": "#18140f",
      ...darkInk,
      "diff-hunk": "#f0a85c",
    },
  },
  forest: {
    label: "Forest",
    mode: "dark",
    accent: "#6cc070",
    pins: {
      "bg-surface-subtle": "#181d14",
      "bg-surface-raised": "#1e241a",
      "bg-surface-overlay": "#181d14",
      "bg-muted": "#232a1d",
      "fg-default": "#e6eee0",
      "fg-muted": "#a5b09d",
      "border-default": "#232a1d",
      "border-focus": "#6cc070",
      "border-accent": "#6cc070",
      "fg-accent": "#6cc070",
      "fg-accent-hover": "#92e095",
      "bg-selected": "#1f3320",
      "bg-selected-hover": "#284028",
      "fg-on-selected": "#f1fbef",
    },
    app: {
      "app-bg": "#11140f",
      "app-activity": "#0c0f0a",
      "app-panel-alt": "#131710",
      "app-input": "#141a11",
      "term-bg": "#131710",
      ...darkInk,
      "diff-hunk": "#6cc070",
    },
  },
} satisfies Record<string, ThemeDef>;

export const THEME_ORDER = [
  "dark",
  "light",
  "midnight",
  "amber",
  "forest",
] as const;
export type ThemeName = (typeof THEME_ORDER)[number];
export const DEFAULT_THEME: ThemeName = "dark";

export const THEME_LABELS: Record<ThemeName, string> = Object.fromEntries(
  THEME_ORDER.map((name) => [name, DEFS[name].label])
) as Record<ThemeName, string>;

function colorMap(t: Record<string, string>) {
  return {
    bg: t["app-bg"],
    activity: t["app-activity"],
    panel: t["bg-surface-subtle"],
    panelAlt: t["app-panel-alt"],
    editor: t["app-bg"],
    input: t["app-input"],
    border: t["border-default"],
    borderFocus: t["border-focus"],
    text: t["fg-default"],
    dim: t["fg-muted"],
    accent: t["fg-accent"],
    accentAlt: t["fg-accent-hover"],
    selected: t["bg-selected"],
    selectedMuted: t["bg-muted"],
    onSelected: t["fg-on-selected"],
    diffAddFg: t["diff-add-fg"],
    diffDelFg: t["diff-del-fg"],
    diffAddBg: t["diff-add-bg"],
    diffDelBg: t["diff-del-bg"],
    diffHunk: t["diff-hunk"],
    syntaxKeyword: t["syntax-keyword"],
    syntaxType: t["syntax-type"],
    syntaxString: t["syntax-string"],
    syntaxNumber: t["syntax-number"],
    syntaxProperty: t["syntax-property"],
    syntaxComment: t["fg-muted"],
    termBg: t["term-bg"],
    termFg: t["term-fg"],
    termFgBold: t["term-fg-bold"],
    cursor: t["fg-accent"],
  };
}

export type Palette = ReturnType<typeof colorMap>;

interface BuiltTheme {
  colors: Palette;
  theme: Theme;
  tokens: Record<string, string>;
}

function buildTheme(def: ThemeDef): BuiltTheme {
  const theme = sterling.deriveFromColor(def.accent, {
    mode: def.mode,
    pins: def.pins,
  });
  const tokens = { ...theme, ...def.app } as unknown as Record<string, string>;
  return { theme, tokens, colors: colorMap(tokens) };
}

const BUILT: Record<ThemeName, BuiltTheme> = Object.fromEntries(
  THEME_ORDER.map((name) => [name, buildTheme(DEFS[name])])
) as Record<ThemeName, BuiltTheme>;

export function isThemeName(name: string | undefined): name is ThemeName {
  return !!name && (THEME_ORDER as readonly string[]).includes(name);
}

export function themeTokens(name: string): Record<string, string> {
  return (BUILT[name as ThemeName] ?? BUILT[DEFAULT_THEME]).tokens;
}

export function themeMode(name: string): ThemeDef["mode"] {
  return (DEFS[name as ThemeName] ?? DEFS[DEFAULT_THEME]).mode;
}

// Stable palette reference. Mutated in place by applyTheme(); never reassign or
// destructure at module scope or theme switching breaks.
export const colors: Palette = { ...BUILT[DEFAULT_THEME].colors };

export function applyTheme(name: string): ThemeName {
  const resolved = isThemeName(name) ? name : DEFAULT_THEME;
  Object.assign(colors, BUILT[resolved].colors);
  return resolved;
}

export function nextThemeName(current: string, dir = 1): ThemeName {
  const order = THEME_ORDER as readonly string[];
  const len = order.length;
  const base = isThemeName(current) ? current : DEFAULT_THEME;
  const idx = order.indexOf(base);
  return order[(idx + dir + len) % len] as ThemeName;
}
