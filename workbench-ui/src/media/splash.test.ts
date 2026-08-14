import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReadmeSplashArt, SPLASH_LOGO_PATH } from "./splash";

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
