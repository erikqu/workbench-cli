import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Workspaces, validateWorkspaceRequest, type NewWorkspace } from '../services/host/workspaces';
import { Sessions } from '../services/host/sessions';
import { quote } from '../src/discovery';

const run = promisify(execFile);
const request = (parentDirectory: string, name = 'New project'): NewWorkspace => ({ requestId: randomUUID(), name, parentDirectory, agent: 'terminal' });

test('workspace requests reject malformed identifiers, traversal, control characters and unknown launch modes', () => {
  const valid = request('/tmp');
  for (const input of [
    null, {}, { ...valid, requestId: '-'.repeat(36) }, { ...valid, requestId: 'x'.repeat(36) },
    ...['', ' ', '.', '..', '../outside', 'nested/folder', 'nested\\folder', 'bad\nname', 'bad\0name', 'x'.repeat(81)].map(name => ({ ...valid, name })),
    ...['relative', '', '/tmp\n', '/'.repeat(2049)].map(parentDirectory => ({ ...valid, parentDirectory })),
    { ...valid, agent: 'bash -c anything' },
  ]) assert.throws(() => validateWorkspaceRequest(input as NewWorkspace), Error, JSON.stringify(input));
  assert.deepEqual(validateWorkspaceRequest({ ...valid, requestId: valid.requestId.toUpperCase(), name: '  My project  ', parentDirectory: ' /tmp ' }), { ...valid, name: 'My project' });
});

