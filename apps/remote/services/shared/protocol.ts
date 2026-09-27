import { createHash, randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
const { utils } = ssh2;

export const PROTOCOL = 'workbench-control-v1';
export const PAIR_TTL_MS = 5 * 60_000;
export const token = () => randomBytes(32).toString('base64url');
export function generateIdentity() {
  // ssh2 1.17's key generator occasionally drops a leading zero from an Ed25519
  // public key. Validate both serialized keys before accepting generated material.
  for (let attempt = 0; attempt < 16; attempt++) {
    const keys = utils.generateKeyPairSync('ed25519');
    const privateKey = utils.parseKey(keys.private), publicKey = utils.parseKey(keys.public);
    if (!(privateKey instanceof Error) && !(publicKey instanceof Error) && !Array.isArray(privateKey) && !Array.isArray(publicKey) && privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) return keys;
  }
  throw new Error('Could not generate a valid device identity');
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonicalKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid public key');
  const key = utils.parseKey(value);
  if (key instanceof Error || Array.isArray(key) || key.isPrivateKey()) throw new Error('Expected an SSH public key');
  if (!['ssh-ed25519', 'ecdsa-sha2-nistp256'].includes(key.type)) throw new Error('Unsupported device key');
  return `${key.type} ${key.getPublicSSH().toString('base64')}`;
}
export function verificationCode(secret: string, hostKey: string, deviceKey: string) {
  const digest = hash(`${secret}\n${canonicalKey(hostKey)}\n${canonicalKey(deviceKey)}`);
  return (parseInt(digest.slice(0, 8), 16) % 1_000_000).toString().padStart(6, '0');
}
export interface PairingQR {
  version: 1; relay: string; pairingId: string; secret: string; machineId: string; hostKey: string;
}
export interface HostConfiguration {
  relay: string; machineId: string; hostToken: string; hostKey: string; privateKey: string;
  directory: string; approvedKeys: Record<string, string>;
}
export type ControlRequest =
  | { id: string; method: 'list' | 'watch' }
  | { id: string; method: 'takeControl'; sessionId: string }
  | { id: string; method: 'createWorkspace'; name: string; parentDirectory: string; agent: 'codex' | 'terminal' }
  | { id: string; method: 'listFiles'; workspaceId: string; path: string }
  | { id: string; method: 'readFile'; workspaceId: string; path: string; offset: number }
  | { id: string; method: 'setPhoneLayout'; sessionId: string; enabled: boolean };
export interface DirectoryListing {
  path: string;
  entries: { name: string; path: string; kind: 'directory' | 'file' | 'symlink'; size: number }[];
  truncated: boolean;
}
export interface FileChunk {
  path: string; size: number; version: string; offset: number; nextOffset: number; data: string; eof: boolean;
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value.trim();
}
export function id(value: unknown): string { return text(value, 'identifier', 100); }
export function size(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(2, Math.min(500, Math.floor(value))) : fallback;
}
export function relayURL(value: string): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Relay must use HTTPS (HTTP allowed only on loopback)');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the relay origin without a path or credentials');
  return url;
}
export function websocketURL(origin: string, pathname: string): string {
  const url = relayURL(origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = pathname; return url.href;
}
