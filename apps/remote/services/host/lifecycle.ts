import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Snapshot } from '../../src/shared';

export interface DeleteSession { requestId: string; workspaceId: string; sessionId: string }
interface Identity { server: string; session: string; created: string }
interface Deletion extends DeleteSession { identity: Identity | null; complete: boolean }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// A separate ledger leaves Workbench's desktop layout and all workspace files
// untouched. Pending intent blocks launch; only confirmed deletion hides a tab.
export class SessionLifecycle {
  private readonly file: string;
  constructor(directory: string, private tmux: (args: string[]) => Promise<string>, private snapshot: () => Promise<Snapshot>) {
    this.file = path.join(directory, 'remote-session-deletions.json');
  }
  private async read(): Promise<Deletion[]> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Invalid deletion ledger');
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (!data || data.version !== 1 || !Array.isArray(data.deletions) || data.deletions.length > 10_000) throw new Error('Invalid deletion ledger');
      const ids = new Set<string>();
      for (const item of data.deletions) {
        const request = validateDelete(item);
        if (ids.has(request.requestId) || typeof item.complete !== 'boolean' ||
          (item.identity !== null && (!item.identity || typeof item.identity.server !== 'string' || !/^\d{1,20}$/.test(item.identity.server) ||
            typeof item.identity.session !== 'string' || !/^\$\d{1,20}$/.test(item.identity.session) || typeof item.identity.created !== 'string' || !/^\d{1,20}$/.test(item.identity.created)))) throw new Error('Invalid deletion ledger');
        ids.add(request.requestId);
      }
      return data.deletions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not read the session deletion history. Its file was left unchanged.');
    }
  }
  async names(completedOnly: boolean): Promise<Set<string>> {
    return new Set((await this.read()).filter(item => !completedOnly || item.complete).map(item => item.sessionId));
  }
  private async save(deletions: Deletion[]) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, deletions }, null, 2) + '\n');
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.file);
      // Persist both contents and the directory entry before any destructive
      // command. A process or OS restart must not lose the bound tmux identity.
      const directory = await open(path.dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private async identity(sessionId: string, physical = false): Promise<Identity | null> {
    try {
      // display-message may fall back to the current session for an absent
      // target. Enumerating and exact matching never binds that fallback.
      const rows = await this.tmux(['list-sessions', '-F', '#{pid}|#{session_id}|#{session_created}|#{session_name}']);
      const value = rows.split('\n').map(row => row.split('|')).find(row => row[physical ? 1 : 3] === sessionId);
      if (!value) return null;
      const [server, session, created] = value;
      if (!/^\d+$/.test(server) || !/^\$\d+$/.test(session) || !/^\d+$/.test(created)) throw new Error('Could not verify the exact session to delete.');
      return { server, session, created };
    } catch (error) {
      if (/can't find|no server running|No such file|Connection refused/.test(String(error))) return null;
      throw error;
    }
  }
  // Caller must serialize this with workspace creation. This prevents a pending
  // create from starting a pane after deletion observed that pane as absent.
  async delete(input: DeleteSession): Promise<void> {
    const request = validateDelete(input), records = await this.read();
    let record = records.find(item => item.requestId.toLowerCase() === request.requestId);
    if (record && (record.workspaceId !== request.workspaceId || record.sessionId !== request.sessionId)) throw new Error('This deletion request was already used for another session.');
    if (record?.complete) return;
    if (!record) {
      const previous = records.find(item => item.workspaceId === request.workspaceId && item.sessionId === request.sessionId);
      const known = previous || (await this.snapshot()).workspaces.some(workspace => workspace.id === request.workspaceId && workspace.panes.some(pane => pane.tmux === request.sessionId));
      if (!known) throw new Error('This session is not in this workspace. Refresh before deleting.');
      if (records.length >= 10_000) throw new Error('The session deletion history is full.');
      // A new phone request ID (for example after app restart) still refers to
      // the first intent's physical identity, never a replacement by that name.
      const bound = previous || records.find(item => item.sessionId === request.sessionId);
      record = { ...request, identity: bound ? bound.identity : await this.identity(request.sessionId), complete: bound?.complete ?? false };
      records.push(record);
      // Capture physical identity before the first attempt, never during a retry.
      await this.save(records);
      if (record.complete) return;
    }
    if (record.identity) {
      const target = record.identity;
      // if-shell -F evaluates inside tmux, and the action targets the immutable
      // session ID, not its reusable name. A restarted server or replaced name
      // cannot make an old deletion request kill a different session.
      const condition = `#{&&:#{==:#{pid},${target.server}},#{&&:#{==:#{session_id},${target.session}},#{==:#{session_created},${target.created}}}}`;
      try { await this.tmux(['if-shell', '-F', '-t', target.session, condition, `kill-session -t '${target.session}'`]); }
      catch (error) {
        const current = await this.identity(target.session, true);
        if (sameIdentity(current, target)) throw new Error('Could not stop this session. It remains visible; retry deleting it.');
      }
      if (sameIdentity(await this.identity(target.session, true), target)) throw new Error('The session has not stopped yet. It remains visible; retry deleting it.');
    }
    for (const item of records) if (item.sessionId === record.sessionId) item.complete = true;
    await this.save(records);
  }
}

function sameIdentity(left: Identity | null, right: Identity) {
  return left?.server === right.server && left.session === right.session && left.created === right.created;
}
function validateDelete(input: DeleteSession): DeleteSession {
  if (!input || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new Error('Invalid deletion request identifier.');
  if (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200 || /[\x00-\x1f\x7f]/.test(input.workspaceId)) throw new Error('Invalid workspace identifier.');
  if (typeof input.sessionId !== 'string' || input.sessionId.length > 200 || !/^workbench_[A-Za-z0-9_-]+$/.test(input.sessionId)) throw new Error('Invalid session identifier.');
  return { requestId: input.requestId.toLowerCase(), workspaceId: input.workspaceId, sessionId: input.sessionId };
}
