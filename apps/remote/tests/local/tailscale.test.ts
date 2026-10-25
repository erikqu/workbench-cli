import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureTailscale, checkServeConfiguration, tailscaleOrigin } from '../../services/local/tailscale';
const origin = 'https://computer.example.ts.net:8443';
test('Tailscale must be logged in with a MagicDNS name', () => {
  assert.throws(() => tailscaleOrigin({ BackendState: 'NeedsLogin' }), /sign in/);
  assert.throws(() => tailscaleOrigin({ BackendState: 'Running', Self: { DNSName: 'evil.example/path' } }), /MagicDNS/);
  assert.equal(tailscaleOrigin({ BackendState: 'Running', Self: { DNSName: 'computer.example.ts.net.' } }), origin);
});
test('pairing checks state before configuring only a private Serve endpoint', () => {
  const calls: string[][] = [];
  assert.equal(configureTailscale(args => { calls.push(args); return args[0] === 'status' ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'computer.example.ts.net.' } }) : '{}'; }), origin);
  assert.deepEqual(calls, [['status', '--json'], ['serve', 'status', '--json'], ['serve', '--bg', '--https=8443', 'http://127.0.0.1:9419']]);
  let mutations = 0;
  assert.throws(() => configureTailscale(args => { if (args[0] === 'status') return '{"BackendState":"NeedsLogin"}'; mutations++; return '{}'; }), /sign in/);
  assert.equal(mutations, 0);
});
test('pairing refuses Funnel, port conflicts, and foreground handlers', () => {
  const host = new URL(origin).host;
  assert.throws(() => checkServeConfiguration({ AllowFunnel: { [host]: true } }, origin), /Funnel/);
  assert.throws(() => checkServeConfiguration({ Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1234' } } } } }, origin), /already in use/);
  assert.throws(() => checkServeConfiguration({ Foreground: { demo: { TCP: { '8443': { TCPForward: 'localhost:1234' } } } } }, origin), /already in use/);
  assert.doesNotThrow(() => checkServeConfiguration({ Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9419' } } } }, TCP: { '443': { HTTPS: true } } }, origin));
});
