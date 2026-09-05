import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NewWorkspace {
  requestId: string;
  name: string;
  parentDirectory: string;
  agent: 'codex' | 'terminal';
}
interface Tab { id: string; name: string; tmux: string; cwd: string; harnessId?: string }
export interface WorkspaceLayout { id: string; cwd: string; harnesses: Tab[]; terminals: Tab[] }
interface SavedWorkspace { request: NewWorkspace; layout: WorkspaceLayout; ready: boolean }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maximumWorkspaces = 1000;

// Workbench owns its in-memory desktop layout. Never edit its state file behind
// its back: the next desktop save would overwrite those edits (or vice versa).
export class Workspaces {
  private work: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(readonly directory: string, private tmux: (args: string[]) => Promise<string>, private findExecutable = executable) {
    this.file = path.join(directory, 'remote-workspaces.json');
  }
  private async read(): Promise<SavedWorkspace[]> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid workspace registry');
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      validateRegistry(data);
      return data.workspaces;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not read the phone workspace list. Its file was left unchanged.');
    }
  }
  async layouts(): Promise<WorkspaceLayout[]> { return (await this.read()).map(item => item.layout); }
  private async save(workspaces: SavedWorkspace[]) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, workspaces }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }
  create(request: NewWorkspace): Promise<WorkspaceLayout> {
    const result = this.work.then(() => this.createSerialized(request));
    this.work = result.catch(() => {});
    return result;
  }
  private async createSerialized(input: NewWorkspace): Promise<WorkspaceLayout> {
    const request = validateWorkspaceRequest(input);
    const records = await this.read();
    let record = records.find(item => item.request.requestId === request.requestId);
    if (record && (record.request.name !== request.name || record.request.parentDirectory !== request.parentDirectory || record.request.agent !== request.agent)) {
      throw new Error('This creation request was already used for a different workspace.');
    }
    if (record?.ready) return record.layout; // Safe retry after a lost response, including after a restart.

    const searchPath = [path.dirname(process.execPath), path.join(homedir(), '.bun/bin'), path.join(homedir(), '.local/bin'), process.env.PATH || '/usr/bin:/bin'].join(path.delimiter);
    const agent = request.agent === 'codex' ? await this.findExecutable('codex', searchPath) : undefined;
    if (request.agent === 'codex' && !agent) throw new Error('Codex is not installed on this machine. Choose Terminal only or install Codex on the host.');
    const shell = await this.findExecutable(process.env.SHELL || '/bin/sh', searchPath) || '/bin/sh';

    if (!record) {
      if (records.length >= maximumWorkspaces) throw new Error('The phone workspace list is full.');
      const expanded = request.parentDirectory === '~' ? homedir() : request.parentDirectory.startsWith('~/')
        ? path.join(homedir(), request.parentDirectory.slice(2)) : request.parentDirectory;
      let parent: string;
      try { parent = await realpath(expanded); }
      catch { throw new Error('The parent folder does not exist or cannot be opened on this machine.'); }
      const cwd = path.join(parent, request.name);
      try { await mkdir(cwd, { mode: 0o755 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That folder already exists. Choose a new folder name; existing files will not be changed.');
        throw new Error('Could not create the folder. Check the parent location and its permissions.');
      }
      const tab = (kind: 'h' | 't', name: string): Tab => ({ id: randomUUID(), cwd, name, tmux: `workbench_${kind}_${randomUUID().replaceAll('-', '')}` });
      record = { request, ready: false, layout: { id: randomUUID(), cwd,
        harnesses: agent ? [{ ...tab('h', 'Codex'), harnessId: 'codex' }] : [], terminals: [tab('t', 'Terminal 1')] } };
      records.push(record);
      // Persist identities before starting processes, so retries resume this
      // operation instead of creating duplicate agents or duplicate folders.
      try { await this.save(records); }
      catch { throw new Error(`The folder was created at ${cwd}, but its workspace could not be saved. The folder was kept; no agent was started.`); }
    }
    // A pending operation may be retried after a restart. Do not launch into a
    // replacement symlink or recreate a removed folder behind the user's back.
    try {
      if (!(await lstat(record.layout.cwd)).isDirectory() || await realpath(record.layout.cwd) !== record.layout.cwd) throw new Error('Changed workspace folder');
    } catch { throw new Error('The saved workspace folder was moved, removed, or replaced. Restore the original folder before retrying.'); }
    try {
      for (const tab of [...record.layout.terminals, ...record.layout.harnesses]) {
        let exists = false;
        try { await this.tmux(['has-session', '-t', '=' + tab.tmux]); exists = true; } catch {}
        if (!exists) {
          const command = tab.harnessId ? agent! : shell;
          // tmux expands formats in -c even when execFile avoids shell parsing.
          // Escape hashes so names such as "project #{pid}" remain literal.
          await this.tmux(['new-session', '-d', '-s', tab.tmux, '-c', record.layout.cwd.replaceAll('#', '##'), '-x', '80', '-y', '24',
            '-e', 'PATH=' + searchPath, '-e', 'COLORTERM=truecolor', quote(command)]);
        }
      }
      record.ready = true;
      await this.save(records);
      return record.layout;
    } catch {
      throw new Error('The folder was saved, but starting its sessions did not finish. Retry with the same name and location to continue safely.');
    }
  }
}

export function validateWorkspaceRequest(input: NewWorkspace): NewWorkspace {
  if (!input || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new Error('Invalid workspace request identifier.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\/\\\x00-\x1f\x7f]/.test(input.name) || ['.', '..'].includes(input.name.trim())) {
    throw new Error('Use a folder name of 1–80 characters without slashes or control characters.');
  }
  if (typeof input.parentDirectory !== 'string' || input.parentDirectory.length > 2048 || /[\x00-\x1f\x7f]/.test(input.parentDirectory)) throw new Error('Invalid parent folder.');
  const parentDirectory = input.parentDirectory.trim();
  if (!path.isAbsolute(parentDirectory) && parentDirectory !== '~' && !parentDirectory.startsWith('~/')) throw new Error('Use an absolute parent folder or a path starting with ~/.');
  if (!['codex', 'terminal'].includes(input.agent)) throw new Error('Choose Codex or Terminal only.');
  return { requestId: input.requestId.toLowerCase(), name: input.name.trim(), parentDirectory, agent: input.agent };
}
async function executable(name: string, searchPath: string): Promise<string | undefined> {
  for (const candidate of path.isAbsolute(name) ? [name] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))) {
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, constants.X_OK); return candidate; } catch {}
  }
}
function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

