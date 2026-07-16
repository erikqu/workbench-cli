import { describe, expect, test } from "bun:test";
import { tabCloseTargets, tabIndexAtOffset } from "./MainTabs";
import type { TabSelectOption } from "./types";

const options: TabSelectOption[] = [
  { name: "Agent", value: "harness:h1" },
  { name: "Terminal", value: "term:t1" },
  { name: "One", value: "/tmp/one" },
  { name: "Two", value: "/tmp/two" },
];

describe("tabCloseTargets", () => {
  test("selects closable tabs on each requested side", () => {
    expect(tabCloseTargets(options, "/tmp/one", "left", false)).toEqual([
      "term:t1",
    ]);
    expect(tabCloseTargets(options, "/tmp/one", "right", false)).toEqual([
      "/tmp/two",
    ]);
  });

  test("closes all other closable tabs without removing the last harness", () => {
    expect(tabCloseTargets(options, "term:t1", "others", false)).toEqual([
      "/tmp/one",
      "/tmp/two",
    ]);
    expect(tabCloseTargets(options, "term:t1", "others", true)).toEqual([
      "harness:h1",
      "/tmp/one",
      "/tmp/two",
    ]);
  });
});

describe("tabIndexAtOffset", () => {
  test("maps a right-click column to the rendered tab", () => {
    expect(tabIndexAtOffset(options, 2, false)).toBe(0);
    expect(tabIndexAtOffset(options, 12, false)).toBe(1);
    expect(tabIndexAtOffset(options, 25, false)).toBe(2);
  });
});
