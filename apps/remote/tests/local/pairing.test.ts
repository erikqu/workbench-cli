import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'ssh2';
import { WebSocket, createWebSocketStream } from 'ws';
import { LocalStore } from '../../services/local/store';
import { startPrivateHost } from '../../services/local/runtime';
import { canonicalKey, generateIdentity, PROTOCOL } from '../../services/shared/protocol';
import { pairingLink } from '../../services/local/qr';

async function until(condition: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out waiting for private host');
}
test('private pairing: QR approval, encrypted live tmux access, restart persistence and revocation', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-phone-test-'));
  const socket = path.join(directory, 'tmux-ui.sock'), session = 'workbench_h_phone_fixture';
  const tmux = (args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
  let host: Awaited<ReturnType<typeof startPrivateHost>> | undefined;
  let client: Client | undefined, ws: WebSocket | undefined;
  try {
    tmux(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', '/bin/sh']);
    tmux(['set-option', '-g', 'status', 'off']);
    const pid = tmux(['display-message', '-p', '-t', session, '#{pane_pid}']);
    const layout = JSON.stringify({ sessions: [{ id: 'test-workspace', cwd: directory, harnesses: [{ tmux: session, name: 'Fixture' }] }] });
    await writeFile(path.join(directory, 'workbench-ui-state.json'), layout);
    const key = generateIdentity(), phone = generateIdentity(), wrong = generateIdentity();
    const storeFile = path.join(directory, 'private.store');
    let store = new LocalStore(storeFile);
    const pair = await store.createPair('My computer', canonicalKey(key.public));
    const config = { relay: '', machineId: pair.machineId, hostToken: pair.hostToken!, hostKey: canonicalKey(key.public), privateKey: key.private, directory, approvedKeys: {} };
    const link = pairingLink({ version: 1, relay: 'https://computer.example.ts.net:8443', pairingId: pair.pairingId, secret: pair.secret, machineId: pair.machineId, hostKey: config.hostKey });
    assert.ok(link.length < 300, 'QR retains all identities in a compact representation');
    const decoded = Buffer.from(new URL(link).searchParams.get('data')!, 'base64url');
    assert.equal(decoded[0], 2); assert.equal(decoded.subarray(17, 49).toString('base64url'), pair.secret);
    assert.equal(decoded.subarray(65, 116).toString('base64'), config.hostKey.split(' ')[1]);
    host = await startPrivateHost(store, config, 0);
    async function api(route: string, method = 'GET', body?: unknown, credential?: string, status = 200) {
      const response = await fetch(host!.origin + route, { method, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, status, `${method} ${route}`); return await response.json() as any;
    }
    await api('/v1/pairings', 'POST', { name: 'Attacker', hostKey: wrong.public }, undefined, 401);
    const login = await api('/v1/auth/pairing', 'POST', { pairingId: pair.pairingId, secret: pair.secret, publicKey: phone.public, name: 'My iPhone' });
    assert.deepEqual((await api('/v1/machines', 'GET', undefined, login.accessToken)).machines, []);
    await api(`/v1/pairings/${pair.pairingId}/claim`, 'POST', { secret: pair.secret }, login.accessToken);
    await api(`/v1/pairings/${pair.pairingId}/confirm`, 'POST', { deviceId: login.deviceId, publicKey: phone.public }, login.accessToken, 401);
    await api(`/v1/pairings/${pair.pairingId}/confirm`, 'POST', { deviceId: login.deviceId, publicKey: wrong.public }, config.hostToken, 409);
    await api(`/v1/pairings/${pair.pairingId}/confirm`, 'POST', { deviceId: login.deviceId, publicKey: phone.public }, config.hostToken);
    await until(async () => (await api('/v1/machines', 'GET', undefined, login.accessToken)).machines[0]?.online === true);
    // The same host accepts the newly approved key immediately, without restart.
    ws = new WebSocket(host.origin.replace('http:', 'ws:') + '/v1/tunnel/' + config.machineId, { headers: { Authorization: `Bearer ${login.accessToken}` } });
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
    const stream = createWebSocketStream(ws);
    client = new Client();
    await new Promise<void>((resolve, reject) => { client!.once('ready', resolve); client!.once('error', reject); client!.connect({ sock: stream, username: login.deviceId, privateKey: phone.private, hostVerifier: (raw: Buffer) => raw.equals(Buffer.from(config.hostKey.split(' ')[1], 'base64')) }); });
    const control = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => client!.subsys(PROTOCOL, (error, channel) => error ? reject(error) : resolve(channel)));
    let messages = ''; control.on('data', (data: Buffer) => messages += data.toString());
    control.write(JSON.stringify({ id: 'list', method: 'list' }) + '\n');
    await until(async () => messages.includes('test-workspace') && messages.includes(session));
    const channel = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => client!.exec('workbench-attach:' + session, { pty: { cols: 100, rows: 30 } }, (error, channel) => error ? reject(error) : resolve(channel)));
    let output = ''; channel.on('data', (data: Buffer) => output += data.toString());
    await until(async () => output.length > 0 && messages.includes('"type":"sessionState"'));
    channel.write("printf '\\nPHONE_PAIRING_OK\\n'\n");
    await until(async () => tmux(['capture-pane', '-p', '-t', session]).includes('PHONE_PAIRING_OK'));
    await api(`/v1/machines/${config.machineId}/devices/${login.deviceId}`, 'DELETE', undefined, login.accessToken);
    assert.deepEqual((await api('/v1/machines', 'GET', undefined, login.accessToken)).machines, []);
    await until(async () => ws!.readyState === WebSocket.CLOSED);
    assert.equal(tmux(['display-message', '-p', '-t', session, '#{pane_pid}']), pid);
    assert.equal(await readFile(path.join(directory, 'workbench-ui-state.json'), 'utf8'), layout);
    assert.equal((await stat(storeFile)).mode & 0o777, 0o600);
    await host.close(); host = undefined;
    store = new LocalStore(storeFile);
    assert.deepEqual(await store.grants(config.machineId), [], 'revocation survives restart');
    const nextPair = await store.createPair('My computer', config.hostKey, await store.machine(config.hostToken));
    const device = await store.device(login.accessToken);
    await store.claim(nextPair.pairingId, nextPair.secret, device); await store.confirm(nextPair.pairingId, await store.machine(config.hostToken), device.id, canonicalKey(phone.public));
    host = await startPrivateHost(new LocalStore(storeFile), config, 0);
    await until(async () => (await api('/v1/machines', 'GET', undefined, login.accessToken)).machines[0]?.online === true);
    assert.equal(tmux(['display-message', '-p', '-t', session, '#{pane_pid}']), pid);
  } finally { client?.end(); ws?.terminate(); if (host) await host.close(); try { tmux(['kill-server']); } catch {} await rm(directory, { recursive: true, force: true }); }
});
test('private pairing expiry, cancellation and revoked keys cannot bypass approval', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-phone-store-'));
  try {
    const store = new LocalStore(path.join(directory, 'store')), key = generateIdentity();
    const pair = await store.createPair('Computer', canonicalKey(key.public));
    const machine = await store.machine(pair.hostToken!);
    await store.cancelPairing(pair.pairingId);
    await assert.rejects(store.pairingSubject(pair.pairingId, pair.secret), /unavailable/);
    const next = await store.createPair('Computer', canonicalKey(key.public), machine);
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 6 * 60_000);
    await assert.rejects(store.pairingSubject(next.pairingId, next.secret), /expired/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
