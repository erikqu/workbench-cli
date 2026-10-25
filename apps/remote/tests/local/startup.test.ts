import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureCompanion, startBackgroundCompanion } from '../../services/local/startup';

test('one click starts a container companion without installing a user service and reuses it on retry', async () => {
  let running = false;
  const calls: string[] = [];
  const options = {
    healthy: async () => running, service: false,
    install: async () => { throw new Error('No systemd in container'); },
    background: async () => { calls.push('start'); running = true; },
    stop: async () => { calls.push('stop'); running = false; },
  };
  await ensureCompanion(options);
  await ensureCompanion(options);
  assert.deepEqual(calls, ['start']);
  await ensureCompanion({ ...options, restart: true });
  assert.deepEqual(calls, ['start', 'stop', 'start']);
});

test('ordinary Linux and macOS continue installing and restarting the user service', async () => {
  let running = false, installs = 0;
  const options = {
    healthy: async () => running, service: true,
    install: async () => { installs++; running = true; },
    background: async () => { throw new Error('Must use the user service'); },
    stop: async () => { throw new Error('The service manager handles restart'); },
  };
  await ensureCompanion(options);
  await ensureCompanion(options);
  await ensureCompanion({ ...options, restart: true });
  assert.equal(installs, 2);
});

test('a background companion survives IPC disconnect and reports startup failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-background-test-'));
  let pid: number | undefined;
  try {
    const entry = path.join(directory, 'fixture.mjs');
    const pidFile = path.join(directory, 'pid');
    await writeFile(entry, `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.PID_FILE, String(process.pid));
process.send({type:'ready'});
setInterval(()=>{},1000);
process.on('SIGTERM',()=>process.exit(0));`);
    await startBackgroundCompanion(entry, { ...process.env, PID_FILE: pidFile });
    pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.doesNotThrow(() => process.kill(pid!, 0), 'closing the pairing IPC must not stop the companion');
    const failure = path.join(directory, 'failure.mjs');
    await writeFile(failure, "process.send({type:'error',message:'Fixture startup failure'});");
    await assert.rejects(startBackgroundCompanion(failure), /Fixture startup failure/);
  } finally {
    if (pid) process.kill(pid, 'SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});
