import { expect, test } from "bun:test";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { createElement } from "react";
import { run } from "silvery/runtime";
import { FocusedTerminal } from "./FocusedTerminal";

const blankCell = {
  bg: null,
  bold: false,
  char: " ",
  dim: false,
  fg: null,
  inverse: false,
  italic: false,
  strikethrough: false,
  underline: false,
};

test("focused mirrored terminals paint their requested cursor", async () => {
  const terminal = {
    cols: 8,
    rows: 2,
    getCursor: () => ({ x: 2, y: 1, visible: true }),
    getLines: () => [
      new Array(8).fill(blankCell),
      new Array(8).fill(blankCell),
    ],
  };
  let output = "";
  const handle = await run(
    createElement(FocusedTerminal, { focused: true, terminal }),
    {
      cols: terminal.cols,
      input: false,
      mode: "fullscreen",
      rows: terminal.rows,
      writable: {
        write(data) {
          output += data;
        },
      },
    }
  );

  await Bun.sleep(25);
  handle.unmount();

  const rendered = new HeadlessTerminal({
    allowProposedApi: true,
    cols: terminal.cols,
    rows: terminal.rows,
  });
  await new Promise<void>((resolve) => rendered.write(output, resolve));
  const buffer = rendered.buffer.active;

  expect([buffer.cursorX, buffer.cursorY]).toEqual([2, 1]);
  expect(Boolean(buffer.getLine(1)?.getCell(2)?.isInverse())).toBe(true);
});
