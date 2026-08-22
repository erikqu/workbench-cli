import { describe, expect, test } from "bun:test";
import { extractDisplayMath, extractDisplayMathBlocks } from "./latex";

describe("terminal LaTeX extraction", () => {
  test("finds Codex display blocks whose slash delimiters were rendered away", () => {
    const transcript = String.raw`Its functional composition is:

[
x_t=E(o_t)
]

[
h_t=\operatorname{GRU}(x_t,h_{t-1})
]

ordinary prose
[
not an equation
]`;

    expect(extractDisplayMath(transcript)).toEqual([
      "x_t=E(o_t)",
      String.raw`h_t=\operatorname{GRU}(x_t,h_{t-1})`,
    ]);
  });

  test("accepts normal display delimiters and rejects unsafe TeX", () => {
    const transcript = String.raw`\[
\pi_t=\operatorname{softmax}(W_\pi h_t)
\]
$$\theta \leftarrow \theta-\eta\nabla_\theta L_{\mathrm{PPO}}$$
[
\input{/etc/passwd}=x
]`;

    expect(extractDisplayMath(transcript)).toEqual([
      String.raw`\pi_t=\operatorname{softmax}(W_\pi h_t)`,
      String.raw`\theta \leftarrow \theta-\eta\nabla_\theta L_{\mathrm{PPO}}`,
    ]);
  });

  test("reports the exact viewport rows an inline overlay should replace", () => {
    expect(
      extractDisplayMathBlocks(["before", "[", "x_t=E(o_t)", "]", "after"])
    ).toEqual([{ startRow: 1, endRow: 3, formula: "x_t=E(o_t)" }]);
  });

  test("accepts text-only equations emitted by Codex", () => {
    const transcript = String.raw`But attention only solves:
[
\text{Can the model access the old cue?}
]
It does not solve:
[
\text{Which old cue/action caused the delayed reward?}
]`;

    expect(extractDisplayMath(transcript)).toEqual([
      String.raw`\text{Can the model access the old cue?}`,
      String.raw`\text{Which old cue/action caused the delayed reward?}`,
    ]);
  });

  test("accepts a display delimiter decorated as a Markdown heading", () => {
    const transcript = String.raw`# [
\boxed{
\text{MORPHEUS}
+
\underbrace{\text{selected replay}}_{\text{sleep mechanism}}
}
]`;

    expect(extractDisplayMath(transcript)).toEqual([
      String.raw`\boxed{ \text{MORPHEUS} + \underbrace{\text{selected replay}}_{\text{sleep mechanism}} }`,
    ]);
  });

  test("extracts a complete standalone TikZ document", () => {
    const transcript = String.raw`before
\documentclass[tikz,border=8pt]{standalone}
\usepackage{amsmath}
\usetikzlibrary{arrows.meta,positioning,fit}
\begin{document}
\begin{tikzpicture}[
  node distance=8mm,
  arrow/.style={-{Latex[length=2mm]}, thick}
]
\node (obs) {Observation $o_t$};
\node[right=of obs] (encoder) {Encoder};
\draw[arrow] (obs) -- (encoder);
\end{tikzpicture}
\end{document}
after`;

    const blocks = extractDisplayMathBlocks(transcript.split("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startRow).toBe(1);
    expect(blocks[0]?.endRow).toBe(13);
    expect(blocks[0]?.formula).toContain(
      String.raw`\usetikzlibrary{arrows.meta,positioning,fit}`
    );
  });

  test("rejects unsafe commands inside a TikZ picture", () => {
    const transcript = String.raw`\documentclass{standalone}
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}
\node {\input{/etc/passwd}};
\end{tikzpicture}
\end{document}`;

    expect(extractDisplayMath(transcript)).toEqual([]);
  });

  test("renders a closed TikZ picture when the outer document is unfinished", () => {
    const transcript = String.raw`\documentclass[tikz]{standalone}
\usepackage{tikz}
\usetikzlibrary{fit}
\begin{document}
\begin{tikzpicture}
\node[draw] (model) {Model};
\node[draw,fit=(model)] {};
\end{tikzpicture}

# [
\boxed{\text{a separate equation}}`;

    const blocks = extractDisplayMathBlocks(transcript.split("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startRow).toBe(0);
    expect(blocks[0]?.endRow).toBe(7);
    expect(blocks[0]?.formula).toEndWith(String.raw`\end{tikzpicture}`);
  });
});
