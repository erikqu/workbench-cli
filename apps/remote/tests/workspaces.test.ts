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
    ...['relative', '', '/tmp\n', '/'.repeat(4097)].map(parentDirectory => ({ ...valid, parentDirectory })),
    { ...valid, agent: 'bash -c anything' }, { ...valid, mode: 'overwrite' }, { ...valid, mode: null },
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
    if (args[0] === 'show-options') {
      const name = args[args.indexOf('-t') + 1].slice(1, -1);
      const start = [...calls].reverse().find(call => call[0] === 'new-session' && call[call.indexOf('-s') + 1] === name);
      return /@workbench-remote-launch[^a-f0-9]*([a-f0-9-]{36})/.exec(start?.at(-1) || '')?.[1] || '';
    }
    if (args[0] === 'display-message') return args[3].slice(1, -1) + '|0|';
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
    await assert.rejects(new Workspaces(directory, launch, binary).create({ ...input, requestId: randomUUID(), mode: 'open' }), /still being set up/);
    assert.equal(starts, 2, 'a different open request must not silently complete or duplicate a pending operation');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8')).references, undefined);
    failAgent = false;
    const restored = await new Workspaces(directory, launch, binary).create(input);
    assert.equal(starts, 3, 'already running terminal must not be started twice');
    assert.equal(live.size, 2);
    assert.deepEqual(restored, pending.workspaces[0].layout);
    const agentCall = calls.find(args => args[0] === 'new-session' && args[args.indexOf('-s') + 1].startsWith('workbench_h_'))!;
    assert.ok(agentCall.at(-1)!.includes(quote(quote("/fake/Codex's bin/codex")).slice(1, -1)));
    assert.ok(agentCall.at(-1)!.includes('export PATH='));
    assert.ok(agentCall.at(-1)!.includes('remain-on-exit on'));
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

