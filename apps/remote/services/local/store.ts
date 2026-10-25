import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APIError, type Device, type Machine } from '../relay/store';
import { hash, token, PAIR_TTL_MS } from '../shared/protocol';

type Pair = { id: string; machine_id: string; secret_digest: string; expires_at: number; status: string; candidate_device_id?: string };
type State = { machine?: Machine & { token_digest: string }; devices: Record<string, Device>; tokens: Record<string, { deviceId: string; expiresAt: number }>; grants: Record<string, boolean> };
// Private, single-machine pairing store. Pairing secrets are ephemeral; identities
// and grants survive companion restarts. Writes complete before an API succeeds.
export class LocalStore {
  private state: State;
  private pairs = new Map<string, Pair>();
  async health() {}
  constructor(private file: string) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { devices: {}, tokens: {}, grants: {} };
  }
  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  async challenge(): Promise<{ challengeId: ReturnType<typeof randomUUID>; nonce: string }> { throw new APIError(404, 'Use QR pairing on this private connection'); }
  async consumeChallenge(_id: string): Promise<string> { throw new APIError(404, 'Use QR pairing'); }
  async pairingSubject(pairingId: string, secret: string) {
    const pair = this.pairs.get(pairingId);
    if (!pair || pair.secret_digest !== hash(secret) || pair.expires_at <= Date.now() || pair.status !== 'waiting') throw new APIError(404, 'Pairing unavailable or expired');
    return 'local-owner';
  }
  async login(_subject: string, publicKey: string, name: string) {
    const device = Object.values(this.state.devices).find(d => d.public_key === publicKey) || { id: randomUUID(), account_id: 'local-owner', public_key: publicKey, name };
    device.name = name; this.state.devices[device.id] = device;
    const accessToken = token(), expiresAt = Date.now() + 365 * 24 * 60 * 60_000;
    this.state.tokens[hash(accessToken)] = { deviceId: device.id, expiresAt }; this.save();
    return { accessToken, deviceId: device.id, expiresAt };
  }
  async device(bearer: string): Promise<Device> {
    const value = this.state.tokens[hash(bearer)];
    if (!value || value.expiresAt <= Date.now() || !this.state.devices[value.deviceId]) throw new APIError(401, 'Scan a new pairing code');
    return this.state.devices[value.deviceId];
  }
  async machine(bearer: string): Promise<Machine> {
    if (!this.state.machine || this.state.machine.token_digest !== hash(bearer)) throw new APIError(401, 'Invalid companion credential');
    return this.state.machine;
  }
  async createPair(name: string, hostKey: string, existing?: Machine) {
    if (existing && (existing.id !== this.state.machine?.id || hostKey !== this.state.machine.host_key)) throw new APIError(403, 'Host identity changed');
    if (this.state.machine && !existing) throw new APIError(403, 'Pair from the computer');
    const hostToken = token();
    if (!existing) this.state.machine = { id: randomUUID(), account_id: 'local-owner', name, host_key: hostKey, token_digest: hash(hostToken) };
    const machineId = this.state.machine!.id, pairingId = randomUUID(), secret = token(), expiresAt = Date.now() + PAIR_TTL_MS;
    this.pairs.clear(); this.pairs.set(pairingId, { id: pairingId, machine_id: machineId, secret_digest: hash(secret), expires_at: expiresAt, status: 'waiting' }); this.save();
    return { pairingId, machineId, secret, expiresAt, ...(!existing ? { hostToken } : {}) };
  }
  async cancelPairing(pairingId: string) { this.pairs.delete(pairingId); }
  private pair(pairingId: string) {
    const value = this.pairs.get(pairingId);
    if (!value || value.expires_at <= Date.now()) throw new APIError(404, 'Pairing expired');
    return value;
  }
  async claim(pairingId: string, secret: string, device: Device) {
    const pair = this.pair(pairingId);
    if (pair.secret_digest !== hash(secret)) throw new APIError(404, 'Pairing unavailable');
    if (pair.status !== 'waiting') throw new APIError(409, 'Pairing already claimed');
    pair.status = 'claimed'; pair.candidate_device_id = device.id;
  }
  async pairing(pairingId: string, _machine: Machine) {
    const pair = this.pair(pairingId), device = pair.candidate_device_id ? this.state.devices[pair.candidate_device_id] : undefined;
    return { ...pair, candidate_device_id: pair.candidate_device_id ?? null, public_key: device?.public_key ?? null, device_name: device?.name ?? null };
  }
  async confirm(pairingId: string, _machine: Machine, deviceId: string, publicKey: string) {
    const pair = this.pair(pairingId);
    if (pair.status !== 'claimed' || pair.candidate_device_id !== deviceId || this.state.devices[deviceId]?.public_key !== publicKey) throw new APIError(409, 'Pairing changed or expired');
    this.state.grants[deviceId] = true; pair.status = 'confirmed'; this.save();
  }
  async machines(device: Device) { return this.state.grants[device.id] && this.state.machine ? [{ id: this.state.machine.id, name: this.state.machine.name, hostKey: this.state.machine.host_key }] : []; }
  async authorize(machineId: string, device: Device) {
    if (machineId !== this.state.machine?.id || !this.state.grants[device.id]) throw new APIError(403, 'Device is not paired to this machine');
  }
  async grants(machineId: string) {
    if (machineId !== this.state.machine?.id) return [];
    return Object.values(this.state.devices).filter(d => this.state.grants[d.id]).map(d => ({ id: d.id, publicKey: d.public_key, name: d.name }));
  }
  async revoke(machineId: string, deviceId: string, _accountId: string) {
    if (machineId !== this.state.machine?.id || !this.state.grants[deviceId]) throw new APIError(404, 'Device grant not found');
    delete this.state.grants[deviceId]; this.save();
  }
  async cleanup() {
    for (const [key, pair] of this.pairs) if (pair.expires_at <= Date.now()) this.pairs.delete(key);
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.expiresAt <= Date.now()) delete this.state.tokens[key];
    this.save();
  }
}