function validateRegistry(data: unknown): asserts data is { version: 1; workspaces: SavedWorkspace[] } {
  if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('workspaces' in data) ||
    !Array.isArray(data.workspaces) || data.workspaces.length > maximumWorkspaces) throw new Error('Invalid workspace registry');
  const requests = new Set<string>(), identities = new Set<string>(), sessions = new Set<string>(), folders = new Set<string>();
  const identity = (value: unknown) => {
    if (typeof value !== 'string' || !uuid.test(value) || identities.has(value.toLowerCase())) throw new Error('Invalid workspace identity');
    identities.add(value.toLowerCase());
  };
  for (const item of data.workspaces) {
    if (!item || typeof item !== 'object' || typeof item.ready !== 'boolean') throw new Error('Invalid workspace entry');
    const request = validateWorkspaceRequest(item.request);
    if (requests.has(request.requestId)) throw new Error('Duplicate workspace request');
    requests.add(request.requestId);
    const layout = item.layout;
    if (!layout || typeof layout !== 'object' || typeof layout.cwd !== 'string' || layout.cwd.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(layout.cwd) || !path.isAbsolute(layout.cwd) || path.normalize(layout.cwd) !== layout.cwd ||
      path.basename(layout.cwd) !== request.name || folders.has(layout.cwd) ||
      !Array.isArray(layout.harnesses) || layout.harnesses.length !== (request.agent === 'codex' ? 1 : 0) ||
      !Array.isArray(layout.terminals) || layout.terminals.length !== 1) throw new Error('Invalid workspace layout');
    identity(layout.id); folders.add(layout.cwd);
    for (const [kind, tabs] of [['h', layout.harnesses], ['t', layout.terminals]] as const) {
      for (const tab of tabs) {
        if (!tab || typeof tab !== 'object' || typeof tab.tmux !== 'string' || !new RegExp(`^workbench_${kind}_[a-f0-9]{32}$`).test(tab.tmux) ||
          sessions.has(tab.tmux) || tab.cwd !== layout.cwd || tab.name !== (kind === 'h' ? 'Codex' : 'Terminal 1') ||
          (kind === 'h' ? tab.harnessId !== 'codex' : tab.harnessId !== undefined)) throw new Error('Invalid workspace tab');
        identity(tab.id); sessions.add(tab.tmux);
      }
    }
  }
}
