import { WebSocket, createWebSocketStream } from 'ws';
import { canonicalKey, websocketURL, type HostConfiguration } from '../shared/protocol';
import { HostSSH } from './ssh';
import { Sessions } from './sessions';
import { boundedTunnel } from './tunnel';

export class Companion {
  readonly sessions: Sessions;
  readonly ssh: HostSSH;
  private granted = new Set<string>();
  private control?: WebSocket;
  private streams = new Set<WebSocket>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private failures = 0;
  constructor(readonly config: HostConfiguration, private log: (message: string) => void = console.log) {
    this.sessions = new Sessions(config.directory);
    this.ssh = new HostSSH(this.sessions, config.privateKey, deviceId => this.granted.has(deviceId) ? config.approvedKeys[deviceId] : undefined);
  }
  start() {
    if (this.stopped) return;
    const ws = new WebSocket(websocketURL(this.config.relay, '/v1/host'), { headers: { Authorization: `Bearer ${this.config.hostToken}` }, handshakeTimeout: 15_000, maxPayload: 64 * 1024 });
    this.control = ws;
    ws.on('open', () => { this.failures = 0; this.log('Companion connected. Existing sessions are available to paired devices.'); });
    ws.on('error', () => ws.close());
    ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'grants' && Array.isArray(message.devices)) {
          const next = new Set<string>();
          for (const device of message.devices) {
            // The relay can remove grants, but cannot add or substitute a locally approved key.
            if (typeof device.id === 'string' && this.config.approvedKeys[device.id] === canonicalKey(device.publicKey)) next.add(device.id);
          }
          for (const device of this.granted) if (!next.has(device)) this.ssh.revoke(device);
          this.granted = next;
        } else if (message.type === 'connect' && typeof message.connectionId === 'string' && typeof message.ticket === 'string' && this.granted.has(message.deviceId)) {
          this.bridge(message.connectionId, message.deviceId, message.ticket);
        }
      } catch { ws.close(1008, 'Invalid companion message'); }
    });
    ws.on('close', () => {
      if (this.control !== ws) return;
      this.granted.clear();
      for (const stream of this.streams) stream.close();
      if (this.stopped) return;
      this.log('Relay connection lost; agents remain running. Reconnecting…');
      this.timer = setTimeout(() => this.start(), Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)));
    });
  }
  private bridge(connectionId: string, deviceId: string, ticket: string) {
    if (!/^[a-f0-9-]{36}$/.test(connectionId) || this.streams.size >= 8) return;
    const ws = new WebSocket(websocketURL(this.config.relay, `/v1/bridge/${connectionId}`), {
      headers: { Authorization: `Bearer ${this.config.hostToken}`, 'X-Workbench-Ticket': ticket },
      handshakeTimeout: 15_000, maxPayload: 128 * 1024, perMessageDeflate: false });
    this.streams.add(ws);
    ws.on('open', () => {
      const stream = boundedTunnel(createWebSocketStream(ws));
      ws.on('close', () => stream.destroy());
      this.ssh.accept(stream, connectionId, deviceId);
    });
    ws.on('error', () => ws.close()); ws.on('close', () => this.streams.delete(ws));
  }
  close() {
    this.stopped = true; clearTimeout(this.timer); this.control?.close();
    for (const ws of this.streams) ws.close();
    this.ssh.close(); this.sessions.close();
  }
}
