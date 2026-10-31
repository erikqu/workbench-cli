import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Sessions } from '../services/host/sessions';
import { Workspaces, validateStartRequest } from '../services/host/workspaces';

const run = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-start-test-'));
  const directory = path.join(root, 'state'); await mkdir(directory);
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  return { root, directory, tmux, async close() { await tmux(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

test('folder-only workspaces contain no panes and never inspect or start executables', async () => {
  const f = await fixture();
  try {
    const never = async () => { throw new Error('must not execute'); };
    const workspaces = new Workspaces(f.directory, never, never);
    const request = { requestId: randomUUID(), name: 'Folder only', parentDirectory: f.root, agent: 'none' as const };
    const created = await workspaces.create(request);
    assert.deepEqual(created.harnesses, []); assert.deepEqual(created.terminals, []);
    assert.deepEqual(await readdir(created.cwd), []);
    assert.deepEqual(await new Workspaces(f.directory, never, never).create(request), created);
    assert.deepEqual(await workspaces.create({ ...request, requestId: randomUUID(), mode: 'open' }), created);
    await assert.rejects(workspaces.create({ ...request, requestId: randomUUID() }), /already exists/);
    for (const input of [null, {}, { requestId: 'bad', workspaceId: created.id, agent: 'terminal' },
      { requestId: randomUUID(), workspaceId: '__unlisted', agent: 'terminal' },
      { requestId: randomUUID(), workspaceId: created.id, agent: 'none' },
      { requestId: randomUUID(), workspaceId: created.id, agent: 'bash -c anything' }]) {
      assert.throws(() => validateStartRequest(input as any));
    }
  } finally { await f.close(); }
});

test('explicit starts are fresh, durable, and never resurrect deleted tabs on retry', { timeout: 15_000 }, async () => {
  const f = await fixture(); let sessions = new Sessions(f.directory);
  try {
    const creation = { requestId: randomUUID(), name: 'Start project', parentDirectory: f.root, agent: 'none' as const };
    const { workspace } = await sessions.createWorkspace(creation);
    assert.equal((await sessions.snapshot()).warning, 'No sessions are running. Start a session from a workspace.');
    await writeFile(path.join(workspace.cwd, 'keep.txt'), 'UNCHANGED\n');
    const request = { requestId: randomUUID(), workspaceId: workspace.id, agent: 'terminal' as const };
    const [first, duplicate] = await Promise.all([sessions.startSession(request), sessions.startSession(request)]);
    assert.equal(duplicate.sessionId, first.sessionId);
    assert.equal(first.snapshot.workspaces.find(item => item.id === workspace.id)?.panes.length, 1);
    const firstPid = await f.tmux(['display-message', '-p', '-t', '=' + first.sessionId + ':', '#{pane_pid}']);
    sessions.close(); sessions = new Sessions(f.directory);
    assert.equal((await sessions.startSession(request)).sessionId, first.sessionId);
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + first.sessionId + ':', '#{pane_pid}']), firstPid);
    const secondRequest = { ...request, requestId: randomUUID() }, second = await sessions.startSession(secondRequest);
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.snapshot.workspaces.find(item => item.id === workspace.id)?.panes.length, 2);
    await assert.rejects(sessions.startSession({ ...request, agent: 'codex' }), /already used/);
    await sessions.deleteSession({ requestId: randomUUID(), workspaceId: workspace.id, sessionId: first.sessionId });
    await sessions.deleteSession({ requestId: randomUUID(), workspaceId: workspace.id, sessionId: second.sessionId });
    const oldRetry = await sessions.startSession(request);
    assert.equal(oldRetry.sessionId, first.sessionId);
    assert.deepEqual(oldRetry.snapshot.workspaces.find(item => item.id === workspace.id)?.panes, []);
    await assert.rejects(f.tmux(['has-session', '-t', '=' + first.sessionId]));
    const third = await sessions.startSession({ ...request, requestId: randomUUID() });
    assert.notEqual(third.sessionId, first.sessionId); assert.notEqual(third.sessionId, second.sessionId);
    assert.equal(third.snapshot.workspaces.find(item => item.id === workspace.id)?.panes.length, 1);
    assert.equal((await sessions.createWorkspace(creation)).workspace.panes[0].tmux, third.sessionId);
    assert.equal((await sessions.listFiles(workspace.id, '')).entries[0].name, 'keep.txt');
    assert.equal(await readFile(path.join(workspace.cwd, 'keep.txt'), 'utf8'), 'UNCHANGED\n');
  } finally { sessions.close(); await f.close(); }
});

