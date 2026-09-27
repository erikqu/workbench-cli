// Read-only compatibility check on a machine running Workbench. No SSH credentials needed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseSnapshot } from '../src/discovery';
const directory = process.argv[2] || path.join(homedir(), '.workbench');
const raw = readFileSync(path.join(directory, 'workbench-ui-state.json'), 'utf8');
const live = execFileSync('tmux', ['-S', path.join(directory, 'tmux-ui.sock'), 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim().split('\n');
const snapshot = parseSnapshot(raw, live);
console.log(JSON.stringify({ workspaces: snapshot.workspaces.length,
  liveSessions: snapshot.workspaces.flatMap(w => w.panes).filter(p => p.live).length,
  offlineSessions: snapshot.workspaces.flatMap(w => w.panes).filter(p => !p.live).length }, null, 2));
