import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
let container;
let database = process.env.WORKBENCH_TEST_DATABASE_URL;
try {
  if (!database) {
    container = 'workbench-remote-test-' + randomUUID();
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '-e', 'POSTGRES_PASSWORD=test-only', '-e', 'POSTGRES_DB=workbench', '-p', '127.0.0.1::5432', 'postgres:17-alpine'], { stdio: ['ignore', 'ignore', 'inherit'] });
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    database = `postgres://postgres:test-only@127.0.0.1:${port}/workbench`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error('Test database failed to start');
  }
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'tests/platform/*.test.ts'], { stdio: 'inherit', env: { ...process.env, WORKBENCH_TEST_DATABASE_URL: database } });
  process.exitCode = await new Promise(resolve => child.on('exit', code => resolve(code ?? 1)));
} finally {
  if (container) {
    try { execFileSync('docker', ['stop', container], { stdio: 'ignore' }); }
    catch { console.warn('The temporary test database had already exited.'); }
  }
}