test('opening an existing folder leaves contents unchanged and durably reuses its sessions', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-open-folder-'));
  const directory = path.join(root, 'state'); await mkdir(directory);
  const folderName = "existing '#{pid}' ", folder = path.join(root, folderName); await mkdir(folder);
  const original = Buffer.from([0, 255, 1, 2, 3]); await writeFile(path.join(folder, 'precious.bin'), original);
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  const input = { ...request(root, folderName), mode: 'open' as const };
  const workspaces = new Workspaces(directory, tmux, async () => '/bin/sh');
  try {
    const opened = await workspaces.create(input);
    assert.equal(opened.cwd, await realpath(folder));
    const session = opened.terminals[0].tmux;
    const pid = await tmux(['display-message', '-p', '-t', '=' + session + ':', '#{pane_pid}']);
    assert.match(pid, /^\d+$/);
    const cwdOutput = path.join(root, 'shell-cwd.txt');
    await tmux(['send-keys', '-t', '=' + session + ':', '-l', 'pwd > ' + quote(cwdOutput)]);
    await tmux(['send-keys', '-t', '=' + session + ':', 'Enter']);
    await until(async () => (await readFile(cwdOutput, 'utf8').catch(() => '')) === opened.cwd + '\n');
    assert.deepEqual(await readdir(folder), ['precious.bin']);
    assert.deepEqual(await readFile(path.join(folder, 'precious.bin')), original);
    assert.deepEqual(await workspaces.create(input), opened);
    const anotherRequest = { ...input, requestId: randomUUID(), agent: 'codex' as const };
    assert.deepEqual(await workspaces.create(anotherRequest), opened, 'opening a known workspace does not launch a second agent');
    const restarted = new Workspaces(directory, tmux, async () => { throw new Error('No executable lookup when reusing a workspace'); });
    assert.deepEqual(await restarted.create(anotherRequest), opened);
    await assert.rejects(restarted.create({ ...anotherRequest, name: 'different' }), /already used/);
    await assert.rejects(restarted.create({ ...input, mode: 'create' }), /already used/);
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + session + ':', '#{pane_pid}']), pid);
    const saved = JSON.parse(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8'));
    assert.equal(saved.workspaces.length, 1); assert.equal(saved.references.length, 1);
    await assert.rejects(workspaces.create({ ...request(root, 'missing'), mode: 'open' }), /no longer exists/);
    await assert.rejects(workspaces.create({ ...request(folder, 'precious.bin'), mode: 'open' }), /not a folder/);
    await assert.rejects(workspaces.create(request(folder, 'precious.bin')), /already exists/);
    assert.deepEqual(await readFile(path.join(folder, 'precious.bin')), original);
  } finally {
    await tmux(['kill-server']).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('opening a live desktop workspace reuses it without editing desktop layout or creating duplicate tabs', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-open-desktop-'));
  const directory = path.join(root, 'state'), folder = path.join(root, 'existing'); await mkdir(directory); await mkdir(folder);
  const socket = path.join(directory, 'tmux-ui.sock'), name = 'workbench_t_existing_desktop';
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  let sessions = new Sessions(directory);
  try {
    await tmux(['new-session', '-d', '-s', name, '-c', folder, '/bin/sh']);
    const pid = await tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']);
    const raw = JSON.stringify({ sessions: [{ id: 'desktop-existing', cwd: folder, terminals: [{ id: 'desktop-tab', name: 'Terminal', tmux: name }] }] }) + '\n';
    await writeFile(path.join(directory, 'workbench-ui-state.json'), raw);
    const input = { ...request(root, 'existing'), mode: 'open' as const };
    const opened = await sessions.createWorkspace(input);
    assert.equal(opened.workspace.id, 'desktop-existing');
    assert.equal(opened.workspace.panes.length, 1); assert.equal(opened.workspace.panes[0].tmux, name);
    sessions.close(); sessions = new Sessions(directory);
    assert.equal((await sessions.createWorkspace(input)).workspace.id, 'desktop-existing');
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']), pid);
    assert.equal(await tmux(['list-sessions', '-F', '#{session_name}']), name);
    assert.equal(await readFile(path.join(directory, 'workbench-ui-state.json'), 'utf8'), raw);
    const saved = JSON.parse(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8'));
    assert.deepEqual(saved.workspaces, []); assert.equal(saved.references.length, 1);
  } finally {
    sessions.close(); await tmux(['kill-server']).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
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
    const stopped = (await sessions.snapshot()).workspaces[0].panes[0];
    assert.equal(stopped.activity, 'idle'); assert.equal(stopped.live, false);
    await tmux(['new-window', '-d', '-t', '=' + session, '-n', 'live-window', '/bin/sh']);
    assert.equal((await sessions.snapshot()).workspaces[0].panes[0].live, true, 'a retained dead window must not hide another live window in the same session');
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
      { ...valid, workspaces: [valid.workspaces[0], valid.workspaces[0]] },
      { ...valid, references: 'invalid' },
      { ...valid, references: [{ request: { ...input, mode: 'open' }, workspaceId: 'duplicate-request', cwd: valid.workspaces[0].layout.cwd }] },
      { ...valid, references: [{ request: { ...input, requestId: randomUUID() }, workspaceId: 'missing-open-mode', cwd: valid.workspaces[0].layout.cwd }] }];
    for (const mutate of [
      (item: any) => { item.ready = 'yes'; },
      (item: any) => { item.request.name = '../escape'; },
      (item: any) => { item.layout.terminals[0].tmux = 'unrelated-user-session'; },
      (item: any) => { item.layout.terminals[0].cwd = '/unrelated'; },
      (item: any) => { item.layout.terminals[0].id = item.layout.id; },
      (item: any) => { item.layout.harnesses = [item.layout.terminals[0]]; },
      (item: any) => { item.request.mode = 'open'; item.layout.cwd = '/'; item.layout.terminals[0].cwd = '/'; },
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

test('agent launch pins PATH, retains early errors, and retries only dead pending identities', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-agent-start-'));
  const directory = path.join(root, 'state'); await mkdir(directory);
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  const shell = path.join(root, 'reset-path-shell'), agent = path.join(root, 'codex');
  // A slow default shell must not consume the agent's startup observation time.
  await writeFile(shell, '#!/bin/sh\nsleep 0.7\nexport PATH=/usr/bin:/bin\nexec /bin/sh "$@"\n', { mode: 0o700 });
  await writeFile(agent, '#!/bin/sh\nprintf "NODE_PATH=%s\\n" "$(command -v node)"\nprintf "\\033[31mSTARTUP_FAILED_FIXTURE\\033[0m\\n" >&2\nexit 17\n', { mode: 0o700 });
  const requestInput = { ...request(root, 'agent-project'), agent: 'codex' as const };
  const workspaces = new Workspaces(directory, tmux, async name => name === 'codex' ? agent : '/bin/sh');
  try {
    await tmux(['new-session', '-d', '-s', 'fixture-bootstrap', '/bin/sh']);
    await tmux(['set-option', '-g', 'default-shell', shell]);
    let failure = '';
    try { await workspaces.create(requestInput); }
    catch (error) { failure = String(error); }
    if (!failure) {
      const records = JSON.parse(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8'));
      const target = '=' + records.workspaces[0].layout.harnesses[0].tmux + ':';
      assert.fail('Missing startup failure; pane=' + await tmux(['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_dead_status}|#{pane_current_command}']) + '\n' + await tmux(['capture-pane', '-p', '-t', target]));
    }
    // The numeric exit status is optional when tmux only reports pane_dead.
    assert.match(failure, /Codex exited during startup(?: \(exit 17\))?\./);
    assert.match(failure, /STARTUP_FAILED_FIXTURE/);
    assert.ok(failure.includes('NODE_PATH=' + path.join(path.dirname(process.execPath), 'node')), 'node must come from the pinned companion path, despite default-shell PATH reset');
    assert.equal(failure.includes('\x1b'), false); assert.ok(failure.length < 3500);
    const pending = JSON.parse(await readFile(path.join(directory, 'remote-workspaces.json'), 'utf8')).workspaces[0];
    assert.equal(pending.ready, false);
    const agentSession = pending.layout.harnesses[0].tmux, terminalSession = pending.layout.terminals[0].tmux;
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + agentSession + ':', '#{pane_dead}']), '1');
    assert.match(await tmux(['capture-pane', '-p', '-t', '=' + agentSession + ':']), /STARTUP_FAILED_FIXTURE/);
    const terminalPid = await tmux(['display-message', '-p', '-t', '=' + terminalSession + ':', '#{pane_pid}']);
    await writeFile(agent, '#!/bin/sh\nprintf "AGENT_ALIVE\\n"\nexec /bin/sh\n', { mode: 0o700 });
    const resumed = await workspaces.create(requestInput);
    assert.deepEqual(resumed, pending.layout);
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + terminalSession + ':', '#{pane_pid}']), terminalPid);
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + agentSession + ':', '#{pane_dead}']), '0');
    await tmux(['send-keys', '-t', '=' + agentSession + ':', '-l', 'exit']);
    await tmux(['send-keys', '-t', '=' + agentSession + ':', 'Enter']);
    await until(async () => (await tmux(['display-message', '-p', '-t', '=' + agentSession + ':', '#{pane_dead}'])) === '1');
    assert.deepEqual(await workspaces.create(requestInput), resumed);
    assert.equal(await tmux(['display-message', '-p', '-t', '=' + agentSession + ':', '#{pane_dead}']), '1', 'ready workspace retries must never restart an agent');
  } finally { await tmux(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('bash initializer preserves user settings while restoring workspace cwd and pinned PATH', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-bash-start-'));
  const directory = path.join(root, 'state'), fixtureHome = path.join(root, 'fixture-home'), elsewhere = path.join(root, 'elsewhere');
  await mkdir(directory); await mkdir(fixtureHome); await mkdir(elsewhere);
  const rc = `unset HISTFILE\nexport PATH=/unusable-path\nexport WORKBENCH_FIXTURE_SETTING=preserved\ncd -- ${quote(elsewhere)}\n`;
  await writeFile(path.join(fixtureHome, '.bashrc'), rc);
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  try {
    const workspace = await new Workspaces(directory, tmux, async () => '/bin/bash', undefined, fixtureHome).create(request(root, "selected 'folder'"));
    const output = path.join(root, 'bash-environment.txt'), session = workspace.terminals[0].tmux;
    await tmux(['send-keys', '-t', '=' + session + ':', '-l', 'printf "%s\\n" "$PWD" "$(command -v node)" "$WORKBENCH_FIXTURE_SETTING" "$PATH" > ' + quote(output)]);
    await tmux(['send-keys', '-t', '=' + session + ':', 'Enter']);
    const expected = [workspace.cwd, path.join(path.dirname(process.execPath), 'node'), 'preserved', ''].join('\n');
    await until(async () => (await readFile(output, 'utf8').catch(() => '')).startsWith(expected));
    assert.ok((await readFile(output, 'utf8')).split('\n')[3].startsWith(path.dirname(process.execPath) + ':/unusable-path:'), 'only the bundled runtime precedes user PATH; fallback system paths must not override custom toolchains');
    assert.equal(await readFile(path.join(fixtureHome, '.bashrc'), 'utf8'), rc);
    const initializer = (await readdir(directory)).find(name => name.startsWith('remote-bash-'))!;
    assert.ok(initializer);
    assert.equal((await stat(path.join(directory, initializer))).mode & 0o777, 0o600);
  } finally { await tmux(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for workspace output');
}
