import type { Snapshot, Workspace, Pane } from './shared';

export function quote(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid path');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function remoteDirectory(value: string): string {
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) return '"$HOME"/' + quote(value.slice(2));
  if (!value.startsWith('/')) throw new Error('Workbench directory must be absolute or start with ~/');
  return quote(value);
}
export function socketArg(directory: string): string {
  return remoteDirectory(directory.replace(/\/$/, '') + '/tmux-ui.sock');
}
export function attachCommand(directory: string, name: string): string {
  if (!/^workbench_[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid Workbench session name');
  // No -d/-D: other clients stay attached. Closing SSH only detaches this client.
  return `unset TMUX TMUX_PANE; exec tmux -S ${socketArg(directory)} attach-session -t ${quote('=' + name)}`;
}
export function discoveryCommands(directory: string) {
  return {
    state: `cat -- ${remoteDirectory(directory.replace(/\/$/, '') + '/workbench-ui-state.json')}`,
    backup: `cat -- ${remoteDirectory(directory.replace(/\/$/, '') + '/workbench-ui-state.json.bak')}`,
    live: `tmux -S ${socketArg(directory)} list-sessions -F '#{session_name}'`,
  };
}
export function parseSnapshot(raw: string, liveNames: string[], warning?: string): Snapshot {
  const state = JSON.parse(raw);
  if (!state || !Array.isArray(state.sessions)) throw new Error('Invalid Workbench layout: sessions array missing');
  const live = new Set(liveNames);
  const mapped = new Set<string>();
  const workspaces: Workspace[] = state.sessions.map((entry: any, index: number) => {
    if (!entry || typeof entry.cwd !== 'string') throw new Error('Invalid workspace path in Workbench layout');
    const panes: Pane[] = [];
    for (const [key, kind] of [['harnesses', 'agent'], ['terminals', 'terminal']] as const) {
      for (const tab of Array.isArray(entry[key]) ? entry[key] : []) {
        if (typeof tab.tmux !== 'string' || !/^workbench_[A-Za-z0-9_-]+$/.test(tab.tmux)) continue;
        mapped.add(tab.tmux);
        panes.push({ id: tab.tmux, tmux: tab.tmux, kind, live: live.has(tab.tmux),
          ...(typeof tab.harnessId === 'string' ? { harnessId: tab.harnessId } : {}),
          name: typeof tab.name === 'string' ? tab.name : kind === 'agent' ? String(tab.harnessId || 'Agent') : 'Terminal' });
      }
    }
    return { id: String(entry.id || `workspace-${index}`), cwd: entry.cwd,
      name: entry.cwd.replace(/\/+$/, '').split('/').pop() || entry.cwd, panes };
  });
  const unmapped = liveNames.filter(name => /^workbench_[A-Za-z0-9_-]+$/.test(name) && !mapped.has(name));
  if (unmapped.length) workspaces.push({ id: '__unlisted', name: 'Other live sessions', cwd: '',
    panes: unmapped.map(name => ({ id: name, tmux: name, name, kind: name.startsWith('workbench_h_') ? 'agent' : 'terminal', live: true })) });
  return { workspaces, warning, updatedAt: Date.now() };
}
