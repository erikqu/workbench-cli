import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function hasUserService(platform = process.platform) {
  if (platform === 'darwin') return true;
  if (platform !== 'linux') throw new Error('Phone pairing supports Linux and macOS.');
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return false;
  try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'pipe', timeout: 3000 }); return true; }
  catch { return false; }
}

// A separate process group keeps the companion alive when the dialog closes.
// The private IPC channel carries readiness only; stdout/stderr are never logged.
export async function startBackgroundCompanion(entry = process.argv[1], env = process.env) {
  const child = spawn(process.execPath, [entry, 'start'], { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error('The phone companion took too long to start. Try Connect phone again.')), 15_000);
    function finish(error?: Error) {
      if (finished) return; finished = true;
      clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit');
      if (child.connected) child.disconnect();
      if (error) { child.kill('SIGTERM'); reject(error); } else { child.unref(); resolve(); }
    }
    child.once('error', () => finish(new Error('Could not start the phone companion. Check your Node.js installation.')));
    child.once('exit', () => finish(new Error('The phone companion exited before startup completed. Try Connect phone again.')));
    child.on('message', message => {
      const value = message as { type?: string; message?: string };
      if (value.type === 'ready') finish();
      else if (value.type === 'error') finish(new Error(value.message || 'The phone companion could not start.'));
    });
  });
}

export async function ensureCompanion(options: {
  healthy: () => Promise<boolean>;
  service: boolean;
  install: () => Promise<void>;
  background: () => Promise<void>;
  stop: () => Promise<void>;
  restart?: boolean;
}) {
  const running = await options.healthy();
  if (running && !options.restart) return;
  if (options.service) await options.install();
  else {
    if (running) {
      await options.stop();
      const deadline = Date.now() + 10_000;
      while (await options.healthy()) {
        if (Date.now() >= deadline) throw new Error('The previous phone companion could not stop. Retry Connect phone.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await options.background();
  }
  const deadline = Date.now() + 15_000;
  do {
    if (await options.healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('The phone companion did not become ready. Retry Connect phone.');
}
