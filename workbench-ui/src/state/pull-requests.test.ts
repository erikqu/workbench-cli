import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullRequestsCommand, resolvePullRequestsBin } from "./pull-requests";

describe("pull requests viewer command", () => {
  test("prefers an explicit binary over PATH", () => {
    expect(
      resolvePullRequestsBin(
        { WORKBENCH_PRS_BIN: "/opt/prs" },
        () => "/bin/prs"
      )
    ).toBe("/opt/prs");
    expect(resolvePullRequestsBin({}, () => "/bin/prs")).toBe("/bin/prs");
    expect(resolvePullRequestsBin({}, () => null)).toBeUndefined();
  });

  test("hands the binary to the pane through the environment", () => {
    const command = pullRequestsCommand("/path with spaces/prs");
    expect(command.env).toEqual({ WORKBENCH_PRS_BIN: "/path with spaces/prs" });
    expect(command.command).not.toContain("/path with spaces/prs");
  });

  test("reopens the viewer after it quits, and stops at end of input", () => {
    const dir = mkdtempSync(join(tmpdir(), "workbench-prs-"));
    const bin = join(dir, "fake prs");
    writeFileSync(bin, "#!/bin/sh\necho viewer-ran\n");
    chmodSync(bin, 0o755);
    const command = pullRequestsCommand(bin);
    // tmux runs the command through the user's shell; bash stands in for it.
    const result = Bun.spawnSync(["/bin/bash", "-c", command.command], {
      env: { ...Bun.env, ...command.env },
      stdin: new TextEncoder().encode("\n"),
    });
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output.match(/viewer-ran/g)).toHaveLength(2);
    expect(output).toContain("Press Enter to reopen.");
  });
});
