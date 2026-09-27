import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'ssh2';
import { Remote } from '../src/remote';
import { DEFAULT_PROFILE, type RemoteEvent } from '../src/shared';

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const layout = JSON.stringify({ sessions: [{ id: 'a', cwd: '/project', harnesses: [{ tmux: 'workbench_h_test', name: 'Test agent' }] }] });

test('real SSH transport: backup discovery, PTY input, UTF-8 output, resize, detach and reconnect', async () => {
  const commands: string[] = [];
  let pty = false;
  let resized = false;
  let detached = false;
  const clients = new Set<any>();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'test' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (accept, _reject, info) => { pty = info.cols === 100 && info.rows === 30; accept?.(); });
      session.on('window-change', (accept, _reject, info) => { resized = info.cols === 120 && info.rows === 40; accept?.(); });
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command);
        const stream = accept();
        if (info.command.includes('attach-session')) {
          stream.write('ready λ\r\n');
          stream.on('data', (data: Buffer) => stream.write(data));
          stream.on('close', () => { detached = true; });
        } else {
          if (info.command.includes('list-sessions')) stream.write('workbench_h_test\n');
          else if (info.command.includes('.bak')) stream.write(layout);
          else stream.write('{broken');
          stream.exit(0); stream.end();
        }
      });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const verified: string[] = [];
  const remote = new Remote(async (_host, fingerprint) => { verified.push(fingerprint); return true; });
  const profile = { ...DEFAULT_PROFILE, host: '127.0.0.1', port, auth: 'password' as const };
  try {
    const snapshot = await remote.connect(profile, { password: 'test' });
    assert.match(snapshot.warning!, /backup/);
    assert.equal(snapshot.workspaces[0].panes[0].live, true);
    assert.match(verified[0], /^SHA256:/);
    await assert.rejects(remote.attach('workbench_h_other', 'workbench_h_other', 100, 30), /no longer running/);
    let output = '';
    remote.on('event', (event: RemoteEvent) => { if (event.type === 'data') { output += Buffer.from(event.data).toString(); remote.ack(event.id, event.data.length); } });
    await remote.attach('workbench_h_test', 'workbench_h_test', 100, 30);
    await waitFor(() => output.includes('ready λ'));
    assert.equal(pty, true);
    remote.input('workbench_h_test', 'hello\r');
    remote.resize('workbench_h_test', 120, 40);
    await waitFor(() => resized && output.includes('hello'));
    remote.detach('workbench_h_test');
    await waitFor(() => detached);
    remote.disconnect();
    const reconnected = await remote.connect(profile, { password: 'test' });
    assert.equal(reconnected.workspaces[0].panes[0].live, true);
    assert.ok(commands.every(command => !/kill-session|kill-server|new-session/.test(command)));
  } finally { remote.disconnect(); for (const client of clients) client.end(); server.close(); }
});

test('rejects an untrusted SSH host before sending credentials', async () => {
  let authenticationAttempted = false;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => { authenticationAttempted = true; ctx.reject(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const remote = new Remote(async () => false);
  try {
    await assert.rejects(remote.connect({ ...DEFAULT_PROFILE, host: '127.0.0.1', port: (server.address() as { port: number }).port, auth: 'password' }, { password: 'secret' }), /Host denied/);
    assert.equal(authenticationAttempted, false);
  } finally { remote.disconnect(); server.close(); }
});
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for SSH event');
}
