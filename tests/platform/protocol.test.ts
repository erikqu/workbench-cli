import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalKey, generateIdentity, relayURL, verificationCode } from '../../services/shared/protocol';
test('pairing verification binds the host, secret, and exact device key', () => {
  const host = generateIdentity();
  const first = generateIdentity(), second = generateIdentity();
  const code = verificationCode('secret', host.public, first.public);
  assert.match(code, /^\d{6}$/);
  assert.notEqual(code, verificationCode('secret', host.public, second.public));
  assert.notEqual(code, verificationCode('different', host.public, first.public));
  assert.equal(canonicalKey(first.public + ' comment'), canonicalKey(first.public));
  assert.throws(() => canonicalKey(first.private), /public key/);
});
test('relay addresses require authenticated HTTPS outside loopback', () => {
  assert.equal(relayURL('https://relay.example').origin, 'https://relay.example');
  assert.equal(relayURL('http://127.0.0.1:8080').port, '8080');
  for (const url of ['http://remote.example', 'https://a:b@relay.example', 'https://relay.example/path', 'https://relay.example?token=abc']) assert.throws(() => relayURL(url));
});
test('pairing code matches the Swift interoperability vector, including leading zero', () => {
  const host = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea';
  const device = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM';
  assert.equal(verificationCode('a'.repeat(43), host, device), '085885');
});
