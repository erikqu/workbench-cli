import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { parseSnapshot } from '../../src/discovery';
import type { Snapshot } from '../../src/shared';
import { size } from '../shared/protocol';

const run = promisify(execFile);
export interface Attachment {
  id: string; connectionId: string; sessionId: string; process: pty.IPty; tty: string;
  cols: number; rows: number; writable: boolean; localAttached: boolean;
  desiredCols: number; desiredRows: number; phoneLayout: boolean;
}
export class Sessions extends EventEmitter {
  private entries = new Map<string, Attachment>();
  private writers = new Map<string, string>();
  private polling = false;
  private timer: NodeJS.Timeout;
  private geometry = new Map<string, string>();
  private geometryWork: Promise<void> = Promise.resolve();
  private phoneWindows = new Map<string, { target: string; option: string; effective: string; cols: string; rows: string }>();
  readonly socket: string;
  constructor(readonly directory: string) {
    super(); this.socket = path.join(directory, 'tmux-ui.sock');
    this.timer = setInterval(() => { void this.poll(); }, 1500); this.timer.unref();
  }
  private async tmux(args: string[]) {
    const { stdout } = await run('tmux', ['-S', this.socket, ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TMUX: '', TMUX_PANE: '' } }); return stdout.trim();
  }
  async snapshot(): Promise<Snapshot> {
    let raw = '{"sessions":[]}', warning: string | undefined;
    try { raw = await readFile(path.join(this.directory, 'workbench-ui-state.json'), 'utf8'); parseSnapshot(raw, []); }
    catch {
      try { raw = await readFile(path.join(this.directory, 'workbench-ui-state.json.bak'), 'utf8'); parseSnapshot(raw, []); warning = 'Using the backup layout.'; }
      catch { raw = '{"sessions":[]}'; warning = 'No readable layout. Showing live Workbench sessions.'; }
    }
    let names: string[] = [];
    try { names = (await this.tmux(['list-sessions', '-F', '#{session_name}'])).split('\n').filter(Boolean); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('tmux is not installed on this machine');
      if (!/no server running|No such file|Connection refused/.test(String(error))) throw error;
      warning = 'Start Workbench on this machine to restore its sessions.';
    }
    return parseSnapshot(raw, names, warning);
  }
  private async localClients(sessionId: string) {
    const clients = (await this.tmux(['list-clients', '-t', '=' + sessionId, '-F', '#{client_tty}'])).split('\n').filter(Boolean);
    const ours = new Set([...this.entries.values()].map(entry => entry.tty));
    return clients.filter(tty => !ours.has(tty));
  }
  async attach(connectionId: string, sessionId: string, cols: number, rows: number,
    output: (data: Buffer) => void, ended: () => void): Promise<Attachment> {
    if ([...this.entries.values()].some(entry => entry.connectionId === connectionId && entry.sessionId === sessionId)) throw new Error('Already attached to this session');
    const snapshot = await this.snapshot();
    if (!snapshot.workspaces.some(w => w.panes.some(p => p.tmux === sessionId && p.live))) throw new Error('Session is not running');
    const id = randomUUID();
    const localAttached = (await this.localClients(sessionId)).length > 0;
    const writable = !this.writers.has(sessionId);
    if (writable) this.writers.set(sessionId, id);
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    let processPTY: pty.IPty;
    try {
      processPTY = pty.spawn('tmux', ['-S', this.socket, 'attach-session', '-f', 'ignore-size', '-t', '=' + sessionId],
        { name: 'xterm-256color', cols: size(cols, 80), rows: size(rows, 24), cwd: this.directory, env, encoding: null });
    } catch (error) { if (this.writers.get(sessionId) === id) this.writers.delete(sessionId); throw error; }
    const tty = (processPTY as pty.IPty & { ptsName: string }).ptsName;
    if (!tty) { processPTY.kill(); if (writable) this.writers.delete(sessionId); throw new Error('The PTY adapter did not expose a Unix terminal'); }
    const entry: Attachment = { id, connectionId, sessionId, process: processPTY, tty, cols: size(cols, 80), rows: size(rows, 24),
      desiredCols: size(cols, 80), desiredRows: size(rows, 24), writable, localAttached, phoneLayout: false };
    this.entries.set(id, entry);
    processPTY.onData(data => output(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    processPTY.onExit(() => { this.release(entry); ended(); });
    await this.updateGeometry(entry).catch(() => {});
    return entry;
  }
  input(entry: Attachment, data: Buffer) {
    // Leases are checked at injection time, not just when a channel was opened.
    if (this.entries.get(entry.id) === entry && this.writers.get(entry.sessionId) === entry.id && data.length <= 1024 * 1024) entry.process.write(data);
  }
  resize(entry: Attachment, cols: number, rows: number) {
    entry.desiredCols = size(cols, 80); entry.desiredRows = size(rows, 24);
    void this.updateGeometry(entry).catch(() => {});
  }
  takeControl(connectionId: string, sessionId: string) {
    const entry = [...this.entries.values()].find(e => e.connectionId === connectionId && e.sessionId === sessionId);
    if (!entry) throw new Error('Open the session before taking control');
    this.writers.set(sessionId, entry.id);
    for (const other of this.entries.values()) if (other.sessionId === sessionId) {
      other.writable = other.id === entry.id;
      if (!other.writable) other.phoneLayout = false;
      this.emitState(other);
      void this.updateGeometry(other).catch(() => {});
    }
  }
  async setPhoneLayout(connectionId: string, sessionId: string, enabled: boolean) {
    const entry = [...this.entries.values()].find(e => e.connectionId === connectionId && e.sessionId === sessionId);
    if (!entry) throw new Error('Open the session before changing its layout');
    if (this.writers.get(sessionId) !== entry.id) throw new Error('Take control before changing the terminal layout');
    entry.phoneLayout = enabled;
    await this.updateGeometry(entry);
  }
  private emitState(entry: Attachment) {
    this.emit('state', entry.connectionId, { type: 'sessionState', sessionId: entry.sessionId, writable: this.writers.get(entry.sessionId) === entry.id,
      localAttached: entry.localAttached, phoneLayout: entry.phoneLayout, cols: entry.cols, rows: entry.rows });
  }
  states(connectionId: string) { for (const entry of this.entries.values()) if (entry.connectionId === connectionId) this.emitState(entry); }
  private updateGeometry(entry: Attachment) {
    // Polls, keyboard resizes, lease changes, and disconnects must not race.
    const work = this.geometryWork.then(() => this.applyGeometry(entry));
    this.geometryWork = work.catch(() => {});
    return work;
  }
  private async restoreDesktop(sessionId: string) {
    const saved = this.phoneWindows.get(sessionId);
    if (!saved) return;
    // resize-window installs a local manual override, so restore dimensions first
    // and then put the original explicit/inherited policy back.
    if (saved.effective === 'manual') await this.tmux(['resize-window', '-t', saved.target, '-x', saved.cols, '-y', saved.rows]);
    if (saved.option) await this.tmux(['set-option', '-w', '-t', saved.target, 'window-size', saved.option]);
    else await this.tmux(['set-option', '-w', '-u', '-t', saved.target, 'window-size']);
    this.phoneWindows.delete(sessionId);
  }
  private async applyGeometry(entry: Attachment) {
    if (!this.entries.has(entry.id)) return;
    entry.localAttached = (await this.localClients(entry.sessionId)).length > 0;
    const writer = [...this.entries.values()].find(other => other.id === this.writers.get(entry.sessionId));
    if (writer?.phoneLayout) {
      if (!this.phoneWindows.has(entry.sessionId)) {
        const [target, cols, rows] = (await this.tmux(['display-message', '-p', '-t', '=' + entry.sessionId + ':', '#{window_id} #{window_width} #{window_height}'])).split(' ');
        if (!/^@\d+$/.test(target) || !Number(cols) || !Number(rows)) throw new Error('Cannot determine the session window size');
        const option = await this.tmux(['show-options', '-w', '-qv', '-t', target, 'window-size']);
        const effective = await this.tmux(['show-options', '-w', '-Aqv', '-t', target, 'window-size']);
        this.phoneWindows.set(entry.sessionId, { target, option, effective, cols, rows });
      }
      const target = this.phoneWindows.get(entry.sessionId)!.target;
      // A client flag alone cannot override tmux's largest/latest sizing policy.
      await this.tmux(['resize-window', '-t', target, '-x', String(writer.desiredCols), '-y', String(writer.desiredRows)]);
    } else await this.restoreDesktop(entry.sessionId);
    const ownsSize = writer?.id === entry.id && (!entry.localAttached || entry.phoneLayout);
    await this.tmux(['refresh-client', '-t', entry.tty, '-f', ownsSize ? '!ignore-size' : 'ignore-size']);
    if (ownsSize) entry.process.resize(entry.desiredCols, entry.desiredRows);
    const dimensions = (await this.tmux(['display-message', '-p', '-t', '=' + entry.sessionId + ':', '#{window_width} #{window_height}'])).split(' ').map(Number);
    entry.cols = size(dimensions[0], 80); entry.rows = size(dimensions[1], 24);
    // Mirror actual geometry, including local Workbench's wider terminal.
    if (!ownsSize) entry.process.resize(entry.cols, entry.rows);
    const state = `${entry.cols}:${entry.rows}:${entry.localAttached}:${entry.writable}:${entry.phoneLayout}`;
    if (this.geometry.get(entry.id) !== state) { this.geometry.set(entry.id, state); this.emitState(entry); }
  }
  private async poll() {
    if (this.polling) return; this.polling = true;
    try { for (const entry of this.entries.values()) await this.updateGeometry(entry).catch(() => {}); }
    finally { this.polling = false; }
  }
  private release(entry: Attachment) {
    if (!this.entries.has(entry.id)) return;
    this.entries.delete(entry.id); this.geometry.delete(entry.id);
    if (this.writers.get(entry.sessionId) === entry.id) {
      this.writers.delete(entry.sessionId);
      // Other viewers remain read-only until they explicitly request control.
      for (const other of this.entries.values()) if (other.sessionId === entry.sessionId) this.emitState(other);
    }
    const work = this.geometryWork.then(async () => {
      const writer = [...this.entries.values()].find(other => other.id === this.writers.get(entry.sessionId));
      if (!writer?.phoneLayout) await this.restoreDesktop(entry.sessionId);
    });
    this.geometryWork = work.catch(() => {});
  }
  detach(entry: Attachment) { this.release(entry); try { entry.process.kill(); } catch {} }
  closeConnection(connectionId: string) { for (const entry of this.entries.values()) if (entry.connectionId === connectionId) this.detach(entry); }
  close() { clearInterval(this.timer); for (const entry of this.entries.values()) this.detach(entry); }
}
