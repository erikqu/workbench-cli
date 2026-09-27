import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let listener;
    window.calls = [];
    const snapshot = { updatedAt: Date.now(), workspaces: [
      { id: 'one', name: 'workbench-app', cwd: '/projects/workbench-app', panes: [
        { id: 'workbench_h_1', tmux: 'workbench_h_1', name: 'Claude Code', live: true, kind: 'agent' },
        { id: 'workbench_t_1', tmux: 'workbench_t_1', name: 'Terminal 1', live: true, kind: 'terminal' }] },
      { id: 'two', name: 'research', cwd: '/projects/research', panes: [{ id: 'workbench_h_2', tmux: 'workbench_h_2', name: 'Codex', live: false, kind: 'agent' }] },
    ] };
    window.workbench = {
      profile: async () => ({ host: 'supernova.tail43b99e.ts.net', port: 2222, username: 'starq', directory: '~/.workbench', auth: 'agent', keyPath: '' }),
      chooseKey: async () => '/Users/test/.ssh/id_ed25519',
      connect: async (...args) => { window.calls.push(['connect', ...args]); return snapshot; },
      disconnect: async () => window.calls.push(['disconnect']),
      refresh: async () => { window.calls.push(['refresh']); return snapshot; },
      attach: async id => {
        window.calls.push(['attach', id]);
        setTimeout(() => listener({ type: 'data', id, data: new TextEncoder().encode('\x1b[32mConnected to your live session.\x1b[0m\r\n\r\n  Workbench Remote\r\n  Your projects and agents are right where you left them.\r\n\r\n~/projects/workbench-app ❯ ') }), 10);
      },
      detach: async id => window.calls.push(['detach', id]),
      input: (id, data) => { window.calls.push(['input', id, data]); listener({ type: 'data', id, data: new TextEncoder().encode(data) }); },
      resize: (...args) => window.calls.push(['resize', ...args]),
      ack: (...args) => window.calls.push(['ack', ...args]),
      onEvent: callback => { listener = callback; window.sendEvent = callback; return () => {}; },
    };
  });
  await page.goto(pathToFileURL(resolve('dist/index.html')).href);
  await page.screenshot({ path: 'test-results/welcome.png' });
  await page.getByRole('button', { name: 'Connect to your machine' }).click();
  await page.locator('[name="auth"]').selectOption('key');
  await page.getByRole('button', { name: 'Choose…' }).click();
  assert.equal(await page.locator('[name="keyPath"]').inputValue(), '/Users/test/.ssh/id_ed25519');
  await page.locator('[name="passphrase"]').fill('temporary-passphrase');
  await page.screenshot({ path: 'test-results/connection.png' });
  await page.locator('#submit-connect').click();
  await page.waitForFunction(() => document.querySelector('.xterm-screen'));
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'ack'));
  assert.equal(await page.locator('[name="passphrase"]').inputValue(), '');
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type('hello');
  assert.ok(await page.evaluate(() => window.calls.some(c => c[0] === 'input' && c[2] === 'h')));
  await page.getByRole('tab', { name: 'Terminal 1' }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'attach' && c[1] === 'workbench_t_1'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'resize'));
  await page.getByRole('button', { name: 'Refresh workspaces' }).click();
  await page.getByRole('textbox', { name: 'Find a workspace' }).fill('research');
  assert.equal(await page.locator('.workspace-card').count(), 1);
  await page.locator('.workspace-card').click();
  assert.match(await page.locator('#empty h2').textContent(), /resting/);
  await page.getByRole('textbox', { name: 'Find a workspace' }).fill('');
  await page.locator('.workspace-card').first().click();
  await page.screenshot({ path: 'test-results/workspace.png' });
  await page.evaluate(() => window.sendEvent({ type: 'status', connected: false, message: 'Connection lost' }));
  await page.waitForFunction(() => window.calls.filter(c => c[0] === 'connect').length === 2);
  await page.waitForFunction(() => document.querySelector('#connection-state').textContent.includes('Connected'));
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.match(await page.locator('#notice').textContent(), /still running/);
  assert.deepEqual(errors, []);
  console.log('UI passed: onboarding, key selection, terminal input, tabs, resize, filtering, offline panes, reconnect, disconnect.');
} finally { await browser.close(); }
