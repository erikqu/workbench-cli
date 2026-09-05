import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { attachCommand, discoveryCommands, parseSnapshot, remoteDirectory } from './discovery';
import type { Profile, Credentials, RemoteEvent, Snapshot } from './shared';

export class Remote extends EventEmitter {
  private client?: Client;
  private profile?: Profile;
  private channels = new Map<string, { stream: ClientChannel; pending: number }>();
  private allowed = new Set<string>();
  private generation = 0;
  private attaching = new Set<string>();
  connected = false;
  constructor(private verify: (host: string, fingerprint: string) => Promise<boolean>) { super(); }
  private emitEvent(event: RemoteEvent) { this.emit('event', event); }

  async connect(profile: Profile, credentials: Credentials): Promise<Snapshot> {
    this.disconnect();
    const generation = this.generation;
    if (!profile || typeof profile.host !== 'string' || !profile.host.trim() ||
        typeof profile.username !== 'string' || !profile.username.trim() ||
        !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error('Enter a hostname, username, and valid SSH port.');
    remoteDirectory(profile.directory);
    const config: ConnectConfig = {
      host: profile.host.trim(), port: profile.port, username: profile.username.trim(),
      readyTimeout: 30000, keepaliveInterval: 10000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
        const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        this.verify(`${profile.host}:${profile.port}`, fingerprint).then(callback, () => callback(false));
      },
    };
    if (profile.auth === 'agent') {
      if (!process.env.SSH_AUTH_SOCK) throw new Error('No SSH agent found. Choose Private key, or load your key into the macOS SSH agent.');
      config.agent = process.env.SSH_AUTH_SOCK;
    } else if (profile.auth === 'key') {
      if (!profile.keyPath) throw new Error('Choose your SSH private key.');
      config.privateKey = await readFile(profile.keyPath);
      config.passphrase = credentials.passphrase || undefined;
    } else if (profile.auth === 'password') config.password = credentials.password || '';
    else throw new Error('Unsupported authentication method');
    if (generation !== this.generation) throw new Error('Connection cancelled');
    const client = new Client();
    this.client = client;
    this.profile = { ...profile };
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      client.on('ready', () => { ready = true; this.connected = true; resolve(); });
      client.on('error', error => {
        if (!ready) reject(error);
        else if (this.client === client) this.emitEvent({ type: 'status', connected: false, message: error.message });
      });
      client.on('close', () => {
        if (!ready) reject(new Error('SSH connection closed before authentication completed.'));
        if (this.client !== client) return;
        this.connected = false;
        this.channels.clear();
        this.allowed.clear();
        this.emitEvent({ type: 'status', connected: false, message: 'Connection lost. Your remote sessions are still running.' });
      });
      client.connect(config);
    });
    try {
      const snapshot = await this.refresh();
      this.emitEvent({ type: 'status', connected: true, message: 'Connected' });
      return snapshot;
    } catch (error) { this.disconnect(); throw error; }
  }

  private exec(command: string): Promise<string> {
    const client = this.client;
    if (!client || !this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      let stream: ClientChannel | undefined;
      const timer = setTimeout(() => { stream?.close(); reject(new Error('Remote command timed out')); }, 15000);
      client.exec(command, (error, channel) => {
        if (error) { clearTimeout(timer); reject(error); return; }
        stream = channel;
        let output = '', stderr = '', size = 0;
        channel.setEncoding('utf8');
        channel.on('data', (data: string) => {
          size += Buffer.byteLength(data);
          if (size > 4 * 1024 * 1024) { channel.close(); clearTimeout(timer); reject(new Error('Workbench layout is too large')); }
          else output += data;
        });
        channel.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
        channel.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
        channel.on('close', (code: number) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(stderr.trim() || `Remote command failed (${code})`));
          else resolve(output);
        });
      });
    });
  }

  async refresh(): Promise<Snapshot> {
    if (!this.profile || !this.connected) throw new Error('Not connected');
    const generation = this.generation;
    const commands = discoveryCommands(this.profile.directory);
    let raw = '', warning: string | undefined;
    try { raw = await this.exec(commands.state); parseSnapshot(raw, []); }
    catch {
      try { raw = await this.exec(commands.backup); parseSnapshot(raw, []); warning = 'Using the backup layout; the current layout could not be read.'; }
      catch { raw = '{"sessions":[]}'; warning = 'No readable saved layout. Showing live sessions from this Workbench directory.'; }
    }
    let live: string[] = [];
    try { live = (await this.exec(commands.live)).trim().split('\n').filter(Boolean); }
    catch (error) {
      const message = (error as Error).message;
      if (!/no server running|No such file or directory|Connection refused/.test(message) || /tmux:.*not found/.test(message)) throw error;
      warning = 'No live tmux server in this directory. Start Workbench on the remote machine to restore its saved sessions.';
    }
    if (generation !== this.generation || !this.connected) throw new Error('Connection changed while refreshing');
    const snapshot = parseSnapshot(raw, live, warning);
    this.allowed = new Set(snapshot.workspaces.flatMap(w => w.panes.filter(p => p.live).map(p => p.tmux)));
    return snapshot;
  }

  async attach(id: string, name: string, cols: number, rows: number): Promise<void> {
    if (!this.client || !this.profile || !this.connected) throw new Error('Not connected');
    if (id !== name || !this.allowed.has(name)) throw new Error('This session is no longer running. Refresh the workspace list.');
    if (this.channels.has(id) || this.attaching.has(id)) throw new Error('Session is already attached');
    const generation = this.generation;
    this.attaching.add(id);
    try {
      await new Promise<void>((resolve, reject) => {
        this.client!.exec(attachCommand(this.profile!.directory, name),
          { pty: { term: 'xterm-256color', cols: dimension(cols), rows: dimension(rows) } }, (error, stream) => {
            if (error) { reject(error); return; }
            if (generation !== this.generation) { stream.close(); reject(new Error('Connection changed')); return; }
            const channel = { stream, pending: 0 };
            this.channels.set(id, channel);
            const forward = (data: Buffer) => {
              channel.pending += data.length;
              this.emitEvent({ type: 'data', id, data: new Uint8Array(data) });
              if (channel.pending > 256 * 1024) stream.pause();
            };
            stream.on('data', forward);
            stream.stderr.on('data', forward);
            stream.on('error', () => stream.close());
            stream.on('close', () => {
              if (this.channels.get(id) !== channel) return;
              this.channels.delete(id);
              this.emitEvent({ type: 'exit', id });
            });
            resolve();
          });
      });
    } finally { this.attaching.delete(id); }
  }
  input(id: string, data: string) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) return;
    this.channels.get(id)?.stream.write(data);
  }
  resize(id: string, cols: number, rows: number) { this.channels.get(id)?.stream.setWindow(dimension(rows), dimension(cols), 0, 0); }
  ack(id: string, bytes: number) {
    const channel = this.channels.get(id);
    if (!channel || !Number.isInteger(bytes) || bytes < 0) return;
    channel.pending = Math.max(0, channel.pending - bytes);
    if (channel.pending < 64 * 1024) channel.stream.resume();
  }
  detach(id: string) {
    const channel = this.channels.get(id);
    this.channels.delete(id);
    channel?.stream.close();
  }
  disconnect() {
    this.generation++;
    this.connected = false;
    for (const id of this.channels.keys()) this.detach(id);
    this.attaching.clear();
    this.allowed.clear();
    const client = this.client;
    this.client = undefined;
    client?.end();
  }
}
function dimension(value: number) { return Number.isFinite(value) ? Math.max(2, Math.min(1000, Math.floor(value))) : 80; }
