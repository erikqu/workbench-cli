import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { parseSnapshot } from '../../src/discovery';
import type { Snapshot } from '../../src/shared';
import { size } from '../shared/protocol';
import { Workspaces, type NewWorkspace, type StartSession, type WorkspaceLayout } from './workspaces';
import { agentActivity, recentActivity } from './activity';
import { WorkspaceFiles } from './files';
import { listHostFolders } from './folders';
import { SessionLifecycle, type DeleteSession } from './lifecycle';

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
  readonly workspaces: Workspaces;
  readonly files: WorkspaceFiles;
  readonly lifecycle: SessionLifecycle;
  constructor(readonly directory: string) {
    super(); this.socket = path.join(directory, 'tmux-ui.sock');
    this.lifecycle = new SessionLifecycle(directory, args => this.tmux(args), () => this.snapshot(false));
    this.workspaces = new Workspaces(directory, args => this.tmux(args), undefined, (cwd, id) => this.existingDesktopWorkspace(cwd, id), undefined,
      completedOnly => this.lifecycle.names(completedOnly));
    this.files = new WorkspaceFiles(() => this.snapshot(false));
    this.timer = setInterval(() => { void this.poll(); }, 1500); this.timer.unref();
  }
  private async tmux(args: string[]) {
    const { stdout } = await run('tmux', ['-S', this.socket, ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TMUX: '', TMUX_PANE: '' } }); return stdout.trim();
  }
  async snapshot(includeActivity = true): Promise<Snapshot> {
    // Timestamp the read boundary, not completion: a slow watch that began
    // before a mutation must never supersede that mutation's returned snapshot.
    const updatedAt = Date.now();
    let raw = '{"sessions":[]}', warning: string | undefined;
    try { raw = await readFile(path.join(this.directory, 'workbench-ui-state.json'), 'utf8'); parseSnapshot(raw, []); }
    catch {
      try { raw = await readFile(path.join(this.directory, 'workbench-ui-state.json.bak'), 'utf8'); parseSnapshot(raw, []); warning = 'Using the backup layout.'; }
      catch { raw = '{"sessions":[]}'; warning = 'No readable layout. Showing live Workbench sessions.'; }
    }
    try {
      const state = JSON.parse(raw);
      const remote = await this.workspaces.layouts();
      for (const layout of remote) {
        const existing = state.sessions.find((entry: { id?: string }) => entry.id === layout.id);
        if (!existing) { state.sessions.push(layout); continue; }
        // Phone-started tabs overlay the matching desktop workspace, without
        // modifying its saved layout or mixing files if its ID changed folders.
        if (await realpath(existing.cwd).catch(() => '') !== layout.cwd) continue;
        for (const key of ['harnesses', 'terminals'] as const) {
          const tabs = Array.isArray(existing[key]) ? existing[key] : [];
          const names = new Set(tabs.map((tab: { tmux?: string }) => tab.tmux));
          existing[key] = [...tabs, ...layout[key].filter(tab => !names.has(tab.tmux))];
        }
      }
      raw = JSON.stringify(state);
    } catch { warning = 'Could not read the phone workspace list. Desktop sessions are still available.'; }
    let names: string[] = [];
    try { names = (await this.tmux(['list-sessions', '-F', '#{session_name}'])).split('\n').filter(Boolean); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('tmux is not installed on this machine');
      if (!/no server running|No such file|Connection refused/.test(String(error))) throw error;
      warning = 'No sessions are running. Start a session from a workspace.';
    }
    const snapshot = parseSnapshot(raw, names, warning);
    snapshot.updatedAt = updatedAt;
    const deleted = await this.lifecycle.names(true);
    snapshot.workspaces = snapshot.workspaces.map(workspace => ({ ...workspace, panes: workspace.panes.filter(pane => !deleted.has(pane.tmux)) }))
      .filter(workspace => workspace.id !== '__unlisted' || workspace.panes.length > 0);
    if (!includeActivity) return snapshot;
    let recent = new Set<string>();
    const dead = new Set<string>();
    try {
      const activity = await this.tmux(['list-panes', '-a', '-F', '#{session_name}|#{window_activity}|#{pane_dead}']);
      recent = recentActivity(activity);
      const alive = new Set<string>();
      for (const line of activity.split('\n')) {
        const [session, , paneDead] = line.split('|');
        if (paneDead === '1') dead.add(session);
        else if (paneDead === '0') alive.add(session);
      }
      for (const session of alive) dead.delete(session);
    } catch {}
    const panes = snapshot.workspaces.flatMap(workspace => workspace.panes);
    // Retained startup diagnostics are not a running coding agent or shell.
    for (const pane of panes) if (dead.has(pane.tmux)) { pane.live = false; pane.activity = 'idle'; }
    const agents = panes.filter(pane => pane.kind === 'agent' && pane.live).slice(0, 64);
    // Captured content stays on the host; only status leaves. Bound concurrency.
    for (let index = 0; index < agents.length; index += 4) {
      await Promise.all(agents.slice(index, index + 4).map(async pane => {
        try {
          const content = await this.tmux(['capture-pane', '-p', '-t', '=' + pane.tmux + ':']);
          pane.activity = agentActivity(pane.harnessId, content, recent.has(pane.tmux));
        } catch { pane.activity = 'idle'; }
      }));
    }
    return snapshot;
  }
  async createWorkspace(request: NewWorkspace) {
    const layout = await this.workspaces.create(request);
    const snapshot = await this.snapshot();
    const workspace = snapshot.workspaces.find(item => item.id === layout.id);
    if (!workspace) throw new Error('Workspace was created but could not be listed. Refresh before retrying.');
    return { workspace, snapshot };
  }
  async deleteSession(request: DeleteSession) {
    await this.workspaces.exclusive(() => this.lifecycle.delete(request));
    return this.snapshot();
  }
  async startSession(request: StartSession) {
    const sessionId = await this.workspaces.start(request, async id => (await this.snapshot(false)).workspaces.find(workspace => workspace.id === id));
    return { sessionId, snapshot: await this.snapshot() };
  }
  private async existingDesktopWorkspace(cwd: string, id?: string): Promise<WorkspaceLayout | undefined> {
    let raw: string | undefined;
    for (const file of ['workbench-ui-state.json', 'workbench-ui-state.json.bak']) {
      try { const value = await readFile(path.join(this.directory, file), 'utf8'); parseSnapshot(value, []); raw = value; break; } catch {}
    }
    if (!raw) return;
    let live: string[] = [];
    try {
      live = (await this.tmux(['list-panes', '-a', '-F', '#{session_name}|#{pane_dead}']))
        .split('\n').filter(line => line.endsWith('|0')).map(line => line.slice(0, -2));
    } catch {}
    const deleted = await this.lifecycle.names(true);
    for (const workspace of parseSnapshot(raw, live).workspaces) {
      const intentionallyEmpty = workspace.panes.length > 0 && workspace.panes.every(pane => deleted.has(pane.tmux));
      if (!workspace.cwd || !path.isAbsolute(workspace.cwd) || workspace.id.length > 200 || /[\x00-\x1f\x7f]/.test(workspace.id) ||
        (id ? workspace.id !== id : !intentionallyEmpty && !workspace.panes.some(pane => pane.live && !deleted.has(pane.tmux)))) continue;
      try { if (await realpath(workspace.cwd) !== cwd) continue; } catch { continue; }
      const tab = (pane: typeof workspace.panes[number]) => ({ id: pane.id, name: pane.name, tmux: pane.tmux, cwd,
        ...(pane.harnessId ? { harnessId: pane.harnessId } : {}) });
      return { id: workspace.id, cwd, harnesses: workspace.panes.filter(pane => pane.kind === 'agent').map(tab),
        terminals: workspace.panes.filter(pane => pane.kind === 'terminal').map(tab) };
    }
  }
  listFolders(hostPath: unknown) { return listHostFolders(hostPath); }
  listFiles(workspaceId: unknown, relativePath: unknown) { return this.files.list(workspaceId, relativePath); }
  gitSummary(workspaceId: unknown) { return this.files.gitSummary(workspaceId); }
  readFile(workspaceId: unknown, relativePath: unknown, offset: unknown) { return this.files.read(workspaceId, relativePath, offset); }
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
