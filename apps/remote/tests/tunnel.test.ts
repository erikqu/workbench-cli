import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { boundedTunnel, TUNNEL_FRAME_BYTES } from '../services/host/tunnel';

test('encrypted SSH writes are framed in order with bounded messages and backpressure', { timeout: 5000 }, async () => {
  const frames: Buffer[] = [];
  let inFlight = 0, maximumInFlight = 0;
  const transport = new Duplex({
    read() {},
    write(data, _encoding, done) {
      maximumInFlight = Math.max(maximumInFlight, ++inFlight);
      frames.push(Buffer.from(data));
      setImmediate(() => { inFlight--; done(); });
    },
  });
  const tunnel = boundedTunnel(transport);
  try {
    const first = Buffer.alloc(TUNNEL_FRAME_BYTES * 5 + 37, 0x61), second = Buffer.from('next SSH write');
    // The next write is intentionally queued while the first large packet drains.
    const firstComplete = new Promise<void>((resolve, reject) => tunnel.write(first, error => error ? reject(error) : resolve()));
    const secondComplete = new Promise<void>((resolve, reject) => tunnel.write(second, error => error ? reject(error) : resolve()));
    await Promise.all([firstComplete, secondComplete]);
    assert.deepEqual(Buffer.concat(frames), Buffer.concat([first, second]));
    assert.equal(maximumInFlight, 1);
    assert.ok(frames.every(frame => frame.length <= TUNNEL_FRAME_BYTES));
    const incoming = once(tunnel, 'data');
    transport.push(Buffer.from('phone SSH bytes'));
    assert.equal((await incoming)[0].toString(), 'phone SSH bytes');
  } finally { tunnel.destroy(); transport.destroy(); }
});

test('a failed tunnel frame rejects the SSH write instead of sending later frames', { timeout: 5000 }, async () => {
  let writes = 0;
  const transport = new Duplex({ read() {}, write(_data, _encoding, done) { writes++; done(new Error('socket closed')); } });
  const tunnel = boundedTunnel(transport);
  transport.on('error', () => {}); tunnel.on('error', () => {});
  try {
    await assert.rejects(new Promise<void>((resolve, reject) => tunnel.write(Buffer.alloc(TUNNEL_FRAME_BYTES * 3), error => error ? reject(error) : resolve())), /socket closed/);
    assert.equal(writes, 1);
  } finally { tunnel.destroy(); transport.destroy(); }
});
