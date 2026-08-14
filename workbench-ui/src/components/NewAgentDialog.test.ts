import { expect, test } from "bun:test";
import { defaultWorkspaceDirectory } from "./NewAgentDialog";

test("new workspaces default to the current workspace's parent directory", () => {
  expect(defaultWorkspaceDirectory("/mnt/projects/workbench-cli")).toBe(
    "/mnt/projects/"
  );
  expect(defaultWorkspaceDirectory("/")).toBe("/");
});
