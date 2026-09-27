CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY, apple_sub text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id),
  public_key text NOT NULL, name text NOT NULL, revoked boolean NOT NULL DEFAULT false,
  UNIQUE(account_id, public_key)
);
CREATE TABLE IF NOT EXISTS access_tokens (
  digest text PRIMARY KEY, device_id text NOT NULL REFERENCES devices(id), expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS login_challenges (
  id text PRIMARY KEY, nonce text NOT NULL, expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS machines (
  id text PRIMARY KEY, account_id text REFERENCES accounts(id), name text NOT NULL,
  host_key text NOT NULL, token_digest text NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  id text PRIMARY KEY, machine_id text NOT NULL REFERENCES machines(id), secret_digest text NOT NULL,
  expires_at bigint NOT NULL, status text NOT NULL DEFAULT 'waiting', candidate_device_id text REFERENCES devices(id)
);
CREATE TABLE IF NOT EXISTS grants (
  machine_id text NOT NULL REFERENCES machines(id), device_id text NOT NULL REFERENCES devices(id),
  revoked boolean NOT NULL DEFAULT false, PRIMARY KEY(machine_id, device_id)
);
CREATE INDEX IF NOT EXISTS grants_device ON grants(device_id);
CREATE INDEX IF NOT EXISTS pairings_machine ON pairings(machine_id);
