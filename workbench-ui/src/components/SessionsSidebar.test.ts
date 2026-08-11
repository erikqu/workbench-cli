import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../state/types";
import {
  SESSION_ROW_HEIGHT,
  sessionCloseTargets,
  sessionFlowOffset,
  sessionFlowStrengths,
} from "./SessionsSidebar";

test("session rows reserve a dedicated top separator", () => {
  expect(SESSION_ROW_HEIGHT).toBe(3);
});

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
  test("moves the bright point across the full rail and then reverses", () => {
    expect(
      Array.from({ length: 17 }, (_, step) => sessionFlowOffset(step, 9))
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  test("still animates when diff badges shorten the rail", () => {
    expect(
      Array.from({ length: 9 }, (_, step) => sessionFlowOffset(step, 5))
    ).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
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
