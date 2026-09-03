import { describe, expect, test } from "bun:test";
import { extractMermaidBlocks, findBrowserExecutable } from "./mermaid";

describe("Mermaid browser selection", () => {
  test("prefers an explicit Puppeteer browser path", () => {
    expect(
      findBrowserExecutable(
        "/opt/chrome",
        () => "/usr/bin/google-chrome",
        (path) => path === "/opt/chrome",
        "linux"
      )
    ).toBe("/opt/chrome");
  });

  test("falls back to an installed browser on PATH", () => {
    expect(
      findBrowserExecutable(
        undefined,
        (command) => (command === "chromium" ? "/usr/bin/chromium" : null),
        () => false,
        "linux"
      )
    ).toBe("/usr/bin/chromium");
  });

  test("uses a standard macOS application path when needed", () => {
    expect(
      findBrowserExecutable(
        undefined,
        () => null,
        (path) => path.includes("Google Chrome.app"),
        "darwin"
      )
    ).toContain("Google Chrome.app");
  });

  test("uses a standard Linux path when the shell PATH is minimal", () => {
    expect(
      findBrowserExecutable(
        undefined,
        () => null,
        (path) => path === "/snap/bin/chromium",
        "linux"
      )
    ).toBe("/snap/bin/chromium");
  });

  test("does not depend on the user's shell", () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const expected = `/${shell}/bin/chromium`;
      expect(
        findBrowserExecutable(
          undefined,
          (command) => (command === "chromium" ? expected : null),
          () => false,
          "linux"
        )
      ).toBe(expected);
    }
  });
});

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

  test("stops a flowchart before a following indented table", () => {
    expect(
      extractMermaidBlocks([
        "  flowchart LR",
        "    W[Editable Task workspace] --> R[Task Revision]",
        "    P[Project Setup head] --> E[Environment Version]",
        "    R --> T[Task Version]",
        "    R --> D[Data Bundle Version]",
        "    R --> V[Verifier Version]",
        "    V --> S[Verifier Set Version]",
        "    E --> C[Challenge Version]",
        "    T --> C",
        "    D --> C",
        "    S --> C",
        "    C --> B[Derived Harbor bundle]",
        "    B --> RS[Run Spec + model/config]",
        "    RS --> A[Run Attempt + evidence]",
        "",
        "   Layer                              What it means",
        "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━",
        "   Stable Task identity               Durable catalog object",
      ])
    ).toEqual([
      {
        startRow: 0,
        endRow: 13,
        source: [
          "flowchart LR",
          "    W[Editable Task workspace] --> R[Task Revision]",
          "    P[Project Setup head] --> E[Environment Version]",
          "    R --> T[Task Version]",
          "    R --> D[Data Bundle Version]",
          "    R --> V[Verifier Version]",
          "    V --> S[Verifier Set Version]",
          "    E --> C[Challenge Version]",
          "    T --> C",
          "    D --> C",
          "    S --> C",
          "    C --> B[Derived Harbor bundle]",
          "    B --> RS[Run Spec + model/config]",
          "    RS --> A[Run Attempt + evidence]",
        ].join("\n"),
      },
    ]);
  });
});
