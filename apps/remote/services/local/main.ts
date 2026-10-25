import { hostname, homedir } from 'node:os';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { canonicalKey, generateIdentity, verificationCode, type PairingQR } from '../shared/protocol';
import { configPath, loadConfig, saveConfig } from '../host/config';
import { installService } from '../host/service';
import { startPrivateHost } from './runtime';
import { LocalStore } from './store';
import { configureTailscale } from './tailscale';
import { pairingLink } from './qr';

const origin = 'http://127.0.0.1:9419';
// Keep the private Tailscale identity separate from a previously installed public companion.
process.env.WORKBENCH_REMOTE_CONFIG ||= path.join(homedir(), '.config/workbench-remote/tailscale-host.json');
const command = process.argv[2] || 'pair', jsonMode = process.argv.includes('--json');
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function request(route: string, method = 'GET', body?: unknown) {
  const config = await loadConfig();
  const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', ...(config ? { Authorization: `Bearer ${config.hostToken}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(value.error || `Companion returned ${response.status}`);
  return value;
}
async function start() {
  const lock = configPath() + '.pid';
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    const previous = Number(await readFile(lock, 'utf8'));
    if (!Number.isInteger(previous) || previous < 1) throw new Error('Invalid companion PID file');
    try { process.kill(previous, 0); throw new Error('Companion is already running'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await unlink(lock);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handle = await open(lock, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close();
  let host: Awaited<ReturnType<typeof startPrivateHost>> | undefined;
  try {
    const store = new LocalStore(configPath() + '.store');
    let config = await loadConfig();
    if (!config) {
      const keys = generateIdentity(), pair = await store.createPair(hostname(), canonicalKey(keys.public));
      config = { relay: origin, machineId: pair.machineId, hostToken: pair.hostToken!, privateKey: keys.private, hostKey: canonicalKey(keys.public), directory: process.env.WORKBENCH_REMOTE_DIRECTORY || path.join(homedir(), '.workbench'), approvedKeys: {} };
      await saveConfig(config);
    }
    host = await startPrivateHost(store, config);
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
      if (closing) return; closing = true; await host!.close(); await unlink(lock).catch(() => {});
    });
  } catch (error) { if (host) await host.close(); await unlink(lock).catch(() => {}); throw error; }
}
async function pair() {
  if (!process.stdin.isTTY && !jsonMode) throw new Error('Run work phone pair in an interactive terminal.');
  if (jsonMode) emit({ type: 'status', message: 'Checking Tailscale and starting the companion...' });
  const address = configureTailscale();
  // This runs a user service; pairing does not depend on keeping the CLI open.
  try { if (process.env.WORKBENCH_PHONE_RESTART === '1') throw new Error('Reload companion'); await request('/v1/host/grants'); }
  catch { await installService(!jsonMode); }
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await request('/v1/host/grants'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!ready) throw new Error('The companion did not start. Check the user service logs.');
  const config = (await loadConfig())!;
  const value = await request('/v1/pairings', 'POST', { name: hostname(), hostKey: config.hostKey });
  const qr: PairingQR = { version: 1, relay: address, pairingId: value.pairingId, secret: value.secret, machineId: config.machineId, hostKey: config.hostKey };
  const link = pairingLink(qr);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let cancelled = false;
  const cancel = () => { cancelled = true; terminal.close(); };
  process.once('SIGTERM', cancel);
  let paired = false;
  try {
    if (jsonMode) {
      const art = await new Promise<string>(resolve => qrcode.generate(link, { small: true }, resolve));
      emit({ type: 'qr', link, art, expiresAt: value.expiresAt });
    } else {
      console.log('Open Tailscale on your iPhone, then scan this code in Workbench. It expires in five minutes.');
      qrcode.generate(link, { small: true });
    }
    while (Date.now() < value.expiresAt) {
      if (cancelled) throw new Error('Pairing cancelled');
      const pending = await request(`/v1/pairings/${value.pairingId}`);
      if (pending.status === 'claimed') {
        const expected = verificationCode(value.secret, config.hostKey, canonicalKey(pending.publicKey));
        const device = String(pending.deviceName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
        let entered: string;
        if (jsonMode) {
          emit({ type: 'approval', device });
          entered = await new Promise<string>((resolve, reject) => { const timer = setTimeout(() => { terminal.close(); reject(new Error('Pairing expired')); }, Math.max(1, value.expiresAt - Date.now()));
            terminal.once('line', line => { clearTimeout(timer); resolve(line); }); terminal.once('close', () => { clearTimeout(timer); reject(new Error('Pairing cancelled or expired')); }); });
        } else entered = await terminal.question(`Enter the six-digit code shown on ${device} (Enter cancels): `, { signal: AbortSignal.timeout(Math.max(1, value.expiresAt - Date.now())) });
        if (entered.trim() !== expected) throw new Error('Code did not match. This phone was not approved.');
        await request(`/v1/pairings/${value.pairingId}/confirm`, 'POST', { deviceId: pending.deviceId, publicKey: canonicalKey(pending.publicKey) });
        paired = true;
        if (jsonMode) emit({ type: 'paired' });
        else console.log('Phone paired. The companion runs automatically while this computer is awake and online.');
        return;
      }
      if (pending.status !== 'waiting') throw new Error('Pairing cancelled. Generate a new QR code.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('QR code expired. Start pairing again.');
  } finally { process.off('SIGTERM', cancel); terminal.close(); if (!paired) await request(`/v1/pairings/${value.pairingId}`, 'DELETE').catch(() => {}); }
}
async function main() {
  if (command === 'start') await start();
  else if (command === 'pair' || command === 'setup') await pair();
  else if (command === 'status') console.log(JSON.stringify(await request('/v1/host/grants'), null, 2));
  else console.log('work phone pair    Scan a QR and approve your iPhone over Tailscale\nwork phone start   Run the private companion in the foreground\nwork phone status  List paired devices\n\nInstall Workbench on iPhone through TestFlight when a beta invite is available.\nBoth devices must be signed in to Tailscale on the same tailnet.');
}
main().catch(error => { if (jsonMode) emit({ type: 'error', message: error.message }); else console.error(error.message); process.exitCode = 1; });
