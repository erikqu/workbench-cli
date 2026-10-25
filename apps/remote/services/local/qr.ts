import { canonicalKey, type PairingQR } from '../shared/protocol';
// The compact representation retains every pinned identity and random secret.
// Binary UUIDs and key bytes keep the QR small enough for a terminal dialog.
export function pairingLink(qr: PairingQR) {
  const uuid = (value: string) => Buffer.from(value.replaceAll('-', ''), 'hex');
  const key = canonicalKey(qr.hostKey);
  if (!key.startsWith('ssh-ed25519 ')) throw new Error('Compact pairing requires an Ed25519 host key');
  const payload = Buffer.concat([Buffer.from([2]), uuid(qr.pairingId), Buffer.from(qr.secret, 'base64url'), uuid(qr.machineId), Buffer.from(key.split(' ')[1], 'base64'), Buffer.from(qr.relay)]);
  return 'workbench-remote://pair?data=' + payload.toString('base64url');
}
