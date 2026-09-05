import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HostConfiguration } from '../shared/protocol';
export const configPath = () => process.env.WORKBENCH_REMOTE_CONFIG || path.join(homedir(), '.config', 'workbench-remote', 'host.json');
export async function loadConfig(): Promise<HostConfiguration | undefined> {
  try { return JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function saveConfig(config: HostConfiguration) {
  const file = configPath(); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 }); await rename(file + '.tmp', file);
}
