import { chmod } from 'node:fs/promises';

// node-pty 1.1.0 ships its macOS spawn helper without an executable mode.
// A successful import is insufficient: the first terminal spawn then fails.
if (process.platform === 'darwin') {
  const helper = new URL(`../node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`, import.meta.url);
  await chmod(helper, 0o755).catch(error => {
    if (error.code !== 'ENOENT') throw error; // Source-built installations have no prebuild helper.
  });
}
