import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { Sessions } from '../services/host/sessions';

test('phone layout temporarily becomes tmux size owner while a desktop client is attached', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-phone-layout-'));
  const socket = path.join(directory, 'tmux-ui.sock');
  const session = 'workbench_h_phone_layout';
  const tmux = (args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
  let local: pty.IPty | undefined;
  const sessions = new Sessions(directory);
  try {
    tmux(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', '/bin/sh']);
    tmux(['set-option', '-g', 'status', 'off']);
    await writeFile(path.join(directory, 'workbench-ui-state.json'), JSON.stringify({
      sessions: [{ id: 'fixture', cwd: directory, harnesses: [{ tmux: session, name: 'Fixture' }] }]
    }));

    const remote = await sessions.attach('phone', session, 60, 20, () => {}, () => {});
    await until(() => width() === 60);
    local = pty.spawn('tmux', ['-S', socket, 'attach-session', '-t', '=' + session], {
      name: 'xterm-256color', cols: 110, rows: 33, env: { ...process.env, TMUX: '' }
    });
    local.onData(() => {});
    sessions.resize(remote, 60, 20);
    await until(() => width() === 110);

    await sessions.setPhoneLayout('phone', session, true);
    await until(() => width() === 60);
    assert.equal(remote.phoneLayout, true);

    await sessions.setPhoneLayout('phone', session, false);
    await until(() => width() === 110);
    assert.equal(remote.phoneLayout, false);
    // An inherited manual policy must retain both dimensions and inheritance.
    tmux(['set-option', '-g', '-w', 'window-size', 'manual']);
    tmux(['resize-window', '-t', session, '-x', '95', '-y', '28']);
    tmux(['set-option', '-w', '-u', '-t', session, 'window-size']);
    await sessions.setPhoneLayout('phone', session, true);
    await until(() => width() === 60);
    await sessions.setPhoneLayout('phone', session, false);
    await until(() => width() === 95);
    assert.equal(tmux(['show-options', '-w', '-qv', '-t', session, 'window-size']), '');
    assert.equal(tmux(['display-message', '-p', '-t', session, '#{window_height}']), '28');
    // Restoring works when the desktop uses a nondefault sizing policy too.
    tmux(['set-option', '-w', '-t', session, 'window-size', 'largest']);
    await sessions.setPhoneLayout('phone', session, true);
    await until(() => width() === 60);
    sessions.detach(remote);
    await until(() => width() === 110);
    assert.equal(tmux(['show-options', '-w', '-v', '-t', session, 'window-size']), 'largest');
  } finally {
    local?.kill();
    sessions.close();
    try { tmux(['kill-server']); } catch {}
    await rm(directory, { recursive: true, force: true });
  }

  function width() { return Number(tmux(['display-message', '-p', '-t', session, '#{window_width}'])); }
});

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for tmux geometry');
}
