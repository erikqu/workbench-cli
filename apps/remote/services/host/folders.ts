import { access, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FolderListing } from '../shared/protocol';

const maximumEntries = 500;
const maximumBytes = 512 * 1024;

export async function hostFolder(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) throw new Error('Invalid host folder path.');
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error('Use an absolute host folder or a path starting with ~/.');
  try {
    const canonical = await realpath(expanded);
    if (canonical.length > 4096 || /[\x00-\x1f\x7f\\]/.test(canonical)) throw new Error('This folder path is not supported.');
    if (!(await stat(canonical)).isDirectory()) throw new Error('This path is not a folder.');
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (error) { return folderError(error); }
}

export async function listHostFolders(value: unknown): Promise<FolderListing> {
  try {
    const canonical = await hostFolder(value);
    const parent = path.dirname(canonical);
    const result: FolderListing = { path: canonical, parentPath: parent === canonical ? null : parent, entries: [], truncated: false };
    let scanned = 0, bytes = Buffer.byteLength(JSON.stringify(result));
    const directory = await opendir(canonical);
    for await (const entry of directory) {
      if (++scanned > maximumEntries * 4) { result.truncated = true; break; }
      if (/[\x00-\x1f\x7f\\]/.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      let target: string;
      try { target = await hostFolder(path.join(canonical, entry.name)); }
      catch { continue; } // Unreadable, disappearing or broken-link children cannot be selected.
      const item = { name: entry.name, path: target };
      const encoded = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (result.entries.length >= maximumEntries || bytes + encoded > maximumBytes) { result.truncated = true; break; }
      result.entries.push(item); bytes += encoded;
    }
    result.entries.sort((left, right) => left.name.localeCompare(right.name));
    return result;
  } catch (error) { return folderError(error); }
}

function folderError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') throw new Error('This host folder no longer exists. Refresh or choose another folder.');
  if (code === 'EACCES' || code === 'EPERM') throw new Error('The host does not have permission to open this folder. Choose another folder.');
  if (code === 'ENOTDIR') throw new Error('This path is not a folder.');
  if (code === 'ELOOP') throw new Error('This folder contains a broken symbolic link.');
  if (code) throw new Error('Could not open this host folder. Check its path and permissions.');
  throw error;
}
