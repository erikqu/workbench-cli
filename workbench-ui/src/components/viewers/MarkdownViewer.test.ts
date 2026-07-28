import { describe, expect, test } from "bun:test";
import { fitTableColumns, markdownViewportSize } from "./MarkdownViewer";

describe("markdown preview bounds", () => {
  test("clamps stale measurements to the visible terminal", () => {
    expect(
      markdownViewportSize(
        { x: 48, y: 4, width: 120, height: 80 },
        { columns: 80, rows: 24 }
      )
    ).toEqual({ width: 32, height: 20 });
  });

  test("allows a preview narrower than ten cells", () => {
    expect(
      markdownViewportSize(
        { x: 58, y: 4, width: 4, height: 10 },
        { columns: 60, rows: 18 }
      )
    ).toEqual({ width: 2, height: 10 });
  });

  test("fits wide table columns inside the preview", () => {
    const layout = fitTableColumns([40, 4, 80], 24);
    expect(
      layout.widths.reduce((sum, width) => sum + width + layout.gap, 0)
    ).toBeLessThanOrEqual(24);
    expect(layout.widths.every((width) => width >= 1)).toBe(true);
  });

  test("hides excess columns when the preview is extremely narrow", () => {
    const layout = fitTableColumns([4, 4, 4, 4], 2);
    expect(layout.widths.reduce((sum, width) => sum + width, 0)).toBe(2);
  });
});
