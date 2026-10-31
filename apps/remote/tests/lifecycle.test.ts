import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Sessions } from '../services/host/sessions';
import { SessionLifecycle } from '../services/host/lifecycle';

const run = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-delete-test-'));
  const directory = path.join(root, 'state'); await mkdir(directory);
  const socket = path.join(directory, 'tmux-ui.sock');
  const tmux = async (args: string[]) => (await run('tmux', ['-f', '/dev/null', '-S', socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: '', TMUX_PANE: '' } })).stdout.trim();
  const sessions = new Sessions(directory);
  return { root, directory, tmux, sessions, async close() { sessions.close(); await tmux(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

test('deleting the last companion session stops it but keeps its folder, files and empty workspace', { timeout: 15_000 }, async () => {
  const f = await fixture(); let restarted: Sessions | undefined;
  try {
    const creation = { requestId: randomUUID(), name: 'project', parentDirectory: f.root, agent: 'terminal' as const };
    const { workspace } = await f.sessions.createWorkspace(creation);
    await writeFile(path.join(workspace.cwd, 'keep.txt'), 'KEEP ORIGINAL CONTENT\n');
    const name = workspace.panes[0].tmux;
    const request = { requestId: randomUUID(), workspaceId: workspace.id, sessionId: name };
    const snapshot = await f.sessions.deleteSession(request);
    assert.deepEqual(snapshot.workspaces.find(item => item.id === workspace.id)?.panes, []);
    await assert.rejects(f.tmux(['has-session', '-t', '=' + name]));
    assert.equal(await readFile(path.join(workspace.cwd, 'keep.txt'), 'utf8'), 'KEEP ORIGINAL CONTENT\n');
    assert.equal((await f.sessions.listFiles(workspace.id, '')).entries[0].name, 'keep.txt');
    assert.deepEqual((await f.sessions.createWorkspace(creation)).workspace.panes, []);
    assert.deepEqual((await f.sessions.createWorkspace({ ...creation, requestId: randomUUID(), mode: 'open' })).workspace.panes, []);
    await assert.rejects(f.tmux(['has-session', '-t', '=' + name]));
    // An unrelated later process may deliberately reuse the old tmux name.
    // Neither a completed request nor a restarted companion may kill it again.
    await f.tmux(['new-session', '-d', '-s', name, '/bin/sh']);
    const replacementPid = await f.tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']);
    await f.sessions.deleteSession(request);
    f.sessions.close(); restarted = new Sessions(f.directory);
    await restarted.deleteSession(request);
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']), replacementPid);
    await assert.rejects(restarted.deleteSession({ ...request, sessionId: 'workbench_t_another' }), /already used/);
    assert.deepEqual((await restarted.snapshot()).workspaces.find(item => item.id === workspace.id)?.panes, []);
    assert.equal(await readFile(path.join(workspace.cwd, 'keep.txt'), 'utf8'), 'KEEP ORIGINAL CONTENT\n');
  } finally { restarted?.close(); await f.close(); }
});

test('desktop and stopped tabs can be removed without changing desktop layout or another live session', { timeout: 10_000 }, async () => {
  const f = await fixture();
  const first = 'workbench_t_delete_fixture', second = 'workbench_t_keep_fixture', stopped = 'workbench_h_stopped_fixture';
  try {
    await f.tmux(['new-session', '-d', '-s', first, '/bin/sh']);
    await f.tmux(['new-session', '-d', '-s', second, '/bin/sh']);
    const originalPid = await f.tmux(['display-message', '-p', '-t', '=' + second + ':', '#{pane_pid}']);
    const raw = JSON.stringify({ sessions: [{ id: 'desktop', cwd: f.root, terminals: [{ tmux: first, name: 'Remove' }], harnesses: [{ tmux: stopped, name: 'Stopped' }] },
      { id: 'other', cwd: f.directory, terminals: [{ tmux: second, name: 'Keep' }] }] }) + '\n';
    await writeFile(path.join(f.directory, 'workbench-ui-state.json'), raw);
    await assert.rejects(f.sessions.deleteSession({ requestId: randomUUID(), workspaceId: 'other', sessionId: first }), /not in this workspace/);
    await f.sessions.deleteSession({ requestId: randomUUID(), workspaceId: 'desktop', sessionId: stopped });
    await f.sessions.deleteSession({ requestId: randomUUID(), workspaceId: 'desktop', sessionId: first });
    const snapshot = await f.sessions.snapshot();
    assert.deepEqual(snapshot.workspaces.find(item => item.id === 'desktop')?.panes, []);
    assert.equal(snapshot.workspaces.find(item => item.id === 'other')?.panes[0].tmux, second);
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + second + ':', '#{pane_pid}']), originalPid);
    assert.equal(await readFile(path.join(f.directory, 'workbench-ui-state.json'), 'utf8'), raw);
    const reopened = await f.sessions.createWorkspace({ requestId: randomUUID(), name: path.basename(f.root), parentDirectory: path.dirname(f.root), agent: 'terminal', mode: 'open' });
    assert.equal(reopened.workspace.id, 'desktop');
    assert.deepEqual(reopened.workspace.panes, [], 'opening an intentionally emptied desktop workspace must not create new tabs');
    assert.equal(await readFile(path.join(f.directory, 'workbench-ui-state.json'), 'utf8'), raw);
  } finally { await f.close(); }
});

