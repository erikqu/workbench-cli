// Runs inside the isolated relay image: real bundled companion/process startup,
// simulated Tailscale commands and HTTPS transport, no personal tailnet or state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "workbench-phone-container-"));
const configFile = path.join(directory, "host.json");
const tailscale = path.join(directory, "tailscale.mjs");
const preload = path.join(directory, "transport.mjs");
const entry = "/app/dist/services/local/main.mjs";
let pairing;
async function stopPairing(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM"); await done;
}
async function showQR() {
  const child = spawn(process.execPath, [entry, "pair", "--json"], {
    env: { ...process.env, WORKBENCH_REMOTE_CONFIG: configFile,
      WORKBENCH_REMOTE_DIRECTORY: directory, WORKBENCH_TAILSCALE_BIN: tailscale,
      WORKBENCH_PHONE_VERSION: "container-fixture", NODE_OPTIONS: `--import=${preload}` },
    stdio: ["pipe", "pipe", "ignore"],
  });
  pairing = child;
  const lines = createInterface({ input: child.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Container pairing did not show a QR")), 30_000);
      const fail = () => { clearTimeout(timer); reject(new Error("Container pairing exited before showing a QR")); };
      child.once("exit", fail); child.once("error", fail);
      lines.on("line", line => {
        const event = JSON.parse(line);
        if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
        if (event.type === "qr") {
          clearTimeout(timer); child.removeListener("exit", fail); child.removeListener("error", fail);
          assert.match(event.link, /^workbench-remote:\/\/pair/); assert.ok(event.art.length > 100);
          resolve();
        }
      });
    });
  } finally { lines.close(); }
  return child;
}
try {
  await writeFile(tailscale, `#!/usr/bin/env node
console.log(JSON.stringify(process.argv[2] === 'status' ? {BackendState:'Running',Self:{DNSName:'fixture.example.ts.net.'}} : {}));
`, { mode: 0o755 });
  await writeFile(preload, `const original = globalThis.fetch;
globalThis.fetch = (input, options) => original(typeof input === 'string' ? input.replace('https://fixture.example.ts.net:8443', 'http://127.0.0.1:9419') : input, options);
`);
  const first = await showQR();
  const pid = await readFile(configFile + ".pid", "utf8");
  await stopPairing(first);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const response = await fetch("http://127.0.0.1:9419/v1/host/grants", { headers: { Authorization: `Bearer ${config.hostToken}` } });
  assert.equal(response.status, 200, "closing the dialog must leave the companion running");
  const second = await showQR();
  assert.equal(await readFile(configFile + ".pid", "utf8"), pid, "retry must reuse the same companion");
  await stopPairing(second);
  console.log("Container button flow starts a background companion, shows a QR, survives dialog closure, and reuses the companion.");
} finally {
  if (pairing) await stopPairing(pairing);
  try {
    const config = JSON.parse(await readFile(configFile, "utf8"));
    await fetch("http://127.0.0.1:9419/v1/host/stop", { method: "POST", headers: { Authorization: `Bearer ${config.hostToken}` } });
    for (let i = 0; i < 30; i++) {
      try { await readFile(configFile + ".pid"); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
