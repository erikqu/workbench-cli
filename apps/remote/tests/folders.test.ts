import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { hostFolder, listHostFolders } from '../services/host/folders';

test('host folder picker navigates canonical directories without returning file contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-folder-picker-'));
  try {
    await mkdir(path.join(root, 'Child folder')); await mkdir(path.join(root, '.hidden'));
    await mkdir(path.join(root, 'Child folder', 'nested'));
    await writeFile(path.join(root, 'private.txt'), 'Never a listing payload');
    await symlink(path.join(root, 'Child folder'), path.join(root, 'Folder alias'));
    await symlink(path.join(root, 'private.txt'), path.join(root, 'File alias'));
    await symlink(path.join(root, 'missing'), path.join(root, 'Broken alias'));
    const canonical = await realpath(root), result = await listHostFolders(root);
    assert.equal(result.path, canonical);
    assert.equal(result.parentPath, path.dirname(canonical));
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries.map(entry => entry.name), ['.hidden', 'Child folder', 'Folder alias']);
    assert.equal(result.entries.find(entry => entry.name === 'Folder alias')?.path, path.join(canonical, 'Child folder'));
    const child = await listHostFolders(path.join(root, 'Folder alias'));
    assert.equal(child.path, path.join(canonical, 'Child folder'));
    assert.equal(child.parentPath, canonical);
    assert.deepEqual(child.entries, [{ name: 'nested', path: path.join(canonical, 'Child folder', 'nested') }]);
    assert.equal(await readFile(path.join(root, 'private.txt'), 'utf8'), 'Never a listing payload');
    assert.equal(await hostFolder('~'), await realpath(homedir()));
    const filesystemRoot = await listHostFolders(path.parse(root).root);
    assert.equal(filesystemRoot.parentPath, null);
    assert.ok(filesystemRoot.entries.every(entry => path.isAbsolute(entry.path)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host folder picker rejects malformed and inaccessible paths clearly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-folder-errors-'));
  const blocked = path.join(root, 'blocked'); await mkdir(blocked);
  try {
    for (const value of [null, '', 'relative/path', '~someone', '/tmp\n', '/tmp\0', '/'.repeat(4097)]) {
      await assert.rejects(listHostFolders(value), /Invalid|absolute/);
    }
    await writeFile(path.join(root, 'file.txt'), 'not a folder');
    await assert.rejects(listHostFolders(path.join(root, 'file.txt')), /not a folder/);
    await assert.rejects(listHostFolders(path.join(root, 'missing')), /no longer exists/);
    if (process.getuid?.() !== 0) {
      await chmod(blocked, 0o000);
      await assert.rejects(listHostFolders(blocked), /permission/);
      assert.equal((await listHostFolders(root)).entries.some(entry => entry.name === 'blocked'), false);
    }
  } finally { await chmod(blocked, 0o700); await rm(root, { recursive: true, force: true }); }
});

test('host directory listings cap entry counts and serialized response size', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-folder-bounds-'));
  try {
    await Promise.all(Array.from({ length: 505 }, (_, index) => mkdir(path.join(root, `folder-${String(index).padStart(4, '0')}`))));
    const result = await listHostFolders(root);
    assert.equal(result.entries.length, 500); assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
    let deep = path.join(root, 'deep'); await mkdir(deep);
    for (let depth = 0; depth < 4; depth++) { deep = path.join(deep, 'long-folder-name-'.repeat(10)); await mkdir(deep); }
    await Promise.all(Array.from({ length: 500 }, (_, index) => mkdir(path.join(deep, 'entry-' + index + '-' + 'x'.repeat(190)))));
    const bounded = await listHostFolders(deep);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.entries.length < 500);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 512 * 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});
