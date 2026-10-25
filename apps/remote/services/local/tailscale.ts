import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
export function tailscalePath() {
  if (process.env.WORKBENCH_TAILSCALE_BIN) return process.env.WORKBENCH_TAILSCALE_BIN;
  const mac = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return process.platform === 'darwin' && existsSync(mac) ? mac : 'tailscale';
}
export function tailscaleOrigin(status: { BackendState?: string; Self?: { DNSName?: string } }) {
  if (status.BackendState !== 'Running') throw new Error('Open Tailscale and sign in on this computer and your iPhone.');
  const name = status.Self?.DNSName?.replace(/\.$/, '');
  if (!name || !/^[a-z0-9.-]+\.ts\.net$/i.test(name)) throw new Error('Enable MagicDNS and HTTPS certificates in your Tailscale admin console.');
  return `https://${name}:8443`;
}
export function checkServeConfiguration(existing: any, origin: string) {
  const host = new URL(origin).host;
  const configs = [existing, ...Object.values(existing.Foreground || {})] as any[];
  for (const config of configs) {
    if (config.AllowFunnel?.[host]) throw new Error('Disable Tailscale Funnel on port 8443 before pairing. Phone access must stay private.');
    const handlers = config.Web?.[host]?.Handlers;
    const port = config.TCP?.['8443'];
    if (port?.TCPForward || (port && !port.HTTPS) || (handlers && (Object.keys(handlers).length !== 1 || handlers['/']?.Proxy !== 'http://127.0.0.1:9419'))) throw new Error('Tailscale Serve port 8443 is already in use. Free that port before pairing.');
  }
}
export function configureTailscale(run: (args: string[]) => string = args => execFileSync(tailscalePath(), args, { encoding: 'utf8', timeout: 20_000, stdio: 'pipe' })) {
  let status;
  try { status = JSON.parse(run(['status', '--json'])); }
  catch { throw new Error('Install Tailscale on this computer and iPhone, then sign in to the same tailnet. See https://tailscale.com/download'); }
  const origin = tailscaleOrigin(status);
  // A dedicated HTTPS port avoids replacing an existing Serve handler on 443.
  // Serve remains tailnet-only; never use Funnel for terminal access.
  let existing;
  try { existing = JSON.parse(run(['serve', 'status', '--json'])); }
  catch { throw new Error('Update Tailscale to a version that supports tailscale serve.'); }
  checkServeConfiguration(existing, origin);
  try { run(['serve', '--bg', '--https=8443', 'http://127.0.0.1:9419']); }
  catch { throw new Error('Tailscale could not enable private HTTPS. Enable HTTPS certificates in your tailnet admin console, then try again.'); }
  return origin;
}
