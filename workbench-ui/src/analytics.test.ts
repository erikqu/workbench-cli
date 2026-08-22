import { describe, expect, test } from "bun:test";
import { analyticsEnabled } from "./analytics";

describe("anonymous analytics controls", () => {
  test("is enabled for an ordinary installed launch", () => {
    expect(analyticsEnabled({})).toBe(true);
  });

  test("honors explicit opt-out and Do Not Track", () => {
    expect(analyticsEnabled({ WORKBENCH_TELEMETRY: "0" })).toBe(false);
    expect(analyticsEnabled({ DO_NOT_TRACK: "1" })).toBe(false);
  });

  test("does not pollute analytics during development or automation", () => {
    expect(analyticsEnabled({ WORKBENCH_CLI_HOT: "1" })).toBe(false);
    expect(analyticsEnabled({ WORKBENCH_UI_E2E: "1" })).toBe(false);
    expect(analyticsEnabled({ WORKBENCH_UI_SCREENSHOT: "1" })).toBe(false);
    expect(analyticsEnabled({ NODE_ENV: "test" })).toBe(false);
  });
});