test('new workspace starts a real persistent terminal in its exclusive folder without altering desktop state', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-workspaces-'));
  const directory = path.join(root, 'state'), parent = path.join(root, 'projects');
  await mkdir(directory); await mkdir(parent);
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  const desktop = '{"sessions":[],"desktopPreferences":{"keep":"exact bytes"}}\n';
  await writeFile(path.join(directory, 'workbench-ui-state.json'), desktop);
  let sessions: Sessions | undefined;
  try {
    const workspaces = new Workspaces(directory, tmux);
    // Quotes, spaces and metacharacters are folder characters, never commands.
    const input = request(parent, "project '#{pid}'; literal");
    const [created, duplicate] = await Promise.all([workspaces.create(input), workspaces.create(input)]);
    assert.deepEqual(duplicate, created);
    assert.equal(created.cwd, path.join(await realpath(parent), input.name));
    assert.equal((await stat(created.cwd)).isDirectory(), true);
    assert.equal(created.harnesses.length, 0);
    assert.equal(created.terminals.length, 1);
    const session = created.terminals[0].tmux;
    assert.match(session, /^workbench_t_[a-f0-9]{32}$/);
    const pid = await tmux(['display-message', '-p', '-t', '=' + session + ':', '#{pane_pid}']);
    assert.match(pid, /^\d+$/);
    // The shell itself proves its starting directory, writing only to the known
    // temporary test directory even if launching in the requested cwd regresses.
    const cwdOutput = path.join(root, 'shell-cwd.txt');
    await tmux(['send-keys', '-t', '=' + session + ':', '-l', 'pwd > ' + quote(cwdOutput)]);
    await tmux(['send-keys', '-t', '=' + session + ':', 'Enter']);
    await until(async () => (await readFile(cwdOutput, 'utf8').catch(() => '')) === created.cwd + '\n');
    assert.deepEqual(await readdir(parent), [input.name]);
    assert.deepEqual(await new Workspaces(directory, tmux).create(input), created, 'restart retry reuses the same identities');
    sessions = new Sessions(directory);
    const snapshot = await sessions.snapshot();
    assert.equal(snapshot.workspaces.find(workspace => workspace.id === created.id)?.panes[0].live, true);
    sessions.close(); sessions = new Sessions(directory);
    assert.equal((await sessions.snapshot()).workspaces.find(workspace => workspace.id === created.id)?.panes[0].live, true);
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + session + ':', '#{pane_pid}']), pid, 'companion close/restart must not kill or restart the shell');
    assert.equal(await readFile(path.join(directory, 'workbench-ui-state.json'), 'utf8'), desktop);
    assert.equal((await stat(path.join(directory, 'remote-workspaces.json'))).mode & 0o777, 0o600);
    assert.equal((await workspaces.layouts()).length, 1);
    await assert.rejects(workspaces.create({ ...input, name: 'Different project' }), /already used/);
    await assert.rejects(workspaces.create({ ...input, requestId: randomUUID() }), /already exists/);
    assert.deepEqual(await readdir(parent), [input.name]);
  } finally {
    sessions?.close();
    await tmux(['kill-server']).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('partial startup retries resume saved sessions and refuse replaced folders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-workspace-retry-'));
  const directory = path.join(root, 'state');
  const input = { ...request(root), agent: 'codex' as const };
  const live = new Set<string>(); let starts = 0, failAgent = true;
  const calls: string[][] = [];
  const launch = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'has-session') { if (!live.has(args[2].slice(1))) throw new Error('missing'); return ''; }
    if (args[0] === 'new-session') {
      starts++;
      const name = args[args.indexOf('-s') + 1];
      if (name.startsWith('workbench_h_') && failAgent) throw new Error('simulated interrupted startup');
      live.add(name); return '';
    }
    throw new Error('Unexpected command');
  };
  const binary = async (name: string) => name === 'codex' ? "/fake/Codex's bin/codex" : '/bin/sh';
  try {
    await assert.rejects(new Workspaces(directory, launch, binary).create(input), /Retry with the same/);
    const pending = JSON.parse(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8'));
    assert.equal(pending.workspaces[0].ready, false);
    assert.equal(live.size, 1);
    failAgent = false;
    const restored = await new Workspaces(directory, launch, binary).create(input);
    assert.equal(starts, 3, 'already running terminal must not be started twice');
    assert.equal(live.size, 2);
    assert.deepEqual(restored, pending.workspaces[0].layout);
    const agentCall = calls.find(args => args[0] === 'new-session' && args[args.indexOf('-s') + 1].startsWith('workbench_h_'))!;
    assert.equal(agentCall.at(-1), "'/fake/Codex'\\''s bin/codex'");
    assert.equal(agentCall.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.equal(agentCall[agentCall.indexOf('-c') + 1], restored.cwd);
    // Simulate a pending record surviving a process crash, followed by the user
    // replacing its directory with a symlink. No retry may start in that link.
    await writeFile(path.join(directory, 'remote-workspaces.json'), JSON.stringify(pending));
    await rename(restored.cwd, restored.cwd + '-original');
    const unrelated = path.join(root, 'unrelated'); await mkdir(unrelated);
    await symlink(unrelated, restored.cwd);
    const before = calls.length;
    await assert.rejects(new Workspaces(directory, launch, binary).create(input), /moved, removed, or replaced/);
    assert.equal(calls.length, before);
    assert.deepEqual(await readdir(unrelated), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot stops agent activity when a retained tmux pane dies', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-dead-agent-'));
  const socket = path.join(directory, 'tmux-ui.sock'), session = 'workbench_h_activity_test';
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  const sessions = new Sessions(directory);
  try {
    await tmux(['new-session', '-d', '-s', session, '/bin/sh']);
    await tmux(['set-option', '-w', '-t', '=' + session + ':', 'remain-on-exit', 'on']);
    await writeFile(path.join(directory, 'workbench-ui-state.json'), JSON.stringify({ sessions: [{ id: 'activity', cwd: directory,
      harnesses: [{ id: 'agent', name: 'Codex', harnessId: 'codex', tmux: session }] }] }));
    await tmux(['send-keys', '-t', '=' + session + ':', '-l', "printf '\\nWorking (1s, esc to interrupt)\\n'"]);
    await tmux(['send-keys', '-t', '=' + session + ':', 'Enter']);
    await until(async () => (await sessions.snapshot()).workspaces[0].panes[0].activity === 'working');
    await tmux(['send-keys', '-t', '=' + session + ':', '-l', 'exit']);
    await tmux(['send-keys', '-t', '=' + session + ':', 'Enter']);
    await until(async () => (await tmux(['display-message', '-p', '-t', '=' + session + ':', '#{pane_dead}'])) === '1');
    assert.match(await tmux(['capture-pane', '-p', '-t', '=' + session + ':']), /^Working \(1s, esc to interrupt\)$/m);
    assert.equal((await sessions.snapshot()).workspaces[0].panes[0].activity, 'idle');
  } finally {
    sessions.close(); await tmux(['kill-server']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing executables, existing folders and invalid registries never overwrite data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-workspace-errors-'));
  const directory = path.join(root, 'state'); await mkdir(directory);
  const input = request(root);
  let calls = 0;
  const tmux = async () => { calls++; throw new Error('must not start'); };
  try {
    await assert.rejects(new Workspaces(directory, tmux, async () => undefined).create({ ...input, agent: 'codex' }), /Codex is not installed/);
    assert.deepEqual(await readdir(root), ['state'], 'check binary availability before creating any folder');
    await mkdir(path.join(root, input.name));
    await writeFile(path.join(root, input.name, 'precious.txt'), 'unchanged');
    await assert.rejects(new Workspaces(directory, tmux).create(input), /already exists/);
    assert.equal(await readFile(path.join(root, input.name, 'precious.txt'), 'utf8'), 'unchanged');
    const valid = { version: 1, workspaces: [{ request: input, ready: false, layout: { id: randomUUID(), cwd: path.join(root, input.name), harnesses: [], terminals: [
      { id: randomUUID(), name: 'Terminal 1', cwd: path.join(root, input.name), tmux: 'workbench_t_' + randomUUID().replaceAll('-', '') }
    ] } }] };
    const copies = [null, {}, { version: 2, workspaces: [] }, { ...valid, workspaces: Array(1001).fill(valid.workspaces[0]) },
      { ...valid, workspaces: [valid.workspaces[0], valid.workspaces[0]] }];
    for (const mutate of [
      (item: any) => { item.ready = 'yes'; },
      (item: any) => { item.request.name = '../escape'; },
      (item: any) => { item.layout.terminals[0].tmux = 'unrelated-user-session'; },
      (item: any) => { item.layout.terminals[0].cwd = '/unrelated'; },
      (item: any) => { item.layout.terminals[0].id = item.layout.id; },
      (item: any) => { item.layout.harnesses = [item.layout.terminals[0]]; },
    ]) { const copy = structuredClone(valid); mutate(copy.workspaces[0]); copies.push(copy); }
    for (const value of copies) {
      const raw = JSON.stringify(value);
      await writeFile(path.join(directory, 'remote-workspaces.json'), raw);
      await assert.rejects(new Workspaces(directory, tmux).create(input), /file was left unchanged/);
      assert.equal(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8'), raw);
    }
    assert.equal(calls, 0);
    assert.equal(await readFile(path.join(root, input.name, 'precious.txt'), 'utf8'), 'unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for workspace output');
}
