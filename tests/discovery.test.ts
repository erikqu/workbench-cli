import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCommand, discoveryCommands, parseSnapshot, quote } from '../src/discovery';

test('maps Workbench persisted identity and discovers live panes not saved yet', () => {
  const state = { sessions: [{ id: 'workspace-1', cwd: '/projects/app/',
    harnesses: [{ id: 'agent-id', name: 'Claude Code', tmux: 'workbench_h_1' }],
    terminals: [{ id: 'term-id', name: 'Terminal 1', tmux: 'workbench_t_1' }] }] };
  const snapshot = parseSnapshot(JSON.stringify(state), ['workbench_h_1', 'workbench_t_extra', 'unrelated']);
  assert.equal(snapshot.workspaces[0].name, 'app');
  assert.equal(snapshot.workspaces[0].panes[0].id, 'workbench_h_1');
  assert.equal(snapshot.workspaces[0].panes[0].live, true);
  assert.equal(snapshot.workspaces[0].panes[1].live, false);
  assert.deepEqual(snapshot.workspaces[1].panes.map(p => p.tmux), ['workbench_t_extra']);
});
test('attach targets exact existing session without detaching peers or creating a session', () => {
  const command = attachCommand('~/.workbench', 'workbench_h_1');
  assert.match(command, /attach-session -t '=workbench_h_1'/);
  assert.doesNotMatch(command, /new-session|kill-| -d| -D/);
  assert.throws(() => attachCommand('~/.workbench', 'bad; touch /tmp/no'), /Invalid/);
});
test('quotes paths and rejects ambiguous directories', () => {
  assert.equal(quote("a'b"), "'a'\\''b'");
  assert.match(discoveryCommands("~/space ' $(oops)").state, /\$HOME/);
  assert.throws(() => discoveryCommands('relative/path'), /absolute/);
  assert.throws(() => parseSnapshot('{"sessions":{}}', []), /sessions/);
  assert.throws(() => parseSnapshot('{"sessions":[{}]}', []), /workspace path/);
});
