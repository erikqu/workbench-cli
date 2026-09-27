import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configPath } from './config';

export async function installService() {
  if (!process.argv[1].endsWith('.mjs')) throw new Error('Build or install a host release before installing the service. For development, use npm run host -- start.');
  const args = [process.execPath, path.resolve(process.argv[1]), 'start'];
  if (process.platform === 'linux') {
    const directory = path.join(homedir(), '.config/systemd/user'); await mkdir(directory, { recursive: true });
    const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '') + '"';
    await writeFile(path.join(directory, 'workbench-remote.service'), `[Unit]\nDescription=Workbench Remote companion\nAfter=network-online.target\n\n[Service]\nExecStart=${args.map(quote).join(' ')}\nEnvironment=${quote('WORKBENCH_REMOTE_CONFIG=' + configPath())}\nEnvironment=${quote('PATH=' + process.env.PATH)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'workbench-remote.service']);
    console.log('Companion service installed. Enable user lingering with loginctl if it must run after logout.');
  } else if (process.platform === 'darwin') {
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const directory = path.join(homedir(), 'Library/LaunchAgents'); await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'dev.workbench.remote.host.plist');
    await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.workbench.remote.host</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${escape(arg)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>WORKBENCH_REMOTE_CONFIG</key><string>${escape(configPath())}</string><key>PATH</key><string>${escape(process.env.PATH || '/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`, { mode: 0o600 });
    const domain = `gui/${process.getuid!()}`;
    try { execFileSync('launchctl', ['bootout', domain, file], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', domain, file]);
    console.log('Companion LaunchAgent installed for your login session.');
  } else throw new Error('The companion currently supports Linux and macOS');
}
