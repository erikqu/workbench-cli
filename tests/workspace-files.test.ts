import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FILE_CHUNK_BYTES, MAX_DIRECTORY_ENTRIES, MAX_FILE_BYTES, WorkspaceFiles } from '../services/host/files';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const files = new WorkspaceFiles(async () => ({ workspaces: [{ id: 'fixture', name: 'Fixture', cwd: root, panes: [] }], updatedAt: 0 }));
  return { directory, root, files };
}

test('workspace file listings support nested folders, hidden files, and binary metadata', async t => {
  const { root, files } = await fixture(t);
  await mkdir(path.join(root, 'images'));
  await writeFile(path.join(root, 'images', 'sample.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
  await writeFile(path.join(root, 'readme.md'), 'Hello');
  const listing = await files.list('fixture', '');
  assert.equal(listing.path, '');
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.map(entry => [entry.name, entry.kind]), [['images', 'directory'], ['.gitignore', 'file'], ['readme.md', 'file']]);
  assert.deepEqual(await files.list('fixture', './images/'), {
    path: 'images', entries: [{ name: 'sample.png', path: 'images/sample.png', kind: 'file', size: 4 }], truncated: false
  });
});

test('file chunks reconstruct image and arbitrary binary bytes without UTF-8 corruption', async t => {
  const { root, files } = await fixture(t);
  const bytes = randomBytes(FILE_CHUNK_BYTES * 2 + 791);
  await writeFile(path.join(root, 'image.png'), bytes);
  const chunks: Buffer[] = [];
  let offset = 0, version: string | undefined;
  for (;;) {
    const chunk = await files.read('fixture', 'image.png', offset);
    const decoded = Buffer.from(chunk.data, 'base64');
    assert.equal(chunk.path, 'image.png');
    assert.equal(chunk.size, bytes.length);
    assert.equal(chunk.offset, offset);
    assert.match(chunk.version, /^[A-Za-z0-9_-]{43}$/);
    version ??= chunk.version;
    assert.equal(chunk.version, version);
    assert.ok(decoded.length <= FILE_CHUNK_BYTES);
    assert.equal(chunk.nextOffset, offset + decoded.length);
    chunks.push(decoded);
    offset = chunk.nextOffset;
    if (chunk.eof) break;
    assert.ok(decoded.length > 0);
  }
  assert.equal(chunks.length, 3);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.deepEqual(await files.read('fixture', 'image.png', bytes.length), {
    path: 'image.png', size: bytes.length, version, offset: bytes.length, nextOffset: bytes.length, data: '', eof: true
  });
  await writeFile(path.join(root, 'empty'), '');
  assert.equal((await files.read('fixture', 'empty', 0)).eof, true);
});

test('file versions change after same-sized edits and replacements between chunk requests', async t => {
  const { root, files } = await fixture(t);
  const target = path.join(root, 'mutable.bin');
  await writeFile(target, Buffer.alloc(FILE_CHUNK_BYTES + 10, 1));
  const first = await files.read('fixture', 'mutable.bin', 0);
  await writeFile(target, Buffer.alloc(FILE_CHUNK_BYTES + 10, 2));
  const edited = await files.read('fixture', 'mutable.bin', first.nextOffset);
  assert.equal(edited.size, first.size);
  assert.notEqual(edited.version, first.version);
  assert.deepEqual(Buffer.from(edited.data, 'base64'), Buffer.alloc(10, 2));
  await writeFile(path.join(root, 'replacement.bin'), Buffer.alloc(FILE_CHUNK_BYTES + 10, 2));
  await rename(path.join(root, 'replacement.bin'), target);
  const replaced = await files.read('fixture', 'mutable.bin', first.nextOffset);
  assert.equal(replaced.size, edited.size);
  assert.notEqual(replaced.version, edited.version);
});

test('file viewer rejects traversal, absolute paths, control characters, and unknown workspaces', async t => {
  const { files } = await fixture(t);
  for (const invalid of ['../secret', 'nested/../../secret', 'nested/../secret', '/etc/passwd', 'C:/Windows', 'C:\\Windows', 'nested\\secret', 'zero\0byte', 'line\nfeed', 'tab\tname', 'del\x7f', 'x'.repeat(4097), null, 123]) {
    await assert.rejects(files.list('fixture', invalid), /relative path|cannot leave/);
    await assert.rejects(files.read('fixture', invalid, 0), /relative path|cannot leave/);
  }
  await assert.rejects(files.list('missing', ''), /no longer available/);
  await assert.rejects(files.read('', 'file', 0), /Invalid workspace/);
  for (const cwd of ['', 'relative/folder', '/']) {
    const unavailable = new WorkspaceFiles(async () => ({ workspaces: [{ id: 'fixture', name: '', cwd, panes: [] }], updatedAt: 0 }));
    await assert.rejects(unavailable.list('fixture', ''), /no readable folder/);
  }
});

test('symbolic links are visible but cannot expose files inside or outside the workspace', async t => {
  const { directory, root, files } = await fixture(t);
  await mkdir(path.join(directory, 'outside'));
  await writeFile(path.join(directory, 'outside', 'secret'), 'private');
  await writeFile(path.join(root, 'safe'), 'public');
  await symlink('../outside/secret', path.join(root, 'escape'));
  await symlink('../outside', path.join(root, 'folder-link'));
  await symlink('safe', path.join(root, 'internal-link'));
  await symlink('missing', path.join(root, 'broken-link'));
  const listing = await files.list('fixture', '');
  assert.equal(listing.entries.filter(entry => entry.kind === 'symlink').length, 4);
  for (const target of ['escape', 'folder-link/secret', 'internal-link', 'broken-link']) {
    await assert.rejects(files.read('fixture', target, 0), /Symbolic links/);
  }
  await assert.rejects(files.list('fixture', 'folder-link'), /Symbolic links/);
  assert.equal(Buffer.from((await files.read('fixture', 'safe', 0)).data, 'base64').toString(), 'public');
});

test('file limits, offsets, missing paths, and special files produce clear errors', async t => {
  const { root, files } = await fixture(t);
  const handle = await open(path.join(root, 'large'), 'w');
  try { await handle.truncate(MAX_FILE_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(files.read('fixture', 'large', 0), /20 MiB/);
  const limit = await open(path.join(root, 'at-limit'), 'w');
  try { await limit.truncate(MAX_FILE_BYTES); } finally { await limit.close(); }
  const final = await files.read('fixture', 'at-limit', MAX_FILE_BYTES - 10);
  assert.equal(final.eof, true);
  assert.equal(Buffer.from(final.data, 'base64').length, 10);
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    await assert.rejects(files.read('fixture', 'at-limit', offset), /Invalid file offset/);
  }
  await assert.rejects(files.read('fixture', 'at-limit', MAX_FILE_BYTES + 1), /offset is invalid/);
  await assert.rejects(files.list('fixture', 'missing'), /no longer exists/);
  await assert.rejects(files.read('fixture', 'missing', 0), /no longer exists/);
  await assert.rejects(files.list('fixture', 'at-limit'), /not a folder/);
  await assert.rejects(files.read('fixture', '', 0), /Only regular files/);
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  await assert.rejects(files.read('fixture', 'pipe', 0), /Only regular files/);
  assert.equal((await files.list('fixture', '')).entries.some(entry => entry.name === 'pipe'), false);
});

test('large directory listings are bounded and indicate truncation', async t => {
  const { root, files } = await fixture(t);
  await Promise.all(Array.from({ length: MAX_DIRECTORY_ENTRIES + 1 }, (_, index) => writeFile(path.join(root, `file-${index}`), '')));
  const listing = await files.list('fixture', '');
  assert.equal(listing.entries.length, MAX_DIRECTORY_ENTRIES);
  assert.equal(listing.truncated, true);
});