test('failed pending deletion remains visible, blocks resurrection, and cannot kill a reused name on retry', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const creation = { requestId: randomUUID(), name: 'pending-project', parentDirectory: f.root, agent: 'terminal' as const };
    const { workspace } = await f.sessions.createWorkspace(creation);
    const name = workspace.panes[0].tmux, request = { requestId: randomUUID(), workspaceId: workspace.id, sessionId: name };
    const denied = new SessionLifecycle(f.directory, async args => { if (args[0] === 'if-shell') throw new Error('simulated permission error'); return f.tmux(args); }, () => f.sessions.snapshot(false));
    await assert.rejects(f.sessions.workspaces.exclusive(() => denied.delete(request)), /remains visible/);
    assert.equal((await f.sessions.snapshot()).workspaces.find(item => item.id === workspace.id)?.panes.length, 1);
    assert.equal((await denied.names(false)).has(name), true); assert.equal((await denied.names(true)).has(name), false);
    // Verification follows physical identity even if an external client renames
    // the target while an unsuccessful deletion is pending.
    await f.tmux(['rename-session', '-t', '=' + name, name + '_renamed']);
    await assert.rejects(f.sessions.workspaces.exclusive(() => denied.delete(request)), /remains visible/);
    assert.equal((await denied.names(true)).has(name), false);
    await f.tmux(['rename-session', '-t', '=' + name + '_renamed', name]);
    // Simulate a saved incomplete creation and an external process exit. A
    // creation retry must not resurrect the pane with deletion intent recorded.
    const registryFile = path.join(f.directory, 'remote-workspaces.json');
    const registry = JSON.parse(await readFile(registryFile, 'utf8')); registry.workspaces[0].ready = false;
    await writeFile(registryFile, JSON.stringify(registry));
    await f.tmux(['kill-session', '-t', '=' + name]);
    await f.sessions.createWorkspace(creation);
    await assert.rejects(f.tmux(['has-session', '-t', '=' + name]));
    await f.tmux(['new-session', '-d', '-s', name, '/bin/sh']);
    const replacementPid = await f.tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']);
    const retry = new SessionLifecycle(f.directory, f.tmux, () => f.sessions.snapshot(false));
    // A restarted phone has a fresh UUID; it must not rebind a pending intent.
    await f.sessions.workspaces.exclusive(() => retry.delete({ ...request, requestId: randomUUID() }));
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']), replacementPid);
    await f.sessions.workspaces.exclusive(() => retry.delete(request));
    assert.equal(await f.tmux(['display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}']), replacementPid);
    assert.equal((await retry.names(true)).has(name), true);
  } finally { await f.close(); }
});

test('invalid deletion inputs and corrupt ledgers never execute a tmux deletion', async () => {
  const f = await fixture(); let calls = 0;
  const lifecycle = new SessionLifecycle(f.directory, async () => { calls++; throw new Error('must not execute'); }, async () => ({ workspaces: [], updatedAt: 0 }));
  try {
    const valid = { requestId: randomUUID(), workspaceId: 'workspace', sessionId: 'workbench_t_test' };
    for (const input of [{ ...valid, requestId: 'bad' }, { ...valid, workspaceId: '' }, { ...valid, sessionId: 'other-session' }, { ...valid, sessionId: 'workbench_t_test; kill-server' }]) {
      await assert.rejects(lifecycle.delete(input), /Invalid/);
    }
    const file = path.join(f.directory, 'remote-session-deletions.json');
    for (const value of [null, { version: 2, deletions: [] }, { version: 1, deletions: [{ ...valid, complete: false, identity: { server: '1', session: 'not-an-id', created: '2' } }] }]) {
      const raw = JSON.stringify(value); await writeFile(file, raw);
      await assert.rejects(lifecycle.delete(valid), /file was left unchanged/);
      assert.equal(await readFile(file, 'utf8'), raw);
    }
    assert.equal(calls, 0);
  } finally { await f.close(); }
});
