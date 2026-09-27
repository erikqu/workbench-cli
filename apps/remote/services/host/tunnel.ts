import { Duplex } from 'node:stream';

export const TUNNEL_FRAME_BYTES = 64 * 1024;

// SSH is a byte stream, not a WebSocket-message protocol. NIOSSH advertises a
// 16 MiB SSH packet size, so a single encrypted write can exceed the tunnel's
// 128 KiB message limit. Slice writes in order and wait for each frame to drain.
export function boundedTunnel(transport: Duplex): Duplex {
  const tunnel = new Duplex({
    highWaterMark: TUNNEL_FRAME_BYTES,
    read() { transport.resume(); },
    write(data: Buffer, _encoding, done) {
      let offset = 0;
      const next = (error?: Error | null) => {
        if (error || offset === data.length) { done(error); return; }
        const frame = data.subarray(offset, offset + TUNNEL_FRAME_BYTES);
        offset += frame.length;
        transport.write(frame, next);
      };
      next();
    },
    final(done) { transport.end(done); },
    destroy(error, done) { transport.destroy(error || undefined); done(error); },
  });
  transport.on('data', data => { if (!tunnel.push(data)) transport.pause(); });
  transport.on('end', () => tunnel.push(null));
  transport.on('error', error => tunnel.destroy(error));
  transport.on('close', () => tunnel.destroy());
  return tunnel;
}
