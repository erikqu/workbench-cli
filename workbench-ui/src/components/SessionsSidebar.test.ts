import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../state/types";
import {
  sessionCloseTargets,
  sessionFlowOffset,
  sessionFlowStrengths,
} from "./SessionsSidebar";

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

describe("sessionFlowOffset", () => {
  test("moves to the far edge and then reverses", () => {
    expect(
      Array.from({ length: 9 }, (_, step) => sessionFlowOffset(step, 9, 5))
    ).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
  });

  test("stays at the start when the segment fills the rail", () => {
    expect(sessionFlowOffset(100, 3, 5)).toBe(0);
  });

  test("fades symmetrically away from the moving point", () => {
    expect(sessionFlowStrengths(4, 9)).toEqual([
      0.12, 0.28, 0.48, 0.72, 1, 0.72, 0.48, 0.28, 0.12,
    ]);
  });

  test("clips the gradient cleanly at an edge", () => {
    expect(sessionFlowStrengths(0, 6)).toEqual([1, 0.72, 0.48, 0.28, 0.12, 0]);
  });
});
