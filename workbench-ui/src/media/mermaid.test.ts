import { describe, expect, test } from "bun:test";
import { extractMermaidBlocks } from "./mermaid";

describe("terminal Mermaid extraction", () => {
  test("finds canonical fenced Markdown and reports its exact rows", () => {
    expect(
      extractMermaidBlocks([
        "before",
        "```mermaid",
        "flowchart LR",
        "  A --> B",
        "```",
        "after",
      ])
    ).toEqual([
      {
        startRow: 1,
        endRow: 4,
        source: "flowchart LR\n  A --> B",
      },
    ]);
  });

  test("finds a harness-rendered language row and source", () => {
    expect(
      extractMermaidBlocks([
        "mermaid",
        "sequenceDiagram",
        "  Alice->>Bob: Hello",
        "",
        "ordinary prose",
      ])
    ).toEqual([
      {
        startRow: 0,
        endRow: 2,
        source: "sequenceDiagram\n  Alice->>Bob: Hello",
      },
    ]);
  });

  test("finds fence-stripped source emitted by a harness", () => {
    expect(
      extractMermaidBlocks([
        "Some explanation:",
        "stateDiagram-v2",
        "  [*] --> Ready",
        "  Ready --> Done",
        "",
        "More explanation.",
      ])
    ).toEqual([
      {
        startRow: 1,
        endRow: 3,
        source: "stateDiagram-v2\n  [*] --> Ready\n  Ready --> Done",
      },
    ]);
  });

  test("finds Codex bullet output and keeps internal blank rows", () => {
    expect(
      extractMermaidBlocks([
        "• flowchart LR",
        "      T[Trajectory Viewer] --> A[Assets]",
        "      A --> I[Input Assets]",
        "      A --> O[Output Assets]",
        "",
        "      I --> D[Preview & Download]",
        "      O --> D",
        "",
        "Following prose is not part of the diagram.",
      ])
    ).toEqual([
      {
        startRow: 0,
        endRow: 6,
        source:
          "flowchart LR\n      T[Trajectory Viewer] --> A[Assets]\n      A --> I[Input Assets]\n      A --> O[Output Assets]\n\n      I --> D[Preview & Download]\n      O --> D",
      },
    ]);
  });

  test("ignores an ordinary mention without a diagram declaration", () => {
    expect(
      extractMermaidBlocks(["mermaid", "This paragraph talks about diagrams."])
    ).toEqual([]);
  });

  test("accepts decorated fences, gutters, and Mermaid frontmatter", () => {
    expect(
      extractMermaidBlocks([
        "• ```mermaid title=example",
        "  │ ---",
        "  │ title: Request path",
        "  │ ---",
        "  │ flowchart TD",
        "  │   Client --> Server",
        "• ```",
      ])
    ).toEqual([
      {
        startRow: 0,
        endRow: 6,
        source:
          "---\ntitle: Request path\n---\nflowchart TD\n  Client --> Server",
      },
    ]);
  });

  test("stops a rendered diagram at a new bullet without a blank row", () => {
    expect(
      extractMermaidBlocks([
        "● flowchart LR",
        "    A --> B",
        "    B --> C",
        "● This is the next prose item.",
      ])
    ).toEqual([
      {
        startRow: 0,
        endRow: 2,
        source: "flowchart LR\n    A --> B\n    B --> C",
      },
    ]);
  });
});