test('desktop starts overlay new tabs without altering desktop files or restarting stopped tabs', { timeout: 12_000 }, async () => {
  const f = await fixture(); const sessions = new Sessions(f.directory);
  try {
    const folder = path.join(f.root, 'desktop'); await mkdir(folder);
    const stopped = 'workbench_h_saved_stopped';
    const raw = JSON.stringify({ sessions: [{ id: 'desktop', cwd: folder, harnesses: [{ tmux: stopped, harnessId: 'codex', name: 'Saved agent' }] }] }) + '\n';
    await writeFile(path.join(f.directory, 'workbench-ui-state.json'), raw);
    const request = { requestId: randomUUID(), workspaceId: 'desktop', agent: 'terminal' as const };
    const started = await sessions.startSession(request);
    assert.equal(started.snapshot.workspaces.length, 1);
    const panes = started.snapshot.workspaces[0].panes;
    assert.equal(panes.length, 2); assert.equal(panes.find(pane => pane.tmux === stopped)?.live, false);
    assert.equal(panes.find(pane => pane.tmux === started.sessionId)?.live, true);
    await assert.rejects(f.tmux(['has-session', '-t', '=' + stopped]));
    assert.equal(await readFile(path.join(f.directory, 'workbench-ui-state.json'), 'utf8'), raw);
    await sessions.deleteSession({ requestId: randomUUID(), workspaceId: 'desktop', sessionId: stopped });
    await sessions.deleteSession({ requestId: randomUUID(), workspaceId: 'desktop', sessionId: started.sessionId });
    const fresh = await sessions.startSession({ ...request, requestId: randomUUID() });
    assert.equal(fresh.snapshot.workspaces[0].panes.length, 1);
    assert.equal(fresh.snapshot.workspaces[0].panes[0].tmux, fresh.sessionId);
    assert.equal(await readFile(path.join(f.directory, 'workbench-ui-state.json'), 'utf8'), raw);
    await assert.rejects(sessions.startSession({ ...request, requestId: randomUUID(), workspaceId: 'unknown' }), /existing workspace/);
    const emptyFolder = path.join(f.root, 'Empty desktop'); await mkdir(emptyFolder);
    const emptyRaw = JSON.stringify({ sessions: [{ id: 'empty-desktop', cwd: emptyFolder, harnesses: [], terminals: [] }] }) + '\n';
    await writeFile(path.join(f.directory, 'workbench-ui-state.json'), emptyRaw);
    const emptyStart = await sessions.startSession({ ...request, requestId: randomUUID(), workspaceId: 'empty-desktop' });
    const reopened = await sessions.createWorkspace({ requestId: randomUUID(), name: 'Empty desktop', parentDirectory: f.root, mode: 'open', agent: 'none' });
    assert.equal(reopened.workspace.id, 'empty-desktop', 'reopening a desktop-only overlay must not create a duplicate workspace');
    assert.equal(reopened.workspace.panes[0].tmux, emptyStart.sessionId);
    assert.equal(await readFile(path.join(f.directory, 'workbench-ui-state.json'), 'utf8'), emptyRaw);
  } finally { sessions.close(); await f.close(); }
});

