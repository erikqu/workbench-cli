import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isolatedInstance, workbenchDir } from "./state/workbench-paths";

export type PhonePairingEvent =
  | { type: "status"; message: string }
  | { type: "qr"; art: string; link: string; expiresAt: number }
  | { type: "approval"; device: string }
  | { type: "paired" }
  | { type: "error"; message: string };

export interface PhonePairing {
  approve(code: string): void;
  close(): void;
}

export function startPhonePairing(
  receive: (event: PhonePairingEvent) => void,
  command = [
    "bash",
    join(import.meta.dir, "..", "..", "bin", "workbench-phone"),
    "pair",
    "--json",
  ]
): PhonePairing {
  if (
    process.env.WORKBENCH_UI_SCREENSHOT === "1" ||
    process.env.WORKBENCH_UI_E2E === "1"
  ) {
    queueMicrotask(() =>
      receive({
        type: "error",
        message: "Phone pairing is unavailable in automated previews.",
      })
    );
    return { approve() {}, close() {} };
  }
  if (isolatedInstance()) {
    queueMicrotask(() =>
      receive({
        type: "error",
        message: "Open your normal Workbench instance to pair a phone.",
      })
    );
    return { approve() {}, close() {} };
  }
  const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, WORKBENCH_REMOTE_DIRECTORY: workbenchDir() },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let closed = false;
  let result = false;
  let diagnostic = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (closed) {
      return;
    }
    try {
      const event = JSON.parse(line) as PhonePairingEvent;
      if (
        !(
          event &&
          ["status", "qr", "approval", "paired", "error"].includes(event.type)
        )
      ) {
        return;
      }
      result ||= event.type === "paired" || event.type === "error";
      receive(event);
    } catch {
      // Never echo subprocess output: pairing links contain private secrets.
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-2000);
  });
  child.on("error", () => {
    if (!closed) {
      receive({
        type: "error",
        message:
          "Could not start phone pairing. Check that Bash and Node.js 24 or newer are installed.",
      });
    }
  });
  child.on("close", () => {
    if (!(closed || result)) {
      const missingNode = diagnostic.includes("Node.js 24");
      receive({
        type: "error",
        message: missingNode
          ? "Install Node.js 24 or newer from nodejs.org, then try again."
          : "Phone setup could not finish. Run work phone pair in a terminal for details.",
      });
    }
    lines.close();
  });
  return {
    approve(code) {
      if (!closed && /^\d{6}$/.test(code)) {
        child.stdin.write(`${code}\n`);
      }
    },
    close() {
      closed = true;
      lines.close();
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          if (process.platform === "win32") {
            child.kill("SIGTERM");
          } else {
            process.kill(-child.pid, "SIGTERM");
          }
        } catch {}
      }
    },
  };
}
