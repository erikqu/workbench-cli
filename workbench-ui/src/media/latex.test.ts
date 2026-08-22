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
});
