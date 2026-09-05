import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentActivity, hasBusyMarker, recentActivity } from '../services/host/activity';

test('agent busy indicators require a whole status row, not ordinary output', () => {
  for (const pane of [
    '• Working (12s • esc to interrupt)',
    '  · Working (2m 14s • ctrl+c to cancel)  ',
    'output\nWorking (esc to interrupt)\n› ',
    '⏵⏵ Running tests · ctrl-c to interrupt',
  ]) assert.equal(hasBusyMarker(pane), true, pane);
  for (const pane of [
    '', 'The agent is working', '> Working (esc to interrupt)',
    'console.log("Working (esc to interrupt)");',
    'Working (esc to interrupt) appears in the UI',
    'Working (waiting for an answer)', 'Working (esc\nto interrupt)',
  ]) assert.equal(hasBusyMarker(pane), false, pane);
});

test('Codex activity does not animate just because the cursor or prompt produced output', () => {
  assert.equal(agentActivity('codex', '› Tell me what to do', true), 'idle');
  assert.equal(agentActivity('codex', '• Working (6s • esc to interrupt)', false), 'working');
  assert.equal(agentActivity('other-agent', 'Building modules…', true), 'recent');
  assert.equal(agentActivity(undefined, 'Build complete', false), 'idle');
  assert.equal(agentActivity('other-agent', 'Working (esc to interrupt)', true), 'working');
});

test('recent output excludes dead windows, stale output and malformed/future timestamps', () => {
  const result = recentActivity([
    'alive|100|0', 'alive|99|0', 'boundary|98|0', 'stale|97|0', 'dead|100|1',
    'future|999999|0', 'infinity|Infinity|0', 'missing||0', 'missing-state|100',
    'non-numeric|hello|0', 'decimal|99.5|0', 'extra|100|0|ignored', '|100|0',
  ].join('\n'), 100_000);
  assert.deepEqual([...result].sort(), ['alive', 'boundary']);
});
