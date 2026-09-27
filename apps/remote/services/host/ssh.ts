import ssh2, { type ServerChannel, type Connection } from 'ssh2';
const { Server, utils } = ssh2;
import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { PROTOCOL, size } from '../shared/protocol';
import { Sessions, type Attachment } from './sessions';

export class HostSSH {
  private connections = new Map<string, { client: Connection; deviceId: string }>();
  private controls = new Map<string, Set<ServerChannel>>();
  private listener: (connectionId: string, state: unknown) => void;
  constructor(readonly sessions: Sessions, private privateKey: string,
    private approvedKey: (deviceId: string) => string | undefined) {
    this.listener = (connectionId, state) => { for (const channel of this.controls.get(connectionId) || []) this.send(channel, state); };
    sessions.on('state', this.listener);
  }
  accept(stream: Duplex, connectionId: string, deviceId: string) {
    const server = new Server({ hostKeys: [this.privateKey], ident: 'WorkbenchRemote_1', keepaliveInterval: 15_000, keepaliveCountMax: 2 }, client => {
      this.connections.set(connectionId, { client, deviceId });
      const authTimer = setTimeout(() => client.end(), 20_000);
      client.on('error', () => client.end());
      client.on('authentication', ctx => {
        const allowed = this.approvedKey(deviceId);
        const key = allowed ? utils.parseKey(allowed) : undefined;
        if (!key || key instanceof Error || Array.isArray(key) || ctx.method !== 'publickey' || ctx.username !== deviceId) { ctx.reject(); return; }
        const expected = key.getPublicSSH();
        if (expected.length !== ctx.key.data.length || !timingSafeEqual(expected, ctx.key.data) ||
          (ctx.signature && (!ctx.blob || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true))) { ctx.reject(); return; }
        ctx.accept();
      });
      client.on('ready', () => {
        clearTimeout(authTimer);
        client.on('session', accept => {
          const session = accept(); let cols = 80, rows = 24, entry: Attachment | undefined, channel: ServerChannel | undefined;
          let started = false, closed = false;
          session.on('pty', (accept, reject, info) => {
            if (started) { reject?.(); return; } cols = size(info.cols, 80); rows = size(info.rows, 24); accept?.();
          });
          session.on('window-change', (accept, _reject, info) => { cols = size(info.cols, 80); rows = size(info.rows, 24); if (entry) this.sessions.resize(entry, cols, rows); accept?.(); });
          session.on('subsystem', (accept, reject, info) => {
            if (started || info.name !== PROTOCOL) { reject(); return; } started = true;
            channel = accept(); this.control(channel, connectionId);
          });
          session.on('exec', (accept, reject, info) => {
            if (started || !/^workbench-attach:workbench_[A-Za-z0-9_-]+$/.test(info.command)) { reject(); return; } started = true;
            channel = accept(); const terminalChannel = channel;
            terminalChannel.on('close', () => { closed = true; if (entry) this.sessions.detach(entry); });
            terminalChannel.on('error', () => terminalChannel.close());
            let buffered = 0;
            terminalChannel.on('data', (data: Buffer) => { if (entry) this.sessions.input(entry, data); });
            terminalChannel.on('drain', () => { buffered = 0; entry?.process.resume(); });
            void this.sessions.attach(connectionId, info.command.slice('workbench-attach:'.length), cols, rows, data => {
              buffered += data.length;
              if (buffered > 4 * 1024 * 1024) { terminalChannel.close(); return; }
              if (!terminalChannel.write(data)) entry?.process.pause(); else buffered = 0;
            }, () => { terminalChannel.exit(0); terminalChannel.end(); }).then(value => {
              entry = value;
              if (closed) this.sessions.detach(value); else this.sessions.states(connectionId);
            }).catch(() => { terminalChannel.stderr.write('Session is unavailable. Refresh the session list.\r\n'); terminalChannel.exit(1); terminalChannel.end(); });
          });
          session.on('close', () => { closed = true; if (entry) this.sessions.detach(entry); });
        });
        // Forwarding, arbitrary shells, SFTP, and arbitrary exec requests are not exposed.
        client.on('tcpip', (_accept, reject) => reject());
      });
      client.on('close', () => { clearTimeout(authTimer); this.connections.delete(connectionId); this.controls.delete(connectionId); this.sessions.closeConnection(connectionId); });
    });
    stream.on('error', () => stream.destroy());
    server.injectSocket(stream as Parameters<ssh2.Server['injectSocket']>[0]);
  }
  private send(channel: ServerChannel, value: unknown) {
    if (channel.writableLength > 1024 * 1024) { channel.close(); return; }
    channel.write(JSON.stringify(value) + '\n');
  }
  private control(channel: ServerChannel, connectionId: string) {
    let buffer = '', watching = false, busy = false, fileRequests = 0;
    const controls = this.controls.get(connectionId) || new Set(); controls.add(channel); this.controls.set(connectionId, controls);
    const sendSnapshot = async (id?: string) => {
      if (busy) return; busy = true;
      try { this.send(channel, { ...(id ? { id } : {}), type: 'snapshot', snapshot: await this.sessions.snapshot() }); }
      catch { this.send(channel, { ...(id ? { id } : {}), type: 'error', message: 'Could not read Workbench sessions on the host.' }); }
      finally { busy = false; }
    };
    const fileOperation = async (id: string, operation: () => Promise<object>) => {
      if (fileRequests >= 4) { this.send(channel, { id, type: 'error', message: 'Too many file requests. Try again shortly.' }); return; }
      fileRequests++;
      try { this.send(channel, { id, ...await operation() }); }
      catch (error) { this.send(channel, { id, type: 'error', message: error instanceof Error ? error.message : 'Could not read this file or folder.' }); }
      finally { fileRequests--; }
    };
    const timer = setInterval(() => { if (watching) void sendSnapshot(); }, 2000); timer.unref();
    channel.setEncoding('utf8');
    channel.on('data', (data: string) => {
      buffer += data;
      if (buffer.length > 16_384) { channel.close(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const request = JSON.parse(line);
          if (typeof request.id !== 'string' || request.id.length > 100) throw new Error('Invalid request');
          if (request.method === 'list' || request.method === 'watch') { watching ||= request.method === 'watch'; void sendSnapshot(request.id); this.sessions.states(connectionId); }
          else if (request.method === 'takeControl' && typeof request.sessionId === 'string') { this.sessions.takeControl(connectionId, request.sessionId); this.send(channel, { id: request.id, type: 'ok' }); }
          else if (request.method === 'setPhoneLayout' && typeof request.sessionId === 'string' && typeof request.enabled === 'boolean') {
            void this.sessions.setPhoneLayout(connectionId, request.sessionId, request.enabled)
              .then(() => this.send(channel, { id: request.id, type: 'ok' }))
              .catch(() => this.send(channel, { id: request.id, type: 'error', message: 'Could not change layout. Take control and try again.' }));
          }
          else if (request.method === 'createWorkspace') {
            void this.sessions.createWorkspace({ requestId: request.id, name: request.name, parentDirectory: request.parentDirectory, agent: request.agent })
              .then(result => { this.send(channel, { id: request.id, type: 'workspaceCreated', workspace: result.workspace }); this.send(channel, { type: 'snapshot', snapshot: result.snapshot }); })
              .catch(error => this.send(channel, { id: request.id, type: 'error', message: error instanceof Error ? error.message : 'Could not create the workspace.' }));
          }
          else if (request.method === 'listFiles') {
            void fileOperation(request.id, async () => ({ type: 'directory', directory: await this.sessions.listFiles(request.workspaceId, request.path) }));
          }
          else if (request.method === 'readFile') {
            void fileOperation(request.id, async () => ({ type: 'fileChunk', fileChunk: await this.sessions.readFile(request.workspaceId, request.path, request.offset) }));
          }
          else this.send(channel, { id: request.id, type: 'error', message: 'Unsupported operation' });
        } catch { this.send(channel, { type: 'error', message: 'Invalid control request' }); }
      }
    });
    channel.on('error', () => channel.close());
    channel.on('close', () => { clearInterval(timer); controls.delete(channel); });
    this.send(channel, { type: 'hello', protocol: PROTOCOL, version: 1, capabilities: ['createWorkspace', 'files'] });
  }
  revoke(deviceId: string) { for (const value of this.connections.values()) if (value.deviceId === deviceId) value.client.end(); }
  close() { for (const value of this.connections.values()) value.client.end(); this.sessions.off('state', this.listener); }
}
