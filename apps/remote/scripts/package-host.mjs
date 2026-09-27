import { readFile, mkdir, copyFile, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported host release platform');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const name = `workbench-host-${process.platform}-${process.arch}`;
const directory = path.resolve('release/host', name);
await mkdir(path.join(directory, 'bin'), { recursive: true });
await mkdir(path.join(directory, 'lib'), { recursive: true });
await copyFile(process.execPath, path.join(directory, 'bin/node'));
await copyFile('scripts/host-launcher.sh', path.join(directory, 'bin/workbench-remote'));
await chmod(path.join(directory, 'bin/workbench-remote'), 0o755);
await copyFile('dist/services/host/main.mjs', path.join(directory, 'lib/host.mjs'));
// Reuse the project's complete lockfile so transitive dependencies cannot drift
// between the tested checkout and downloadable host. Desktop dev tools are omitted.
const packaged = { ...manifest, name: 'workbench-remote-host', type: 'module', main: 'lib/host.mjs' };
delete packaged.scripts;
lock.name = packaged.name;
lock.packages[''].name = packaged.name;
await writeFile(path.join(directory, 'package.json'), JSON.stringify(packaged, null, 2));
await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2));
execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--prefix', directory], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  await chmod(path.join(directory, 'node_modules/node-pty/prebuilds', `darwin-${process.arch}`, 'spawn-helper'), 0o755)
    .catch(error => { if (error.code !== 'ENOENT') throw error; });
}
execFileSync(path.join(directory, 'bin/workbench-remote'), ['help'], { stdio: 'inherit' });
// Help alone does not load the native PTY binding. Exercise the shipped runtime
// and binding before publishing an archive that could fail on first attachment.
execFileSync(path.join(directory, 'bin/node'), ['--input-type=module', '-e', `
  import pty from 'node-pty';
  const child = pty.spawn('/bin/sh', ['-c', 'printf WORKBENCH_PTY_OK'], { cols: 80, rows: 24 });
  let output = '';
  const timeout = setTimeout(() => { child.kill(); process.exit(1); }, 5000);
  child.onData(data => output += data);
  child.onExit(({exitCode}) => { clearTimeout(timeout); process.exit(exitCode === 0 && output.includes('WORKBENCH_PTY_OK') ? 0 : 1); });
`], { cwd: directory, stdio: 'inherit' });
execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: path.resolve('release/host') });
const digest = createHash('sha256').update(await readFile(`release/host/${name}.tar.gz`)).digest('hex');
await writeFile(`release/host/${name}.tar.gz.sha256`, `${digest}  ${name}.tar.gz\n`);
console.log(`Created release/host/${name}.tar.gz`);
