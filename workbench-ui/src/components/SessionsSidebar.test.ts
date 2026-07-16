import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../state/types";
import { sessionCloseTargets } from "./SessionsSidebar";

function sessions(...ids: string[]): AgentSession[] {
  return ids.map(
    (id) =>
      ({
        id,
      }) as AgentSession
  );
}

describe("sessionCloseTargets", () => {
  const options = sessions("one", "two", "three", "four");

  test("closes every session except the target", () => {
    expect(sessionCloseTargets(options, "two", "others")).toEqual([
      "one",
      "three",
      "four",
    ]);
  });

  test("closes sessions above the target", () => {
    expect(sessionCloseTargets(options, "three", "top")).toEqual([
      "one",
      "two",
    ]);
  });

  test("closes sessions below the target", () => {
    expect(sessionCloseTargets(options, "two", "bottom")).toEqual([
      "three",
      "four",
    ]);
  });

  test("does nothing for an unknown target", () => {
    expect(sessionCloseTargets(options, "missing", "others")).toEqual([]);
  });
});
