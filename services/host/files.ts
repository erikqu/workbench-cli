import { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Snapshot } from '../../src/shared';
import type { DirectoryListing, FileChunk } from '../shared/protocol';

export const FILE_CHUNK_BYTES = 192 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 500;

function relativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('Use a relative path inside this workspace.');
  }
  if (value.split('/').some(part => part === '..')) throw new Error('Paths cannot leave the workspace.');
  return value.split('/').filter(part => part && part !== '.').join('/');
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function fileVersion(info: BigIntStats): string {
  // Nanosecond metadata catches same-sized edits and replacement inodes across
  // separate chunk requests without rereading or hashing the full file content.
  return createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')).digest('base64url');
}

function accessError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') throw new Error('This file or folder no longer exists. Refresh the file list.');
  if (code === 'EACCES' || code === 'EPERM') throw new Error('The host does not have permission to read this file or folder.');
  if (code === 'ENOTDIR') throw new Error('This path is not a folder.');
  if (code === 'ELOOP') throw new Error('Symbolic links cannot be opened in the file viewer.');
  if (code) throw new Error('Could not read this file or folder.');
  throw error;
}

/** Read-only access, rooted in a workspace that is present in the authenticated snapshot. */
export class WorkspaceFiles {
  constructor(private snapshot: () => Promise<Snapshot>) {}

  private async resolve(workspaceId: unknown, value: unknown) {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 200) throw new Error('Invalid workspace.');
    const relative = relativePath(value);
    const workspace = (await this.snapshot()).workspaces.find(item => item.id === workspaceId);
    if (!workspace) throw new Error('This workspace is no longer available. Refresh the workspace list.');
    if (!workspace.cwd || !path.isAbsolute(workspace.cwd)) throw new Error('This workspace has no readable folder.');
    const root = await realpath(workspace.cwd);
    if (root === path.parse(root).root || !(await stat(root)).isDirectory()) throw new Error('This workspace has no readable folder.');
    let target = root;
    // Block symlink traversal even when the link currently points inside the root.
    // That also avoids silently following a link whose destination changes later.
    for (const component of relative.split('/').filter(Boolean)) {
      target = path.join(target, component);
      if ((await lstat(target)).isSymbolicLink()) throw new Error('Symbolic links cannot be opened in the file viewer.');
    }
    const canonical = await realpath(target);
    if (!contains(root, canonical)) throw new Error('Paths cannot leave the workspace.');
    return { root, target: canonical, relative };
  }

  private async verify(handle: FileHandle, root: string, target: string) {
    // On Linux the descriptor itself reveals the opened target, including parent
    // directories swapped between validation and open. Never read before this check.
    if (process.platform === 'linux') {
      const actual = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!contains(root, actual) || actual !== target) throw new Error('The file location changed. Refresh the file list.');
    }
    const [actual, held, current] = await Promise.all([realpath(target), handle.stat({ bigint: true }), lstat(target, { bigint: true })]);
    if (!contains(root, actual) || actual !== target || current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino) {
      throw new Error('The file location changed. Refresh the file list.');
    }
    return held;
  }

  async list(workspaceId: unknown, value: unknown): Promise<DirectoryListing> {
    let handle: FileHandle | undefined;
    try {
      const { root, target, relative } = await this.resolve(workspaceId, value);
      handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await this.verify(handle, root, target);
      // Directory descriptors keep Linux listings anchored during rename races.
      const anchored = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : target;
      const directory = await opendir(anchored);
      const entries: DirectoryListing['entries'] = [];
      let truncated = false, encodedBytes = 0, scanned = 0;
      for await (const entry of directory) {
        if (++scanned > MAX_DIRECTORY_ENTRIES * 4) { truncated = true; break; }
        if (/[\x00-\x1f\x7f\\]/.test(entry.name)) continue;
        if (entries.length === MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        try {
          const info = await lstat(path.join(anchored, entry.name));
          if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) continue;
          const item: DirectoryListing['entries'][number] = { name: entry.name, path: [relative, entry.name].filter(Boolean).join('/'),
            kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', size: info.size };
          encodedBytes += Buffer.byteLength(JSON.stringify(item));
          if (encodedBytes > 512 * 1024) { truncated = true; break; }
          entries.push(item);
        } catch (error) {
          // Files may disappear between readdir and lstat while an agent works.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await this.verify(handle, root, target);
      entries.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory') || left.name.localeCompare(right.name));
      return { path: relative, entries, truncated };
    } catch (error) { return accessError(error); }
    finally { await handle?.close(); }
  }

  async read(workspaceId: unknown, value: unknown, offset: unknown): Promise<FileChunk> {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid file offset.');
    let handle: FileHandle | undefined;
    try {
      const { root, target, relative } = await this.resolve(workspaceId, value);
      // O_NONBLOCK prevents a substituted FIFO/device from blocking before fstat.
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await this.verify(handle, root, target);
      if (!info.isFile()) throw new Error('Only regular files can be opened in the file viewer.');
      if (info.size > MAX_FILE_BYTES) throw new Error('This file is larger than the 20 MiB preview limit.');
      const size = Number(info.size), version = fileVersion(info);
      if (offset > size) throw new Error('The file changed or the offset is invalid. Open it again.');
      const data = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, size - offset));
      const { bytesRead } = await handle.read(data, 0, data.length, offset);
      const after = await this.verify(handle, root, target);
      if (fileVersion(after) !== version) throw new Error('The file changed while reading. Open it again.');
      return { path: relative, size, version, offset, nextOffset: offset + bytesRead,
        data: data.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= size };
    } catch (error) { return accessError(error); }
    finally { await handle?.close(); }
  }
}
