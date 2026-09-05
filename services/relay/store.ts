import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hash, token, PAIR_TTL_MS } from '../shared/protocol';

export class APIError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface Device { id: string; account_id: string; public_key: string; name: string }
export interface Machine { id: string; account_id: string | null; host_key: string; name: string }
export class Store {
  constructor(public pool: Pool) {}
  async migrate() { await this.pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async challenge() {
    const challengeId = randomUUID(), nonce = token();
    await this.pool.query('INSERT INTO login_challenges VALUES ($1,$2,$3)', [challengeId, nonce, Date.now() + PAIR_TTL_MS]);
    return { challengeId, nonce };
  }
  async consumeChallenge(challengeId: string) {
    const result = await this.pool.query('DELETE FROM login_challenges WHERE id=$1 RETURNING *', [challengeId]);
    const row = result.rows[0];
    if (!row || Number(row.expires_at) < Date.now()) throw new APIError(401, 'Login challenge expired');
    return row.nonce as string;
  }
  async login(subject: string, publicKey: string, name: string) {
    return this.transaction(async client => {
      const account = (await client.query('INSERT INTO accounts VALUES ($1,$2) ON CONFLICT (apple_sub) DO UPDATE SET apple_sub=EXCLUDED.apple_sub RETURNING id', [randomUUID(), subject])).rows[0];
      // Revoked keys may sign in again, but their machine grants remain revoked.
      const device = (await client.query('INSERT INTO devices(id,account_id,public_key,name) VALUES ($1,$2,$3,$4) ON CONFLICT(account_id,public_key) DO UPDATE SET name=EXCLUDED.name,revoked=false RETURNING id', [randomUUID(), account.id, publicKey, name])).rows[0];
      const accessToken = token(), expiresAt = Date.now() + 30 * 24 * 60 * 60_000;
      await client.query('INSERT INTO access_tokens VALUES ($1,$2,$3)', [hash(accessToken), device.id, expiresAt]);
      return { accessToken, deviceId: device.id, expiresAt };
    });
  }
  async device(bearer: string): Promise<Device> {
    const result = await this.pool.query('SELECT d.* FROM devices d JOIN access_tokens t ON t.device_id=d.id WHERE t.digest=$1 AND t.expires_at>$2 AND NOT d.revoked', [hash(bearer), Date.now()]);
    if (!result.rows[0]) throw new APIError(401, 'Sign in again');
    return result.rows[0];
  }
  async machine(bearer: string): Promise<Machine> {
    const result = await this.pool.query('SELECT * FROM machines WHERE token_digest=$1', [hash(bearer)]);
    if (!result.rows[0]) throw new APIError(401, 'Invalid companion credential');
    return result.rows[0];
  }
  async createPair(name: string, hostKey: string, existing?: Machine) {
    const pairingId = randomUUID(), secret = token(), hostToken = token();
    const machineId = existing?.id || randomUUID(), expiresAt = Date.now() + PAIR_TTL_MS;
    await this.transaction(async client => {
      if (!existing) await client.query('INSERT INTO machines VALUES ($1,NULL,$2,$3,$4,$5)', [machineId, name, hostKey, hash(hostToken), Date.now()]);
      await client.query("UPDATE pairings SET status='expired' WHERE machine_id=$1 AND status IN ('waiting','claimed')", [machineId]);
      await client.query('INSERT INTO pairings(id,machine_id,secret_digest,expires_at) VALUES ($1,$2,$3,$4)', [pairingId, machineId, hash(secret), expiresAt]);
    });
    return { pairingId, machineId, secret, expiresAt, ...(existing ? {} : { hostToken }) };
  }
  async claim(pairingId: string, secret: string, device: Device) {
    await this.transaction(async client => {
      const row = (await client.query('SELECT p.*,m.account_id FROM pairings p JOIN machines m ON m.id=p.machine_id WHERE p.id=$1 FOR UPDATE OF p,m', [pairingId])).rows[0];
      if (!row || row.secret_digest !== hash(secret) || Number(row.expires_at) <= Date.now()) throw new APIError(404, 'Pairing unavailable or expired');
      if (row.status !== 'waiting') throw new APIError(409, 'Pairing already claimed');
      if (row.account_id && row.account_id !== device.account_id) throw new APIError(403, 'This machine belongs to another account');
      await client.query("UPDATE pairings SET status='claimed',candidate_device_id=$2 WHERE id=$1", [pairingId, device.id]);
    });
  }
  async pairing(pairingId: string, machine: Machine) {
    const row = (await this.pool.query('SELECT p.*,d.public_key,d.name AS device_name FROM pairings p LEFT JOIN devices d ON d.id=p.candidate_device_id WHERE p.id=$1 AND p.machine_id=$2', [pairingId, machine.id])).rows[0];
    if (!row || Number(row.expires_at) <= Date.now()) throw new APIError(404, 'Pairing expired');
    return row;
  }
  async confirm(pairingId: string, machine: Machine, deviceId: string, publicKey: string) {
    await this.transaction(async client => {
      const row = (await client.query('SELECT p.*,d.public_key,d.account_id,d.revoked FROM pairings p JOIN devices d ON d.id=p.candidate_device_id JOIN machines m ON m.id=p.machine_id WHERE p.id=$1 AND p.machine_id=$2 FOR UPDATE OF p,m,d', [pairingId, machine.id])).rows[0];
      if (!row || row.status !== 'claimed' || Number(row.expires_at) <= Date.now() || row.revoked || row.candidate_device_id !== deviceId || row.public_key !== publicKey) throw new APIError(409, 'Pairing changed or expired');
      const owner = (await client.query('SELECT account_id FROM machines WHERE id=$1', [machine.id])).rows[0].account_id;
      if (owner && owner !== row.account_id) throw new APIError(403, 'Account mismatch');
      await client.query('UPDATE machines SET account_id=$2 WHERE id=$1', [machine.id, row.account_id]);
      await client.query('INSERT INTO grants VALUES ($1,$2,false) ON CONFLICT(machine_id,device_id) DO UPDATE SET revoked=false', [machine.id, deviceId]);
      await client.query("UPDATE pairings SET status='confirmed' WHERE id=$1", [pairingId]);
    });
  }
  async machines(device: Device) {
    return (await this.pool.query('SELECT m.id,m.name,m.host_key AS "hostKey" FROM machines m JOIN grants g ON g.machine_id=m.id WHERE g.device_id=$1 AND NOT g.revoked AND m.account_id=$2', [device.id, device.account_id])).rows;
  }
  async authorize(machineId: string, device: Device) {
    const rows = await this.pool.query('SELECT 1 FROM grants g JOIN machines m ON m.id=g.machine_id WHERE g.machine_id=$1 AND g.device_id=$2 AND NOT g.revoked AND m.account_id=$3', [machineId, device.id, device.account_id]);
    if (!rows.rowCount) throw new APIError(403, 'Device is not paired to this machine');
  }
  async grants(machineId: string) {
    return (await this.pool.query('SELECT d.id,d.public_key AS "publicKey",d.name FROM grants g JOIN devices d ON d.id=g.device_id WHERE g.machine_id=$1 AND NOT g.revoked AND NOT d.revoked', [machineId])).rows;
  }
  async revoke(machineId: string, deviceId: string, accountId: string) {
    const result = await this.pool.query('UPDATE grants g SET revoked=true FROM machines m WHERE g.machine_id=m.id AND m.id=$1 AND g.device_id=$2 AND m.account_id=$3 RETURNING g.device_id', [machineId, deviceId, accountId]);
    if (!result.rowCount) throw new APIError(404, 'Device grant not found');
  }
  async cleanup() {
    await this.pool.query('DELETE FROM access_tokens WHERE expires_at<$1', [Date.now()]);
    await this.pool.query('DELETE FROM login_challenges WHERE expires_at<$1', [Date.now()]);
    await this.pool.query('DELETE FROM pairings WHERE expires_at<$1', [Date.now() - 60_000]);
    await this.pool.query('DELETE FROM machines WHERE account_id IS NULL AND created_at<$1 AND NOT EXISTS (SELECT 1 FROM pairings WHERE machine_id=machines.id)', [Date.now() - 24 * 60 * 60_000]);
  }
}
