# Protocol and trust boundaries

## Pairing

1. Companion generates an Ed25519 host key and registers over HTTPS. The relay returns a machine ID, high-entropy host credential and five-minute pairing secret.
2. The QR/deep link contains protocol version, relay origin, machine ID, pairing ID, secret, and the full SSH host public key. It is sensitive and should not be published.
3. The iPhone creates a per-installation device key in Keychain, signs in with Apple, and claims the secret. Claiming alone does not grant access.
4. Both endpoints derive a six-digit code from SHA-256 of `secret + "\n" + canonicalHostPublicKey + "\n" + canonicalDevicePublicKey` (first unsigned big-endian 32 bits, modulo one million).
5. The user enters the phone's code on the host. The host records that exact device key locally before confirming it to the relay. The phone pins the QR host key after its grant appears.

Additional devices must belong to the machine owner's account and repeat pairing. Relay authorization cannot add a key that is missing from the companion's local approval list. The relay may revoke access, deny service, or observe metadata, but cannot decrypt session traffic merely by routing it. A compromised host, compromised unlocked phone, malicious approved user, or stolen private key is outside that protection.

## Connections

Host: bearer-authenticated `WSS /v1/host`, kept open outbound. The relay pushes current grants and per-connection requests. Phone: bearer-authenticated `WSS /v1/tunnel/:machineId`. The relay issues a single-use short-lived ticket for the host's `WSS /v1/bridge/:connectionId`, rechecks authorization, then pipes binary frames with stream backpressure.

Inside that byte stream is ordinary SSH. The client pins the host key and authenticates using the device ID as its username and its own private key. The companion accepts only the locally approved key for that device. It exposes neither an arbitrary shell nor arbitrary exec/SFTP/port-forwarding APIs. **Controlling an existing terminal still confers the effective privileges of the host's OS user.** The restricted SSH surface is not a terminal sandbox.

SSH control channel: subsystem `workbench-control-v1`. UTF-8 newline-delimited JSON. Every request has a string `id`.

```json
{"id":"request-1","method":"watch"}
{"id":"request-2","method":"list"}
{"id":"request-3","method":"takeControl","sessionId":"workbench_h_example"}
{"id":"request-4","method":"setPhoneLayout","sessionId":"workbench_h_example","enabled":true}
```

Events: `hello` with version 1, `snapshot`, `sessionState`, `ok`, or `error`. Snapshots include workspaces and live/saved panes; session state includes writable, local-attached and geometry information. `watch` refreshes snapshots periodically. See `services/shared/protocol.ts` and the Swift models for the concrete shapes.

SSH terminal channel: PTY request followed by exec `workbench-attach:<discovered-tmux-name>`. Channel bytes are terminal input/output, not structured agent messages. Window-change requests are gated by current ownership/local-attachment state. Arbitrary names not discovered from Workbench's private tmux server are rejected.

## Ownership, sizing, and reconnect

The first remote attachment becomes writer when no remote writer exists. Viewers receive terminal output but their input is rejected at injection time. `takeControl` is explicit and requires an existing attachment. Disconnecting releases the lease; another existing viewer is not silently promoted.

Remote tmux clients initially attach with `ignore-size`. The host excludes its own attachment TTYs when detecting local clients. While a local client is attached, remote sizing remains ignored. Without a local client, only the remote writer contributes to terminal size; viewers mirror that size. Local input remains possible at all times.

The writer can explicitly select **Fit to iPhone**. The companion saves the window's sizing setting and uses the phone's requested dimensions until that mode is disabled, the writer disconnects, or another device takes control. The desktop sees this smaller layout too. The previous sizing setting is restored on normal teardown. Session state includes `phoneLayout`; older hosts omit it and clients treat it as false. An abrupt host process crash (such as SIGKILL) can leave the tmux window manually sized; crash recovery is not yet persisted.

The application does not promise exactly-once delivery: an SSH write succeeding does not prove an agent consumed the input. Nothing is resent on reconnect. Compose drafts are local, may contain sensitive text, and are not a synchronized offline coding workspace. Backgrounding closes the active client connection; the app reconnects on foreground and reattaches to a still-live session.

## Limits

The relay is single-instance, uses bounded frames and per-IP/account limits, and does not persist terminal content. It still needs production load/fault/security review. There is no end-to-end delivery acknowledgement protocol, agent-specific structured chat, snapshot replay, offline execution, automatic host wake, or automated key rotation. Credentials and host approvals require an explicit operational recovery process.
