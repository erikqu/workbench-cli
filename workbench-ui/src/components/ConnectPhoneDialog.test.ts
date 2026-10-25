import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { Screen } from "silvery";
import { createRenderer, waitFor } from "silvery/test";
import type { PhonePairingEvent } from "../phone-pairing";
import { ConnectPhoneDialog } from "./ConnectPhoneDialog";

test("phone dialog displays a complete QR, accepts the phone code, and closes its pairing process", async () => {
  let receive: (event: PhonePairingEvent) => void = () => {};
  const codes: string[] = [];
  let closed = false;
  const render = createRenderer({ cols: 100, rows: 45, autoRender: true });
  const app = render(
    createElement(
      Screen,
      null,
      createElement(ConnectPhoneDialog, {
        onClose() {},
        startPairing(callback) {
          receive = callback;
          return {
            approve(code) {
              codes.push(code);
            },
            close() {
              closed = true;
            },
          };
        },
      })
    )
  );
  try {
    await act(async () => {
      receive({
        type: "qr",
        art: "▄▄▄▄▄\n█ ▄ █\n█▄▄▄█\n",
        link: "private",
        expiresAt: Date.now() + 300_000,
      });
    });
    await waitFor(() => app.text.includes("█ ▄ █"));
    expect(app.text).toContain("Tailscale is ready");
    expect(app.text).toContain("█▄▄▄█");
    await act(async () => {
      receive({ type: "approval", device: "My iPhone" });
    });
    await waitFor(() => app.text.includes("My iPhone requested access"));
    await app.type("123456");
    await app.press("Enter");
    expect(codes).toEqual(["123456"]);
    await act(async () => {
      receive({ type: "paired" });
    });
    await waitFor(() => app.text.includes("Phone connected"));
  } finally {
    app.unmount();
  }
  expect(closed).toBe(true);
});

test("phone dialog keeps an oversized QR hidden instead of clipping a pairing code", async () => {
  let receive: (event: PhonePairingEvent) => void = () => {};
  const render = createRenderer({ cols: 50, rows: 20, autoRender: true });
  const app = render(
    createElement(
      Screen,
      null,
      createElement(ConnectPhoneDialog, {
        onClose() {},
        startPairing(callback) {
          receive = callback;
          return { approve() {}, close() {} };
        },
      })
    )
  );
  try {
    await act(async () => {
      receive({
        type: "qr",
        art: "█".repeat(65) + "\n",
        link: "private",
        expiresAt: Date.now() + 300_000,
      });
    });
    await waitFor(() => app.text.includes("Enlarge this terminal"));
    expect(app.text).not.toContain("█".repeat(20));
  } finally {
    app.unmount();
  }
});
