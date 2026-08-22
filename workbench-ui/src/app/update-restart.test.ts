import { describe, expect, test } from "bun:test";
import {
  updateRestartCommand,
  updateRestartHasSupervisor,
} from "./update-restart";

describe("in-app update restart", () => {
  test("delegates to a launcher or hot runner that advertises supervision", () => {
    expect(
      updateRestartHasSupervisor({ WORKBENCH_CLI_RESTART_SUPERVISOR: "1" })
    ).toBe(true);
    expect(updateRestartHasSupervisor({ WORKBENCH_CLI_HOT: "1" })).toBe(true);
    expect(updateRestartHasSupervisor({})).toBe(false);
  });

  test("preserves UI arguments for an old-launcher compatibility relaunch", () => {
    expect(
      updateRestartCommand("/home/me/.local/bin/work", [
        "bun",
        "/app/src/index.ts",
        "--terminal-trace",
        "/workspace",
      ])
    ).toEqual(["/home/me/.local/bin/work", "--terminal-trace", "/workspace"]);
  });
});
