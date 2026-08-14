import { describe, expect, test } from "bun:test";
import { githubRepositoryInput } from "./github-repo";

describe("githubRepositoryInput", () => {
  test("places HTTPS repositories beside the current workspace", () => {
    expect(
      githubRepositoryInput(
        "https://github.com/openai/codex.git",
        "/mnt/projects/workbench-cli"
      )
    ).toEqual({
      cloneUrl: "https://github.com/openai/codex.git",
      destination: "/mnt/projects/codex",
      name: "codex",
    });
  });

  test("accepts GitHub SSH and host-only forms", () => {
    expect(
      githubRepositoryInput(
        "git@github.com:openai/codex.git",
        "/mnt/projects/workbench-cli"
      )?.destination
    ).toBe("/mnt/projects/codex");
    expect(
      githubRepositoryInput(
        "github.com/openai/codex",
        "/mnt/projects/workbench-cli"
      )?.cloneUrl
    ).toBe("https://github.com/openai/codex.git");
  });

  test("rejects non-repository and nested GitHub pages", () => {
    expect(
      githubRepositoryInput("../another-workspace", "/mnt/projects/current")
    ).toBeNull();
    expect(
      githubRepositoryInput(
        "https://github.com/openai/codex/tree/main",
        "/mnt/projects/current"
      )
    ).toBeNull();
  });
});
