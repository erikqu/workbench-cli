import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { APIError, Store, type Device } from './store';
import { canonicalKey, hash, id, text, token } from '../shared/protocol';

export interface RelayOptions {
  store: Store; appleAudience: string; trustProxy?: boolean; metricsToken?: string; releaseDirectory?: string;
  // Dependency injection for tests only; the production entrypoint always verifies Apple tokens.
  identityVerifier?: (identityToken: string, nonceHash: string) => Promise<string>;
}
function bearer(req: IncomingMessage) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ') || auth.length > 1024) throw new APIError(401, 'Authentication required');
  return auth.slice(7);
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new APIError(415, 'Expected JSON');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new APIError(413, 'Request too large'); chunks.push(chunk); }
  const data = JSON.parse(Buffer.concat(chunks).toString());
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new APIError(400, 'Expected JSON object');
  return data;
}
export function createRelay(options: RelayOptions) {
  const { store } = options;
  const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
  const verifyIdentity = options.identityVerifier || (async (identityToken: string, nonceHash: string) => {
    const { payload } = await jwtVerify(identityToken, appleKeys, { issuer: 'https://appleid.apple.com', audience: options.appleAudience, algorithms: ['RS256'] });
    if (!payload.sub || payload.nonce !== nonceHash) throw new APIError(401, 'Invalid Apple identity');
    return payload.sub;
  });
  const hosts = new Map<string, WebSocket>();
  const tunnels = new Map<string, { machineId: string; device: Device; phone: WebSocket; host?: WebSocket; ticket: string; timer: NodeJS.Timeout }>();
  const limits = new Map<string, { count: number; reset: number }>();
  const metrics = { connections: 0, rejected: 0, pairings: 0, errors: 0 };
  function rate(req: IncomingMessage, kind: string, max: number) {
    const address = options.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').pop()!.trim() : req.socket.remoteAddress;
    const key = `${kind}:${address}`, now = Date.now();
    let value = limits.get(key);
    if (!value || value.reset <= now) { value = { count: 0, reset: now + 60_000 }; limits.set(key, value); }
    if (++value.count > max) throw new APIError(429, 'Too many requests; try again shortly');
  }
  function closeTunnel(connectionId: string) {
    const tunnel = tunnels.get(connectionId); if (!tunnel) return;
    tunnels.delete(connectionId); clearTimeout(tunnel.timer);
    tunnel.phone.close(1000, 'Tunnel closed'); tunnel.host?.close(1000, 'Tunnel closed');
  }
  async function syncGrants(machineId: string) {
    const host = hosts.get(machineId);
    if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify({ type: 'grants', devices: await store.grants(machineId) }));
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url || '/', 'http://relay');
      rate(req, 'api', 120);
      if (req.method === 'GET' && (url.pathname === '/install.sh' || /^\/downloads\/workbench-host-(linux|darwin)-(x64|arm64)\.tar\.gz(?:\.sha256)?$/.test(url.pathname))) {
        const filename = url.pathname === '/install.sh' ? path.resolve('public/install.sh') : options.releaseDirectory ? path.join(options.releaseDirectory, path.basename(url.pathname)) : '';
        if (!filename) throw new APIError(404, 'Release not available');
        const info = await stat(filename).catch(() => { throw new APIError(404, 'Release not available'); });
        if (!info.isFile()) throw new APIError(404, 'Release not available');
        res.setHeader('Content-Type', filename.endsWith('.tar.gz') ? 'application/gzip' : 'text/plain; charset=utf-8'); res.setHeader('Content-Length', info.size);
        const stream = createReadStream(filename); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      let result: unknown;
      if (req.method === 'GET' && url.pathname === '/health') {
        await store.pool.query('SELECT 1'); result = { ok: true, protocol: 1 };
      } else if (req.method === 'GET' && url.pathname === '/metrics') {
        if (!options.metricsToken || bearer(req) !== options.metricsToken) throw new APIError(404, 'Not found');
        result = { ...metrics, hosts: hosts.size, tunnels: tunnels.size };
      } else if (req.method === 'POST' && url.pathname === '/v1/auth/challenge') {
        rate(req, 'auth', 20); result = await store.challenge();
      } else if (req.method === 'POST' && url.pathname === '/v1/auth/apple') {
        rate(req, 'auth', 20); const body = await json(req);
        const nonce = await store.consumeChallenge(id(body.challengeId));
        let subject: string;
        try { subject = await verifyIdentity(text(body.identityToken, 'identity token', 10_000), hash(nonce)); }
        catch { throw new APIError(401, 'Apple sign-in could not be verified'); }
        result = await store.login(subject, canonicalKey(body.publicKey), text(body.name, 'device name', 80));
      } else if (req.method === 'POST' && url.pathname === '/v1/pairings') {
        rate(req, 'pair', 5); const body = await json(req);
        const existing = req.headers.authorization ? await store.machine(bearer(req)) : undefined;
        result = await store.createPair(text(body.name, 'machine name', 80), canonicalKey(body.hostKey), existing);
      } else if (url.pathname.startsWith('/v1/pairings/')) {
        const [, , , pairingId, action] = url.pathname.split('/'); id(pairingId);
        if (req.method === 'POST' && action === 'claim') {
          const device = await store.device(bearer(req)); const body = await json(req);
          await store.claim(pairingId, text(body.secret, 'pairing secret'), device); result = { status: 'claimed' };
        } else if (req.method === 'GET' && !action) {
          const machine = await store.machine(bearer(req));
          const pair = await store.pairing(pairingId, machine);
          result = { status: pair.status, deviceId: pair.candidate_device_id, publicKey: pair.public_key, deviceName: pair.device_name };
        } else if (req.method === 'POST' && action === 'confirm') {
          const machine = await store.machine(bearer(req)); const body = await json(req);
          await store.confirm(pairingId, machine, id(body.deviceId), canonicalKey(body.publicKey));
          await syncGrants(machine.id); metrics.pairings++; result = { status: 'confirmed' };
        } else throw new APIError(404, 'Not found');
      } else if (req.method === 'GET' && url.pathname === '/v1/machines') {
        const device = await store.device(bearer(req));
        result = { machines: (await store.machines(device)).map(machine => ({ ...machine, online: hosts.has(machine.id) })) };
      } else if (req.method === 'GET' && url.pathname === '/v1/host/grants') {
        result = { devices: await store.grants((await store.machine(bearer(req))).id) };
      } else if (/^\/v1\/machines\/[^/]+\/devices(?:\/[^/]+)?$/.test(url.pathname)) {
        const device = await store.device(bearer(req));
        const [, , , machineId, , deviceId] = url.pathname.split('/');
        await store.authorize(machineId, device);
        if (req.method === 'GET' && !deviceId) result = { devices: await store.grants(machineId) };
        else if (req.method === 'DELETE' && deviceId) {
          await store.revoke(machineId, deviceId, device.account_id);
          for (const [connectionId, tunnel] of tunnels) if (tunnel.machineId === machineId && tunnel.device.id === deviceId) closeTunnel(connectionId);
          await syncGrants(machineId); result = { revoked: true };
        } else throw new APIError(404, 'Not found');
      } else throw new APIError(404, 'Not found');
      res.end(JSON.stringify(result));
    } catch (error) {
      metrics.errors++;
      const code = error instanceof APIError ? error.status : error instanceof SyntaxError || (error instanceof Error && /^(Invalid|Expected|Unsupported)/.test(error.message)) ? 400 : 500;
      res.statusCode = code;
      res.end(JSON.stringify({ error: code === 500 ? 'Service temporarily unavailable' : (error as Error).message }));
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 });
  const alive = new WeakSet<WebSocket>();
  function guard(ws: WebSocket) {
    alive.add(ws); ws.on('pong', () => alive.add(ws)); ws.on('error', () => ws.terminate());
  }
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      rate(req, 'ws', 30);
      const url = new URL(req.url || '/', 'http://relay');
      if (url.pathname === '/v1/host') {
        const machine = await store.machine(bearer(req));
        wss.handleUpgrade(req, socket, head, ws => {
          guard(ws); hosts.get(machine.id)?.close(1000, 'Companion reconnected'); hosts.set(machine.id, ws);
          ws.on('close', () => {
            if (hosts.get(machine.id) !== ws) return;
            hosts.delete(machine.id);
            for (const [connectionId, tunnel] of tunnels) if (tunnel.machineId === machine.id) closeTunnel(connectionId);
          });
          ws.on('message', () => ws.close(1008, 'Unexpected message'));
          void syncGrants(machine.id).catch(() => ws.close(1011, 'Could not load device grants'));
        });
      } else if (url.pathname.startsWith('/v1/tunnel/')) {
        const machineId = id(url.pathname.slice('/v1/tunnel/'.length));
        const device = await store.device(bearer(req)); await store.authorize(machineId, device);
        const host = hosts.get(machineId);
        if (!host || host.readyState !== WebSocket.OPEN) throw new APIError(503, 'Machine is offline');
        if ([...tunnels.values()].filter(t => t.device.account_id === device.account_id).length >= 8) throw new APIError(429, 'Connection limit reached');
        wss.handleUpgrade(req, socket, head, phone => {
          guard(phone);
          const connectionId = randomUUID(), ticket = token();
          // Pause until the companion supplies its half; no SSH bytes are discarded.
          phone.pause();
          tunnels.set(connectionId, { machineId, device, phone, ticket, timer: setTimeout(() => closeTunnel(connectionId), 15_000) });
          phone.on('close', () => closeTunnel(connectionId));
          host.send(JSON.stringify({ type: 'connect', connectionId, deviceId: device.id, ticket }));
        });
      } else if (url.pathname.startsWith('/v1/bridge/')) {
        const machine = await store.machine(bearer(req));
        const connectionId = id(url.pathname.slice('/v1/bridge/'.length));
        const tunnel = tunnels.get(connectionId);
        if (!tunnel || tunnel.host || tunnel.machineId !== machine.id || req.headers['x-workbench-ticket'] !== tunnel.ticket) throw new APIError(403, 'Invalid connection ticket');
        await store.authorize(machine.id, tunnel.device);
        // Recheck after the async authorization to prevent competing bridge upgrades.
        if (tunnels.get(connectionId) !== tunnel || tunnel.host) throw new APIError(409, 'Connection already consumed');
        wss.handleUpgrade(req, socket, head, host => {
          guard(host); tunnel.host = host; clearTimeout(tunnel.timer); metrics.connections++;
          const phoneStream = createWebSocketStream(tunnel.phone), hostStream = createWebSocketStream(host);
          phoneStream.on('error', () => closeTunnel(connectionId)); hostStream.on('error', () => closeTunnel(connectionId));
          host.on('close', () => closeTunnel(connectionId));
          phoneStream.pipe(hostStream).pipe(phoneStream); tunnel.phone.resume();
        });
      } else throw new APIError(404, 'Not found');
    } catch (error) {
      metrics.rejected++;
      const status = error instanceof APIError ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!alive.has(ws)) { ws.terminate(); continue; } alive.delete(ws); ws.ping(); }
    for (const [key, value] of limits) if (value.reset < Date.now()) limits.delete(key);
  }, 20_000);
  const cleanup = setInterval(() => { void store.cleanup().catch(() => metrics.errors++); }, 60_000);
  heartbeat.unref(); cleanup.unref();
  return { server, metrics, async close() {
    clearInterval(heartbeat); clearInterval(cleanup);
    for (const ws of wss.clients) ws.terminate();
    for (const tunnel of tunnels.values()) clearTimeout(tunnel.timer);
    tunnels.clear(); hosts.clear();
    await new Promise<void>(resolve => server.close(() => resolve())); wss.close();
  } };
}
