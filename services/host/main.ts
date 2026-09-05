import { createInterface } from 'node:readline/promises';
import { hostname, homedir } from 'node:os';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { canonicalKey, generateIdentity, relayURL, verificationCode, type HostConfiguration, type PairingQR } from '../shared/protocol';
import { configPath, loadConfig, saveConfig } from './config';
import { installService } from './service';
import { Companion } from './companion';
import { Sessions } from './sessions';

const args = process.argv.slice(2), command = args[0] || 'help';
function flag(name: string) { const index = args.indexOf('--' + name); return index < 0 ? undefined : args[index + 1]; }
async function request(origin: string, route: string, method: string, body?: unknown, credential?: string) {
  const response = await fetch(new URL(route, relayURL(origin)), { method, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(value.error || `Relay returned ${response.status}`);
  return value;
}
async function pair() {
  if (!process.stdin.isTTY) throw new Error('Pairing requires an interactive terminal to confirm the device code');
  let config = await loadConfig();
  if (!config) {
    const origin = flag('relay'); if (!origin) throw new Error('Usage: workbench-remote setup --relay https://your-relay.example');
    const relay = relayURL(origin).origin;
    const keys = generateIdentity();
    const requested = flag('directory') || path.join(homedir(), '.workbench');
    const directory = path.resolve(requested.startsWith('~/') ? path.join(homedir(), requested.slice(2)) : requested);
    config = { relay, machineId: '', hostToken: '', privateKey: keys.private, hostKey: canonicalKey(keys.public), directory, approvedKeys: {} };
  } else if (flag('relay') && relayURL(flag('relay')!).origin !== config.relay) throw new Error('This companion is already paired with a different relay. Use a separate WORKBENCH_REMOTE_CONFIG to connect elsewhere.');
  const pair = await request(config.relay, '/v1/pairings', 'POST', { name: flag('name') || hostname(), hostKey: config.hostKey }, config.hostToken || undefined);
  config.machineId = pair.machineId; if (pair.hostToken) config.hostToken = pair.hostToken;
  await saveConfig(config);
  const qr: PairingQR = { version: 1, relay: config.relay, pairingId: pair.pairingId, secret: pair.secret, machineId: config.machineId, hostKey: config.hostKey };
  const encoded = 'workbench-remote://pair?data=' + Buffer.from(JSON.stringify(qr)).toString('base64url');
  console.log('Scan this QR code in Workbench Remote on your iPhone. It expires in five minutes.');
  qrcode.generate(encoded, { small: true });
  console.log('\nManual pairing link (keep private):\n' + encoded);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (Date.now() < pair.expiresAt) {
      const pending = await request(config.relay, `/v1/pairings/${pair.pairingId}`, 'GET', undefined, config.hostToken);
      if (pending.status === 'claimed') {
        const deviceKey = canonicalKey(pending.publicKey);
        const expected = verificationCode(pair.secret, config.hostKey, deviceKey);
        // Ask for the code on the phone; the relay cannot substitute the device key undetected.
        const entered = await terminal.question(`Device "${String(pending.deviceName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80)}" requested access. Enter the six-digit code shown on that iPhone (or press Enter to cancel): `);
        if (entered.trim() !== expected) throw new Error('Verification code did not match. Device was not approved.');
        config.approvedKeys[pending.deviceId] = deviceKey;
        await saveConfig(config);
        await request(config.relay, `/v1/pairings/${pair.pairingId}/confirm`, 'POST', { deviceId: pending.deviceId, publicKey: deviceKey }, config.hostToken);
        console.log('Device paired. Run start to connect, or service to run automatically. Restart an already running companion to load the newly paired key.'); return;
      }
      if (pending.status !== 'waiting') throw new Error('Pairing is no longer available');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('Pairing expired. Run setup again.');
  } finally { terminal.close(); }
}
async function lock(): Promise<() => Promise<void>> {
  const file = configPath() + '.pid'; await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); return async () => { await unlink(file).catch(() => {}); }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid companion PID file: ' + file);
      try { process.kill(pid, 0); throw new Error('Companion is already running'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
      await unlink(file);
    }
  }
  throw new Error('Could not acquire companion lock');
}
async function main() {
  if (command === 'setup' || command === 'pair') await pair();
  else if (command === 'service') { if (!await loadConfig()) throw new Error('Pair a device first'); await installService(); }
  else if (command === 'start') {
    const config = await loadConfig(); if (!config) throw new Error('Run setup first');
    const unlock = await lock(), companion = new Companion(config); let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { if (closing) return; closing = true; companion.close(); await unlock(); });
    companion.start();
  } else if (command === 'status') {
    const config = await loadConfig(); if (!config) throw new Error('Not paired');
    const sessions = new Sessions(config.directory);
    try { const snapshot = await sessions.snapshot(); console.log(JSON.stringify({ relay: config.relay, machineId: config.machineId, workspaces: snapshot.workspaces.length, liveSessions: snapshot.workspaces.flatMap(w => w.panes).filter(p => p.live).length, warning: snapshot.warning }, null, 2)); }
    finally { sessions.close(); }
  } else console.log('Workbench Remote companion\n\n  setup --relay https://relay.example [--directory ~/.workbench]\n  pair       Pair another iPhone\n  start      Run in the foreground\n  service    Install and start a user service\n  status     Check local session discovery');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
