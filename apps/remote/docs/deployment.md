# Deployment and operations

This repository contains deployment configuration, not a deployed service. You need a public host, DNS name, Apple developer configuration, and release artifacts. Start with a private beta; the [release gates](release-checklist.md) are not all complete.

## Relay

1. Point a hostname such as `relay.example.com` at your deployment machine. Allow inbound TCP 80/443 there. Development machines and phones need only outbound access to the relay.
2. Copy `deploy/.env.example` to `deploy/.env`. Set `RELAY_HOST`, `APPLE_AUDIENCE` (the app's bundle ID), a strong URL-safe `POSTGRES_PASSWORD`, and an unrelated random `METRICS_TOKEN`. Do not commit this file.
3. Produce host archives as described below and place them in `release/host`.
4. Start the stack from the repository root:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build
```

Caddy terminates HTTPS and forwards to a private relay container; PostgreSQL is private as well. Do not publish the relay's port directly while `TRUST_PROXY=1`: forwarded headers are trusted only because this deployment places it behind Caddy. Application access logs are deliberately not enabled. Do not add authorization headers, pairing links, terminal payloads, or raw request bodies to logs.

The relay currently requires **one application instance**. Live host sockets and tunnel tickets are kept in that process, so independently load-balancing multiple instances will not work. Horizontal scaling needs host routing and distributed coordination first. Restarting the relay disconnects phones; the running Workbench sessions survive and companions reconnect.

For a foreground relay outside Docker:

```sh
DATABASE_URL=postgres://user:password@127.0.0.1:5432/workbench \
APPLE_AUDIENCE=your.app.bundleid npm run relay
```

It binds to loopback by default. Other settings: `PORT`, `BIND_ADDRESS`, `TRUST_PROXY`, `METRICS_TOKEN`, `RELEASE_DIRECTORY`. Serve external clients through HTTPS. Non-loopback plaintext relay URLs are rejected by the host and phone.

Apple authentication verifies signature, issuer, audience, expiry, and a consumed challenge nonce. No shared Apple private key is needed merely to verify native identity tokens. Account lifecycle integration is a separate unfinished release gate; do not present sign-out or machine grant revocation as account deletion.

## Host artifacts

`npm run package:host` builds for the machine and CPU executing it. It packages Node and the companion dependencies, tests the actual native PTY binding, then writes an archive and checksum in `release/host`:

```text
workbench-host-linux-x64.tar.gz
workbench-host-linux-arm64.tar.gz
workbench-host-darwin-x64.tar.gz
workbench-host-darwin-arm64.tar.gz
```

The manual `Host releases` workflow builds each target on its matching runner. Download its artifacts and copy the archives and `.sha256` files into the deployment's `release/host`. Only the Linux x64 artifact has been built locally in this workspace. The installer reports an unavailable release rather than substituting an incompatible one.

Hosts need tmux separately. Linux builds target glibc-based systems, not Alpine/musl. macOS distribution still requires the signing/notarization and clean-machine checks in the release checklist. Checksums detect corrupted downloads; they are not an independent publisher signature. Protect the HTTPS service and release publishing credentials.

The installer uses versioned directories under `~/.local/share/workbench-remote` and a launcher symlink under `~/.local/bin`. It refuses to replace an unrelated launcher. It does not require sudo, alter system SSH settings, or automatically grant a phone access.

## Companion lifecycle

Run as the Workbench owner. State defaults to `~/.workbench`; credentials default to `~/.config/workbench-remote/host.json` with mode 0600. This file contains the host private key, relay credential and locally approved device keys: treat it as a secret and exclude it from public backups.

`workbench-remote service` installs a systemd **user** service on Linux or a LaunchAgent on macOS. Linux installations that must continue after logout need user lingering configured by their administrator. A macOS LaunchAgent runs in the user's login session. Neither mechanism prevents the development machine from sleeping.

To pair another device, run `workbench-remote pair`. Restart a running companion after pairing to load the new local approval. When updating the installed binary, run `service` again to update its pinned executable path; explicitly restart an already running Linux service:

```sh
systemctl --user restart workbench-remote.service
systemctl --user status workbench-remote.service
```

The app's Paired devices screen revokes a phone's access to that machine and closes its current tunnels. Sign-out only removes the local login. If every phone is lost, use the host's interactive pairing flow to approve a replacement under the same Apple account, restart the companion, then revoke the lost device. A relay administrator must handle permanent account deletion until the release-gated lifecycle flow is added.

To stop/remove the companion service without touching Workbench sessions:

- Linux: `systemctl --user disable --now workbench-remote.service`; remove only its unit file if uninstalling, then `systemctl --user daemon-reload`.
- macOS: unload `~/Library/LaunchAgents/dev.workbench.remote.host.plist` with `launchctl bootout` for your GUI domain; remove only that plist if uninstalling.
- Foreground: Ctrl-C stops the companion. The companion's SSH server is embedded; there is no public listening SSH port to close.

Keep the configuration unless intentionally retiring the machine identity. Do not delete Workbench's state or its tmux socket during an uninstall.

## Operations and data

`GET /health` checks database connectivity. `GET /metrics` requires the metrics bearer token and exposes aggregate counters and active connection counts, not session content. Alert on health failures, excessive rejects, database growth and resource saturation. Rate limits are a baseline, not a substitute for load testing or edge abuse controls.

Back up the PostgreSQL volume, test restoration, and secure backup access. It holds account identifiers, public keys, machine/device names, hashed credentials, grants and temporary pairing records. Terminal bytes are streamed and not persisted by the relay. Periodic cleanup expires challenges/tokens/pairings and unclaimed machines; confirmed account/device records do not yet have automatic account-deletion handling.

Access tokens expire after 30 days. Sign in again when expired; there is no silent refresh-token flow. Host identity changes must be explicitly re-paired, never automatically trusted. If a host configuration is lost, register a new machine identity and clean up the obsolete relay registration as part of administration.

Before production, complete secret rotation, account lifecycle, auditing, recovery, retention and availability requirements in the release checklist. Do not deploy this stack on a machine already using ports 80/443 without planning that change.
