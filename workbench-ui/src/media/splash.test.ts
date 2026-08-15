import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReadmeSplashArt,
  buildVerticalWorkbenchArt,
  SPLASH_LOGO_PATH,
} from "./splash";

test("splash uses the exact ASCII wordmark from the README", () => {
  expect(existsSync(SPLASH_LOGO_PATH)).toBe(true);

  const readme = readFileSync(
    join(import.meta.dir, "..", "..", "..", "README.md"),
    "utf8"
  );
  const readmeArt = readme.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? "";
  const splashArt = buildReadmeSplashArt(120, 20).join("\n");

  expect(splashArt).toBe(readmeArt);
  expect(splashArt).toContain("888d88888b888");
});

test("splash falls back cleanly when the README wordmark cannot fit", () => {
  expect(buildReadmeSplashArt(60, 20)).toEqual(["Workbench"]);
  expect(buildReadmeSplashArt(120, 4)).toEqual(["Workbench"]);
});

test("vertical wordmark rotates and scales the real ASCII bitmap", () => {
  expect(buildVerticalWorkbenchArt(0)).toEqual([]);
  expect(buildVerticalWorkbenchArt(18)).toHaveLength(18);
  expect(buildVerticalWorkbenchArt(40)).toHaveLength(21);
  expect(buildVerticalWorkbenchArt(18).join("")).toMatch(/[\u2801-\u28ff]/u);
  expect(buildVerticalWorkbenchArt(40, 1.5)).toHaveLength(32);
  expect(
    Math.max(...buildVerticalWorkbenchArt(40, 1.5).map((line) => line.length))
  ).toBe(6);
});