test('Claude and Codex starts preserve launch safeguards; early failures never respawn on retry', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const executable = path.join(f.root, 'fixture-agent');
    await writeFile(executable, '#!/bin/sh\nprintf "\\033[31mEARLY_START_ERROR\\033[0m\\n" >&2\nexit 23\n', { mode: 0o700 });
    const workspaces = new Workspaces(f.directory, f.tmux, async name => name === 'claude' || name === 'codex' ? executable : '/bin/sh');
    const workspace = await workspaces.create({ requestId: randomUUID(), name: 'Agent starts', parentDirectory: f.root, agent: 'none' });
    const request = { requestId: randomUUID(), workspaceId: workspace.id, agent: 'claude' as const };
    await assert.rejects(workspaces.start(request), error => {
      assert.match(String(error), /Claude exited during startup \(exit 23\)/);
      assert.match(String(error), /EARLY_START_ERROR/); assert.match(String(error), /use Start again/);
      assert.equal(String(error).includes('\x1b'), false); return true;
    });
    const registry = JSON.parse(await readFile(path.join(f.directory, 'remote-workspaces.json'), 'utf8'));
    const failed = registry.starts[0].tab.tmux;
    assert.equal(registry.starts[0].attempted, true); assert.equal(registry.starts[0].ready, false);
    const failedPid = await f.tmux(['display-message', '-p', '-t', '=' + failed + ':', '#{pane_pid}']);
    await writeFile(executable, '#!/bin/sh\nprintf "RUNNING:%s:NODE:%s\\n" "$PWD" "$(command -v node)"\nexec /bin/sh\n', { mode: 0o700 });
    await assert.rejects(workspaces.start(request), /EARLY_START_ERROR/);
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + failed + ':', '#{pane_pid}']), failedPid);
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + failed + ':', '#{pane_dead}']), '1');
    const fresh = await workspaces.start({ ...request, requestId: randomUUID() });
    assert.notEqual(fresh, failed);
    const output = await f.tmux(['capture-pane', '-p', '-t', '=' + fresh + ':']);
    assert.ok(output.replaceAll('\n', '').includes('RUNNING:' + workspace.cwd));
    assert.ok(output.replaceAll('\n', '').includes('NODE:' + path.join(path.dirname(process.execPath), 'node')));
    const codex = await workspaces.start({ ...request, requestId: randomUUID(), agent: 'codex' });
    assert.notEqual(codex, fresh);
    const claudeWorkspace = await workspaces.create({ requestId: randomUUID(), name: 'Claude project', parentDirectory: f.root, agent: 'claude' });
    assert.equal(claudeWorkspace.harnesses.length, 1); assert.equal(claudeWorkspace.harnesses[0].harnessId, 'claude');
    assert.equal(claudeWorkspace.terminals.length, 1);
    assert.equal((await new Workspaces(f.directory, f.tmux).layouts()).length, 2);
    const beforeMissing = await readFile(path.join(f.directory, 'remote-workspaces.json'), 'utf8');
    await assert.rejects(new Workspaces(f.directory, f.tmux, async () => undefined).start({ ...request, requestId: randomUUID() }), /Claude is not installed/);
    assert.equal(await readFile(path.join(f.directory, 'remote-workspaces.json'), 'utf8'), beforeMissing);
  } finally { await f.close(); }
});

test('uncertain launch retries bind the attempted identity without duplicating or restarting processes', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const original = new Workspaces(f.directory, f.tmux, async () => '/bin/sh');
    const workspace = await original.create({ requestId: randomUUID(), name: 'Uncertain starts', parentDirectory: f.root, agent: 'none' });
    const request = { requestId: randomUUID(), workspaceId: workspace.id, agent: 'terminal' as const };
    let starts = 0;
    const uncertain = new Workspaces(f.directory, async args => { const output = await f.tmux(args); if (args[0] === 'new-session') { starts++; throw new Error('lost launch response'); } return output; }, async () => '/bin/sh');
    await assert.rejects(uncertain.start(request), /did not finish/);
    const restored = await original.start(request);
    assert.equal(starts, 1); assert.match(restored, /^workbench_t_/);
    await f.tmux(['kill-session', '-t', '=' + restored]);
    assert.equal(await original.start(request), restored);
    await assert.rejects(f.tmux(['has-session', '-t', '=' + restored]));
    const missingRequest = { ...request, requestId: randomUUID() };
    const missing = new Workspaces(f.directory, async args => { if (args[0] === 'new-session') throw new Error('spawn failed'); return f.tmux(args); }, async () => '/bin/sh');
    await assert.rejects(missing.start(missingRequest), /did not finish/);
    await assert.rejects(original.start(missingRequest), /already attempted/);
    assert.equal(await realpath(workspace.cwd), workspace.cwd);
  } finally { await f.close(); }
});

test('a delayed watch snapshot cannot claim a newer timestamp than a completed start', { timeout: 10_000 }, async () => {
  const f = await fixture(); const sessions = new Sessions(f.directory);
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  try {
    const { workspace } = await sessions.createWorkspace({ requestId: randomUUID(), name: 'Snapshot order', parentDirectory: f.root, agent: 'none' });
    let first = true;
    (sessions as unknown as { tmux: (args: string[]) => Promise<string> }).tmux = async args => {
      if (args[0] === 'list-sessions' && first) { first = false; reached(); await blocked; }
      return f.tmux(args);
    };
    const oldSnapshot = sessions.snapshot(false);
    await entered; await new Promise(resolve => setTimeout(resolve, 10));
    const started = await sessions.startSession({ requestId: randomUUID(), workspaceId: workspace.id, agent: 'terminal' });
    release(); const stale = await oldSnapshot;
    assert.ok(stale.updatedAt < started.snapshot.updatedAt, 'snapshot age reflects the read start, not completion');
    assert.equal(started.snapshot.workspaces.find(item => item.id === workspace.id)?.panes[0].tmux, started.sessionId);
  } finally { release?.(); sessions.close(); await f.close(); }
});
