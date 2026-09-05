import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Client, utils, type ClientChannel } from 'ssh2';
import { WebSocket, createWebSocketStream } from 'ws';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { Store } from '../../services/relay/store';
import { createRelay } from '../../services/relay/server';
import { Companion } from '../../services/host/companion';
import { canonicalKey, generateIdentity, hash, PROTOCOL, type HostConfiguration } from '../../services/shared/protocol';

test('public relay: two accounts, pairing, encrypted SSH, real tmux, leases, geometry, reconnect and revocation', { timeout: 60_000 }, async () => {
  assert.ok(process.env.WORKBENCH_TEST_DATABASE_URL, 'Run through scripts/test-platform.mjs or set WORKBENCH_TEST_DATABASE_URL to an isolated database');
  const pool = new Pool({ connectionString: process.env.WORKBENCH_TEST_DATABASE_URL });
  const schema = 'test_' + Date.now();
  await pool.query(`CREATE SCHEMA ${schema}`); await pool.end();
  const isolated = new Pool({ connectionString: process.env.WORKBENCH_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const store = new Store(isolated); await store.migrate();
  const relay = createRelay({ store, appleAudience: 'dev.workbench.remote', localPairingAuth: true, identityVerifier: async (identity, expected) => {
    const [subject, nonce] = identity.split(':'); if (nonce !== expected) throw new Error('Bad nonce'); return subject;
  } });
  await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-remote-test-'));
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = (args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
  const session = 'workbench_h_fixture';
  tmux(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', '/bin/sh']);
  tmux(['set-option', '-g', 'status', 'off']);
  const originalPid = tmux(['display-message', '-p', '-t', session, '#{pane_pid}']);
  await writeFile(path.join(directory, 'workbench-ui-state.json'), JSON.stringify({ sessions: [{ id: 'fixture', cwd: directory, harnesses: [{ tmux: session, name: 'Fixture' }] }] }));
  let companion: Companion | undefined, local: pty.IPty | undefined;
  const clients: Client[] = [];
  async function api(route: string, method = 'GET', body?: unknown, credential?: string, expected = 200) {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`); return data;
  }
  async function login(subject: string, keys: ReturnType<typeof utils.generateKeyPairSync>) {
    const challenge = await api('/v1/auth/challenge', 'POST', {});
    return api('/v1/auth/apple', 'POST', { challengeId: challenge.challengeId, identityToken: `${subject}:${hash(challenge.nonce)}`, publicKey: keys.public, name: 'Test phone' });
  }
  try {
    const hostKey = generateIdentity(), key1 = generateIdentity(), key2 = generateIdentity();
    const user1 = await login('user-one', key1), user2 = await login('user-one', key2), stranger = await login('user-two', generateIdentity());
    const pair = await api('/v1/pairings', 'POST', { name: 'Test host', hostKey: hostKey.public });
    const machineId = pair.machineId;
    await api(`/v1/pairings/${pair.pairingId}/claim`, 'POST', { secret: pair.secret }, user1.accessToken);
    await api(`/v1/pairings/${pair.pairingId}/claim`, 'POST', { secret: pair.secret }, user1.accessToken, 409);
    await api(`/v1/pairings/${pair.pairingId}/confirm`, 'POST', { deviceId: user1.deviceId, publicKey: key2.public }, pair.hostToken, 409);
    await api(`/v1/pairings/${pair.pairingId}/confirm`, 'POST', { deviceId: user1.deviceId, publicKey: key1.public }, pair.hostToken);
    const secondPair = await api('/v1/pairings', 'POST', { name: 'Test host', hostKey: hostKey.public }, pair.hostToken);
    await api(`/v1/pairings/${secondPair.pairingId}/claim`, 'POST', { secret: secondPair.secret }, stranger.accessToken, 403);
    await api(`/v1/pairings/${secondPair.pairingId}/claim`, 'POST', { secret: secondPair.secret }, user2.accessToken);
    await api(`/v1/pairings/${secondPair.pairingId}/confirm`, 'POST', { deviceId: user2.deviceId, publicKey: key2.public }, pair.hostToken);
    assert.deepEqual((await api('/v1/machines', 'GET', undefined, stranger.accessToken)).machines, []);
    const config: HostConfiguration = { relay: origin, directory, machineId, hostToken: pair.hostToken, hostKey: canonicalKey(hostKey.public), privateKey: hostKey.private,
      approvedKeys: { [user1.deviceId]: canonicalKey(key1.public), [user2.deviceId]: canonicalKey(key2.public) } };
    companion = new Companion(config, () => {}); companion.start();
    await until(async () => (await api('/v1/machines', 'GET', undefined, user1.accessToken)).machines[0].online);
    if (process.env.WORKBENCH_SWIFT_CHECK_ARGS) {
      const command: string[] = JSON.parse(process.env.WORKBENCH_SWIFT_CHECK_ARGS);
      const parsed = utils.parseKey(key1.private) as any;
      const seed = createPrivateKey(parsed.getPrivatePEM()).export({ type: 'pkcs8', format: 'der' }).subarray(-32);
      const fixture = path.resolve('apple/.transport-fixture.json');
      await writeFile(fixture, JSON.stringify({ relay: origin, machineId, hostKey: canonicalKey(hostKey.public), login: user1, privateKey: seed.toString('base64'), sessionId: session }), { mode: 0o600 });
      try {
        const { stdout } = await promisify(execFile)(command[0], [...command.slice(1), process.env.WORKBENCH_SWIFT_FIXTURE || fixture], { timeout: 25_000 });
        assert.match(stdout, /EVENT snapshot/);
        assert.match(stdout, /OUTPUT/);
        assert.match(tmux(['capture-pane', '-p', '-t', session]), /^SWIFT_TRANSPORT_OK$/m);
      } finally { await rm(fixture, { force: true }); }
    }
    async function ssh(user: typeof user1, key: typeof key1) {
      const client = new Client(); clients.push(client);
      const ws = new WebSocket(origin.replace('http:', 'ws:') + `/v1/tunnel/${machineId}`, { headers: { Authorization: 'Bearer ' + user.accessToken } });
      const stream = createWebSocketStream(ws); stream.on('error', () => {});
      ws.on('close', () => stream.destroy());
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve).once('error', reject);
        client.connect({ sock: stream, username: user.deviceId, privateKey: key.private, hostVerifier: (actual: Buffer) => actual.equals((utils.parseKey(hostKey.public) as any).getPublicSSH()), readyTimeout: 10_000 });
      });
      const events: any[] = [];
      const control = await new Promise<ClientChannel>((resolve, reject) => client.subsys(PROTOCOL, (err, channel) => err ? reject(err) : resolve(channel)));
      let pending = '';
      control.on('data', (data: Buffer) => { pending += data.toString(); let index: number; while ((index = pending.indexOf('\n')) >= 0) { events.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1); } });
      control.write(JSON.stringify({ id: 'watch', method: 'watch' }) + '\n');
      await until(() => events.some(event => event.type === 'snapshot'));
      return { client, control, events };
    }
    const first = await ssh(user1, key1);
    await assert.rejects(new Promise((resolve, reject) => first.client.exec('echo unauthorized', (err, channel) => err ? reject(err) : resolve(channel))), /Unable to exec/);
    async function attach(client: Client) {
      const stream = await new Promise<ClientChannel>((resolve, reject) => client.exec(`workbench-attach:${session}`, { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, (err, channel) => err ? reject(err) : resolve(channel)));
      let output = ''; stream.on('data', (data: Buffer) => { output += data.toString(); });
      stream.on('error', () => {});
      return { stream, output: () => output };
    }
    const one = await attach(first.client);
    await until(() => first.events.some(e => e.type === 'sessionState' && e.writable));
    one.stream.write("printf '\\nREMOTE_E2E_OK\\n'\r");
    await until(() => one.output().includes('REMOTE_E2E_OK'));
    const second = await ssh(user2, key2), two = await attach(second.client);
    await until(() => second.events.some(e => e.type === 'sessionState' && !e.writable));
    second.control.write(JSON.stringify({ id: 'take', method: 'takeControl', sessionId: session }) + '\n');
    await until(() => second.events.some(e => e.type === 'sessionState' && e.writable));
    await until(() => first.events.filter(e => e.type === 'sessionState').at(-1)?.writable === false);
    two.stream.write("printf '\\nSECOND_DEVICE_OK\\n'\r");
    await until(() => two.output().includes('SECOND_DEVICE_OK'));
    local = pty.spawn('tmux', ['-S', socket, 'attach-session', '-t', '=' + session], { name: 'xterm-256color', cols: 110, rows: 33, env: { ...process.env, TMUX: '' } });
    local.onData(() => {});
    await until(() => second.events.filter(e => e.type === 'sessionState').at(-1)?.localAttached === true);
    two.stream.setWindow(20, 60, 0, 0);
    await until(() => tmux(['display-message', '-p', '-t', session, '#{window_width}']) === '110');
    second.control.write(JSON.stringify({ id: 'phone', method: 'setPhoneLayout', sessionId: session, enabled: true }) + '\n');
    await until(() => second.events.filter(e => e.type === 'sessionState').at(-1)?.phoneLayout === true);
    await until(() => tmux(['display-message', '-p', '-t', session, '#{window_width}']) === '60');
    second.control.write(JSON.stringify({ id: 'desktop', method: 'setPhoneLayout', sessionId: session, enabled: false }) + '\n');
    await until(() => tmux(['display-message', '-p', '-t', session, '#{window_width}']) === '110');
    local.kill(); local = undefined;
    await until(() => second.events.filter(e => e.type === 'sessionState').at(-1)?.localAttached === false);
    first.client.end();
    assert.equal(tmux(['display-message', '-p', '-t', session, '#{pane_pid}']), originalPid);
    const reopened = await ssh(user1, key1); await attach(reopened.client);
    let revoked = false; second.client.once('close', () => { revoked = true; });
    await api(`/v1/machines/${machineId}/devices/${user2.deviceId}`, 'DELETE', undefined, user1.accessToken);
    await until(() => revoked);
    assert.equal(tmux(['display-message', '-p', '-t', session, '#{pane_pid}']), originalPid);
    const expired = await api('/v1/pairings', 'POST', { name: 'Test host', hostKey: hostKey.public }, pair.hostToken);
    await isolated.query('UPDATE pairings SET expires_at=0 WHERE id=$1', [expired.pairingId]);
    await api(`/v1/pairings/${expired.pairingId}/claim`, 'POST', { secret: expired.secret }, user1.accessToken, 404);
    const localHost = generateIdentity(), localKey = generateIdentity();
    const localPair = await api('/v1/pairings', 'POST', { name: 'Local host', hostKey: localHost.public });
    await api('/v1/auth/pairing', 'POST', { pairingId: localPair.pairingId, secret: 'wrong-secret', publicKey: localKey.public, name: 'Local phone' }, undefined, 404);
    const localUser = await api('/v1/auth/pairing', 'POST', { pairingId: localPair.pairingId, secret: localPair.secret, publicKey: localKey.public, name: 'Local phone' });
    await api(`/v1/pairings/${localPair.pairingId}/claim`, 'POST', { secret: localPair.secret }, localUser.accessToken);
    await api(`/v1/pairings/${localPair.pairingId}/confirm`, 'POST', { deviceId: localUser.deviceId, publicKey: localKey.public }, localPair.hostToken);
    assert.equal((await api('/v1/machines', 'GET', undefined, localUser.accessToken)).machines[0].name, 'Local host');
  } finally {
    local?.kill(); for (const client of clients) client.end(); companion?.close();
    await relay.close();
    try { tmux(['kill-server']); } catch {}
    await rm(directory, { recursive: true, force: true });
    await isolated.query(`DROP SCHEMA ${schema} CASCADE`); await isolated.end();
  }
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error('Timed out waiting for integration condition');
}
