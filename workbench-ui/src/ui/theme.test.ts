import { afterEach, describe, expect, test } from "bun:test";
import {
  applyTheme,
  colors,
  DEFAULT_THEME,
  isThemeName,
  nextThemeName,
  THEME_LABELS,
  THEME_ORDER,
  themeMode,
  themeTokens,
} from "./theme";

describe("red theme", () => {
  afterEach(() => {
    applyTheme(DEFAULT_THEME);
  });

  test("is available in the theme cycle", () => {
    expect(THEME_ORDER).toContain("red");
    expect(THEME_LABELS.red).toBe("Red Dark");
    expect(isThemeName("red")).toBe(true);
    expect(nextThemeName("amber")).toBe("red");
    expect(nextThemeName("forest", -1)).toBe("red");
  });

  test("provides a complete dark palette", () => {
    const tokens = themeTokens("red");

    expect(themeMode("red")).toBe("dark");
    expect(tokens["app-bg"]).toBe("#180f11");
    expect(tokens["fg-accent"]).toBe("#ef6262");
    expect(tokens["term-bg"]).toBe("#1b1113");
    expect(tokens["fg-default"]).toBeTruthy();
    expect(tokens["bg-error"]).toBeTruthy();
  });

  test("applies the red palette in place", () => {
    const paletteReference = colors;

    expect(applyTheme("red")).toBe("red");
    expect(colors).toBe(paletteReference);
    expect(colors.accent).toBe("#ef6262");
    expect(colors.bg).toBe("#180f11");
    expect(colors.termBg).toBe("#1b1113");
  });
});
