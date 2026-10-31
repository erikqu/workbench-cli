import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { hostFolder } from './folders';

export type SessionAgent = 'codex' | 'claude' | 'terminal';
export interface StartSession { requestId: string; workspaceId: string; agent: SessionAgent }
export interface NewWorkspace {
  requestId: string;
  name: string;
  parentDirectory: string;
  agent: SessionAgent | 'none';
  mode?: 'create' | 'open';
}
interface Tab { id: string; name: string; tmux: string; cwd: string; harnessId?: string }
export interface WorkspaceLayout { id: string; cwd: string; harnesses: Tab[]; terminals: Tab[] }
interface SavedWorkspace { request: NewWorkspace; layout: WorkspaceLayout; ready: boolean }
interface SavedReference { request: NewWorkspace; workspaceId: string; cwd: string }
interface SavedStart { request: StartSession; tab: Tab; attempted: boolean; ready: boolean }
interface Registry { version: 1; workspaces: SavedWorkspace[]; references?: SavedReference[]; starts?: SavedStart[] }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maximumWorkspaces = 1000;
class StartupFailure extends Error {}

// Workbench owns its in-memory desktop layout. Never edit its state file behind
// its back: the next desktop save would overwrite those edits (or vice versa).
export class Workspaces {
  private work: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly launches = new Map<string, string>();
  constructor(readonly directory: string, private tmux: (args: string[]) => Promise<string>, private findExecutable = executable,
    private existingWorkspace: (cwd: string, id?: string) => Promise<WorkspaceLayout | undefined> = async () => undefined,
    private homeDirectory = homedir(), private deletedNames: (completedOnly: boolean) => Promise<Set<string>> = async () => new Set()) {
    this.file = path.join(directory, 'remote-workspaces.json');
  }
  private async read(): Promise<Registry> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid workspace registry');
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      validateRegistry(data);
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: [] };
      throw new Error('Could not read the phone workspace list. Its file was left unchanged.');
    }
  }
  async layouts(): Promise<WorkspaceLayout[]> {
    const hidden = await this.deletedNames(true);
    return registryLayouts(await this.read()).map(layout => visibleLayout(layout, hidden));
  }
  private async save(registry: Registry) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(registry, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  create(request: NewWorkspace): Promise<WorkspaceLayout> {
    return this.exclusive(() => this.createSerialized(request));
  }
  start(request: StartSession, lookup?: (id: string) => Promise<{ id: string; cwd: string } | undefined>): Promise<string> {
    return this.exclusive(() => this.startSerialized(request, lookup));
  }
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.work.then(operation);
    this.work = result.catch(() => {});
    return result;
  }
  private async createSerialized(input: NewWorkspace): Promise<WorkspaceLayout> {
    const request = validateWorkspaceRequest(input);
    const hidden = await this.deletedNames(true), blocked = await this.deletedNames(false);
    const registry = await this.read(), records = registry.workspaces;
    if (registry.starts?.some(item => item.request.requestId.toLowerCase() === request.requestId)) throw new Error('This request identifier was already used to start a session.');
    let record = records.find(item => item.request.requestId.toLowerCase() === request.requestId);
    const reference = registry.references?.find(item => item.request.requestId.toLowerCase() === request.requestId);
    const original = record?.request || reference?.request;
    if (original && !sameRequest(original, request)) {
      throw new Error('This creation request was already used for a different workspace.');
    }
    if (record?.ready) return visibleLayout(record.layout, hidden); // Safe retry, never resurrect deleted tabs.
    if (reference) {
      const saved = records.find(item => item.layout.id === reference.workspaceId && item.layout.cwd === reference.cwd);
      if (saved && !saved.ready) throw new Error('This workspace is still being set up. Retry its original creation request before opening it.');
      const layout = saved?.layout || registryLayouts(registry).find(item => item.id === reference.workspaceId && item.cwd === reference.cwd) ||
        await this.existingWorkspace(reference.cwd, reference.workspaceId);
      if (!layout) throw new Error('The previously opened workspace is no longer available. Refresh the workspace list before opening it again.');
      return visibleLayout(layout, hidden);
    }

    let cwd: string | undefined;
    if (!record) {
      if (records.length + (registry.references?.length || 0) >= maximumWorkspaces) throw new Error('The phone workspace list is full.');
      const parent = await hostFolder(request.parentDirectory);
      if (request.mode === 'open') {
        cwd = await hostFolder(path.join(parent, request.name));
        if (cwd === path.parse(cwd).root) throw new Error('Choose a project folder, not the filesystem root.');
        const saved = records.find(item => item.layout.cwd === cwd);
        if (saved && !saved.ready) throw new Error('This workspace is still being set up. Retry its original creation request before opening it.');
        const existing = saved?.layout || registryLayouts(registry).find(item => item.cwd === cwd) || await this.existingWorkspace(cwd);
        if (existing) {
          (registry.references ||= []).push({ request, workspaceId: existing.id, cwd });
          await this.save(registry);
          return visibleLayout(existing, hidden);
        }
      } else cwd = path.join(parent, request.name);
    }

    const searchPath = this.searchPath();
    const needsAgent = isAgent(request.agent) && (!record || record.layout.harnesses.some(tab => !blocked.has(tab.tmux)));
    const agent = needsAgent ? await this.sessionExecutable(request.agent as SessionAgent, searchPath) : undefined;
    const shell = request.agent === 'none' ? '' : await this.sessionExecutable('terminal', searchPath);

    if (!record) {
      if (request.mode !== 'open') {
        try { await mkdir(cwd!, { mode: 0o755 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That folder already exists. Choose a new folder name; existing files will not be changed.');
          throw new Error('Could not create the folder. Check the parent location and its permissions.');
        }
      }
      const tab = (kind: 'h' | 't', name: string): Tab => ({ id: randomUUID(), cwd: cwd!, name, tmux: `workbench_${kind}_${randomUUID().replaceAll('-', '')}` });
      record = { request, ready: false, layout: { id: randomUUID(), cwd: cwd!,
        harnesses: agent ? [{ ...tab('h', agentName(request.agent)), harnessId: request.agent }] : [], terminals: request.agent === 'none' ? [] : [tab('t', 'Terminal 1')] } };
      records.push(record);
      // Persist identities before starting processes, so retries resume this
      // operation instead of creating duplicate agents or duplicate folders.
      try { await this.save(registry); }
      catch { throw new Error(request.mode === 'open' ? 'The existing folder was left unchanged, but its workspace could not be saved. No agent was started.' :
        `The folder was created at ${cwd}, but its workspace could not be saved. The folder was kept; no agent was started.`); }
    }
    // A pending operation may be retried after a restart. Do not launch into a
    // replacement symlink or recreate a removed folder behind the user's back.
    await this.verifyFolder(record.layout.cwd);
    try {
      let started = false;
      const launchTabs = [...record.layout.terminals, ...record.layout.harnesses].filter(tab => !blocked.has(tab.tmux));
      for (const tab of launchTabs) {
        let exists = false;
        try { await this.tmux(['has-session', '-t', '=' + tab.tmux]); exists = true; } catch {}
        // A user retry may restart a dead *pending* pane, never an existing live
        // pane or a ready workspace (which returned above without launching).
        if (!exists || (await this.paneState(tab)).dead) {
          const command = await this.launchCommand(tab, tab.harnessId ? agent! : shell, searchPath);
          // tmux expands formats in -c even when execFile avoids shell parsing.
          // Escape hashes so names such as "project #{pid}" remain literal.
          if (exists) await this.tmux(['respawn-pane', '-t', '=' + tab.tmux + ':', '-c', record.layout.cwd.replaceAll('#', '##'), command]);
          else await this.tmux(['new-session', '-d', '-s', tab.tmux, '-c', record.layout.cwd.replaceAll('#', '##'), '-x', '80', '-y', '24',
            '-e', 'PATH=' + searchPath, '-e', 'COLORTERM=truecolor', command]);
          await this.waitForLaunch(tab);
          started = true;
        }
      }
      if (started) await new Promise(resolve => setTimeout(resolve, 450));
      for (const tab of launchTabs) {
        const state = await this.paneState(tab);
        if (state.dead) {
          throw await this.startupFailure(tab, state.status, 'Retry this request after correcting the error.');
        }
      }
      record.ready = true;
      await this.save(registry);
      return visibleLayout(record.layout, hidden);
    } catch (error) {
      if (error instanceof StartupFailure) throw error;
      throw new Error('The folder was saved, but starting its sessions did not finish. Retry with the same name and location to continue safely.');
    }
  }
  private async startSerialized(input: StartSession, lookup?: (id: string) => Promise<{ id: string; cwd: string } | undefined>): Promise<string> {
    const request = validateStartRequest(input), registry = await this.read();
    if ([...registry.workspaces, ...(registry.references || [])].some(item => item.request.requestId.toLowerCase() === request.requestId)) {
      throw new Error('This request identifier was already used for a workspace.');
    }
    let record = registry.starts?.find(item => item.request.requestId.toLowerCase() === request.requestId);
    if (record && (record.request.workspaceId !== request.workspaceId || record.request.agent !== request.agent)) throw new Error('This start request was already used for a different session.');
    // A completed/lost-response retry only returns its old identity, even if the
    // process has since stopped or the user deleted its tab. Never resurrect it.
    if (record?.ready) return record.tab.tmux;
    if (record && (await this.deletedNames(false)).has(record.tab.tmux)) throw new Error('This session was deleted. Use Start again to create a new session.');
    const searchPath = this.searchPath();
    if (!record) {
      if ((registry.starts?.length || 0) >= 10_000) throw new Error('The phone session history is full.');
      const workspace = lookup ? await lookup(request.workspaceId) : registryLayouts(registry).find(item => item.id === request.workspaceId);
      if (!workspace || !workspace.cwd || !path.isAbsolute(workspace.cwd)) throw new Error('Choose an existing workspace before starting a session.');
      const cwd = await hostFolder(workspace.cwd);
      if (cwd === path.parse(cwd).root) throw new Error('Choose a project folder, not the filesystem root.');
      if (registryLayouts(registry).some(item => item.id === workspace.id && item.cwd !== cwd)) throw new Error('This workspace folder changed. Restore its original folder before starting a session.');
      // Resolve availability before writing intent; no process or project file
      // is changed if the selected CLI is missing.
      await this.sessionExecutable(request.agent, searchPath);
      const kind = request.agent === 'terminal' ? 't' : 'h';
      record = { request, ready: false, attempted: false, tab: { id: randomUUID(), cwd, name: agentName(request.agent),
        tmux: `workbench_${kind}_${randomUUID().replaceAll('-', '')}`, ...(isAgent(request.agent) ? { harnessId: request.agent } : {}) } };
      (registry.starts ||= []).push(record);
      await this.save(registry);
    }
    await this.verifyFolder(record.tab.cwd);
    if (!record.attempted) {
      const executable = await this.sessionExecutable(request.agent, searchPath);
      const command = await this.launchCommand(record.tab, executable, searchPath);
      // Persist before sending new-session. If the companion crashes in this
      // gap, retry must not mistake a vanished/failed process for an unattempted
      // launch. A fresh explicit Start is the recovery action, never respawn.
      record.attempted = true; await this.save(registry);
      try {
        await this.tmux(['new-session', '-d', '-s', record.tab.tmux, '-c', record.tab.cwd.replaceAll('#', '##'), '-x', '80', '-y', '24',
          '-e', 'PATH=' + searchPath, '-e', 'COLORTERM=truecolor', command]);
        await this.waitForLaunch(record.tab);
      } catch { throw new Error('Starting the session did not finish. Refresh to check it, then use Start again if needed. Existing sessions were left unchanged.'); }
    }
    // Exact existence check avoids display-message's missing-target fallback.
    try { await this.tmux(['has-session', '-t', '=' + record.tab.tmux]); }
    catch { throw new Error('This start was already attempted, but its session is no longer running. Use Start again to create a new session.'); }
    await new Promise(resolve => setTimeout(resolve, 450));
    const state = await this.paneState(record.tab);
    if (state.dead) throw await this.startupFailure(record.tab, state.status, 'After correcting the error, use Start again to create a new session.');
    record.ready = true; await this.save(registry);
    return record.tab.tmux;
  }
  private searchPath() {
    return [path.dirname(process.execPath), path.join(this.homeDirectory, '.bun/bin'), path.join(this.homeDirectory, '.local/bin'), process.env.PATH || '/usr/bin:/bin'].join(path.delimiter);
  }
  private async sessionExecutable(agent: SessionAgent, searchPath: string) {
    if (agent === 'terminal') return await this.findExecutable(process.env.SHELL || '/bin/sh', searchPath) || '/bin/sh';
    const executable = await this.findExecutable(agent, searchPath);
    if (!executable) throw new Error(`${agentName(agent)} is not installed on this machine. Choose Terminal only or install ${agentName(agent)} on the host.`);
    return executable;
  }
  private async verifyFolder(cwd: string) {
    try { if (!(await lstat(cwd)).isDirectory() || await realpath(cwd) !== cwd) throw new Error('Changed workspace folder'); }
    catch { throw new Error('The saved workspace folder was moved, removed, or replaced. Restore the original folder before retrying.'); }
  }
  private async startupFailure(tab: Tab, status: string, recovery: string) {
    let output = '';
    try { output = await this.tmux(['capture-pane', '-p', '-S', '-30', '-t', '=' + tab.tmux + ':']); } catch {}
    const diagnostic = stripVTControlCharacters(output).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(-3000);
    return new StartupFailure(`${tab.name} exited during startup${status ? ` (exit ${status})` : ''}. Your folder and other sessions were kept. ${recovery}${diagnostic ? '\n\n' + diagnostic : ''}`);
  }
  private async paneState(tab: Tab) {
    const value = await this.tmux(['display-message', '-p', '-t', '=' + tab.tmux + ':', '#{session_name}|#{pane_dead}|#{pane_dead_status}']);
    const prefix = tab.tmux + '|';
    const match = value.startsWith(prefix) ? /^([01])\|([0-9]*)$/.exec(value.slice(prefix.length)) : null;
    if (!match) throw new StartupFailure(`Could not verify ${tab.name} startup. Your workspace was kept; refresh before retrying.`);
    return { dead: match[1] === '1', status: match[2] };
  }
  private async launchCommand(tab: Tab, executable: string, searchPath: string) {
    const launch = randomUUID(); this.launches.set(tab.id, launch);
    let command = quote(executable);
    if (!tab.harnessId && path.basename(executable) === 'bash') {
      // Source the user's configuration, then restore the chosen workspace and
      // bundled Node path. Never modify ~/.bashrc, and never run it a second time.
      const rc = quote(path.join(this.homeDirectory, '.bashrc'));
      const content = `# Workbench Remote shell initializer\nif [ -r ${rc} ]; then . ${rc}; fi\nbuiltin export PATH=${quote(path.dirname(process.execPath))}:"$PATH":${quote(searchPath)}\nbuiltin cd -- ${quote(tab.cwd)} || exit 1\n`;
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
      const initializer = path.join(this.directory, `remote-bash-${tab.id}-${digest}.bash`);
      try { await writeFile(initializer, content, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await lstat(initializer);
        if (!info.isFile() || info.size !== Buffer.byteLength(content) || await readFile(initializer, 'utf8') !== content) throw new Error('The shell initializer changed unexpectedly.');
      }
      command += ` --noprofile --rcfile ${quote(initializer)} -i`;
    }
    // A tmux/default-shell startup can replace its -e PATH before the command
    // runs. Pin it inside the final shell, before executing node-based agents.
    // Retain this owned window *before* launching so immediate errors survive.
    const tmux = `tmux -S ${quote(path.join(this.directory, 'tmux-ui.sock'))} set-option -w -t ${quote('=' + tab.tmux + ':')}`;
    const script = `export PATH=${quote(searchPath)} COLORTERM=truecolor; ${tmux} remain-on-exit on || exit 1; cd -- ${quote(tab.cwd)} || exit 1; ${tmux} @workbench-remote-launch ${quote(launch)} || exit 1; exec ${command}`;
    return `/bin/sh -c ${quote(script)}`;
  }
  private async waitForLaunch(tab: Tab) {
    const launch = this.launches.get(tab.id);
    // Wait for this attempt's wrapper, rather than timing from new-session:
    // default-shell initialization may still be queued under CPU load.
    const deadline = Date.now() + 5000;
    try {
      while (Date.now() < deadline) {
        const marker = await this.tmux(['show-options', '-w', '-v', '-t', '=' + tab.tmux + ':', '@workbench-remote-launch']).catch(() => '');
        if (marker === launch || (await this.paneState(tab)).dead) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('The session shell did not finish starting. Refresh before starting another session.');
    } finally { this.launches.delete(tab.id); }
  }
}
function visibleLayout(layout: WorkspaceLayout, hidden: Set<string>): WorkspaceLayout {
  return { ...layout, harnesses: layout.harnesses.filter(tab => !hidden.has(tab.tmux)), terminals: layout.terminals.filter(tab => !hidden.has(tab.tmux)) };
}
function registryLayouts(registry: Registry): WorkspaceLayout[] {
  const layouts = new Map(registry.workspaces.map(item => [item.layout.id, { ...item.layout, harnesses: [...item.layout.harnesses], terminals: [...item.layout.terminals] }]));
  for (const start of registry.starts || []) {
    let layout = layouts.get(start.request.workspaceId);
    if (!layout) { layout = { id: start.request.workspaceId, cwd: start.tab.cwd, harnesses: [], terminals: [] }; layouts.set(layout.id, layout); }
    (start.request.agent === 'terminal' ? layout.terminals : layout.harnesses).push(start.tab);
  }
  return [...layouts.values()];
}
function isAgent(agent: string): agent is 'codex' | 'claude' { return agent === 'codex' || agent === 'claude'; }
function agentName(agent: string) { return agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'Terminal'; }
export function validateStartRequest(input: StartSession): StartSession {
  if (!input || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new Error('Invalid start request identifier.');
  if (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200 || /[\x00-\x1f\x7f]/.test(input.workspaceId) || input.workspaceId === '__unlisted') throw new Error('Choose an existing workspace.');
  if (!['codex', 'claude', 'terminal'].includes(input.agent)) throw new Error('Choose Codex, Claude, or Terminal.');
  return { requestId: input.requestId.toLowerCase(), workspaceId: input.workspaceId, agent: input.agent };
}

export function validateWorkspaceRequest(input: NewWorkspace): NewWorkspace {
  if (!input || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new Error('Invalid workspace request identifier.');
  const mode = input.mode === undefined ? 'create' : input.mode;
  if (mode !== 'create' && mode !== 'open') throw new Error('Choose whether to create or open a folder.');
  const maximumName = mode === 'open' ? 255 : 80;
  const name = typeof input.name === 'string' && mode === 'create' ? input.name.trim() : input.name;
  if (typeof name !== 'string' || !name || input.name.length > maximumName || /[\/\\\x00-\x1f\x7f]/.test(name) || ['.', '..'].includes(name)) {
    throw new Error(`Use a folder name of 1–${maximumName} characters without slashes or control characters.`);
  }
  if (typeof input.parentDirectory !== 'string' || input.parentDirectory.length > 4096 || /[\x00-\x1f\x7f]/.test(input.parentDirectory)) throw new Error('Invalid parent folder.');
  // Picker paths are exact filesystem names. Never trim a valid absolute path,
  // since a trailing space can be part of an existing parent folder's name.
  const parentDirectory = mode === 'open' || path.isAbsolute(input.parentDirectory) || input.parentDirectory.startsWith('~/')
    ? input.parentDirectory : input.parentDirectory.trim();
  if (!path.isAbsolute(parentDirectory) && parentDirectory !== '~' && !parentDirectory.startsWith('~/')) throw new Error('Use an absolute parent folder or a path starting with ~/.');
  if (!['codex', 'claude', 'terminal', 'none'].includes(input.agent)) throw new Error('Choose Codex, Claude, Terminal only, or No session.');
  return { requestId: input.requestId.toLowerCase(), name, parentDirectory, agent: input.agent, ...(mode === 'open' ? { mode } : {}) };
}
function sameRequest(left: NewWorkspace, right: NewWorkspace) {
  const first = validateWorkspaceRequest(left), second = validateWorkspaceRequest(right);
  return first.name === second.name && first.parentDirectory === second.parentDirectory && first.agent === second.agent && first.mode === second.mode;
}
async function executable(name: string, searchPath: string): Promise<string | undefined> {
  for (const candidate of path.isAbsolute(name) ? [name] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))) {
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, constants.X_OK); return candidate; } catch {}
  }
}
function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

function validateRegistry(data: unknown): asserts data is Registry {
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
      /[\x00-\x1f\x7f]/.test(layout.cwd) || !path.isAbsolute(layout.cwd) || path.normalize(layout.cwd) !== layout.cwd || layout.cwd === path.parse(layout.cwd).root ||
      (request.mode !== 'open' && path.basename(layout.cwd) !== request.name) || folders.has(layout.cwd) ||
      !Array.isArray(layout.harnesses) || layout.harnesses.length !== (isAgent(request.agent) ? 1 : 0) ||
      !Array.isArray(layout.terminals) || layout.terminals.length !== (request.agent === 'none' ? 0 : 1)) throw new Error('Invalid workspace layout');
    identity(layout.id); folders.add(layout.cwd);
    for (const [kind, tabs] of [['h', layout.harnesses], ['t', layout.terminals]] as const) {
      for (const tab of tabs) {
        if (!tab || typeof tab !== 'object' || typeof tab.tmux !== 'string' || !new RegExp(`^workbench_${kind}_[a-f0-9]{32}$`).test(tab.tmux) ||
          sessions.has(tab.tmux) || tab.cwd !== layout.cwd || tab.name !== (kind === 'h' ? agentName(request.agent) : 'Terminal 1') ||
          (kind === 'h' ? tab.harnessId !== request.agent : tab.harnessId !== undefined)) throw new Error('Invalid workspace tab');
        identity(tab.id); sessions.add(tab.tmux);
      }
    }
  }
  if ('references' in data && (!Array.isArray(data.references) || data.workspaces.length + data.references.length > maximumWorkspaces)) throw new Error('Invalid workspace references');
  for (const reference of ('references' in data ? data.references : []) as SavedReference[]) {
    if (!reference || typeof reference !== 'object') throw new Error('Invalid workspace reference');
    const request = validateWorkspaceRequest(reference.request);
    if (request.mode !== 'open' || requests.has(request.requestId) || typeof reference.workspaceId !== 'string' || !reference.workspaceId ||
      reference.workspaceId.length > 200 || /[\x00-\x1f\x7f]/.test(reference.workspaceId) ||
      typeof reference.cwd !== 'string' || reference.cwd.length > 4096 || !path.isAbsolute(reference.cwd) || path.normalize(reference.cwd) !== reference.cwd || reference.cwd === path.parse(reference.cwd).root ||
      /[\x00-\x1f\x7f]/.test(reference.cwd)) throw new Error('Invalid workspace reference');
    requests.add(request.requestId);
  }
  if ('starts' in data && (!Array.isArray(data.starts) || data.starts.length > 10_000)) throw new Error('Invalid session starts');
  const workspaceFolders = new Map((data.workspaces as SavedWorkspace[]).map(item => [item.layout.id, item.layout.cwd]));
  for (const start of ('starts' in data ? data.starts : []) as SavedStart[]) {
    if (!start || typeof start !== 'object' || typeof start.attempted !== 'boolean' || typeof start.ready !== 'boolean' || (start.ready && !start.attempted)) throw new Error('Invalid session start');
    const request = validateStartRequest(start.request), tab = start.tab;
    if (requests.has(request.requestId)) throw new Error('Duplicate session request');
    requests.add(request.requestId);
    const kind = request.agent === 'terminal' ? 't' : 'h';
    if (!tab || typeof tab !== 'object' || typeof tab.cwd !== 'string' || tab.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(tab.cwd) ||
      !path.isAbsolute(tab.cwd) || path.normalize(tab.cwd) !== tab.cwd || tab.cwd === path.parse(tab.cwd).root ||
      (workspaceFolders.has(request.workspaceId) && workspaceFolders.get(request.workspaceId) !== tab.cwd) ||
      typeof tab.tmux !== 'string' || !new RegExp(`^workbench_${kind}_[a-f0-9]{32}$`).test(tab.tmux) || sessions.has(tab.tmux) ||
      tab.name !== agentName(request.agent) || (kind === 'h' ? tab.harnessId !== request.agent : tab.harnessId !== undefined)) throw new Error('Invalid started session');
    identity(tab.id); sessions.add(tab.tmux); workspaceFolders.set(request.workspaceId, tab.cwd);
  }
}
