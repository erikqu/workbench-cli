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

Events: `hello` with version 1, `snapshot`, `sessionState`, `ok`, `workspaceCreated`, `directory`, `fileChunk`, or `error`. The hello advertises optional `createWorkspace` and `files` capabilities; the iPhone disables unavailable features on older hosts. Snapshots include workspaces and live/saved panes; session state includes writable, local-attached and geometry information. `watch` refreshes snapshots every two seconds. See `services/shared/protocol.ts` and the Swift models for concrete shapes.

Pane `harnessId` and `activity` are optional. Activity is `working` for recognized full-line busy markers, `recent` for recent output from other harnesses, or `idle`. Codex requires its explicit busy marker so a blinking idle cursor is not reported as work. The companion scans up to 64 live agent panes with bounded concurrency; captured text stays on the host. This is a heuristic, not an agent lifecycle API.

### Workspace creation

```json
{"id":"2ac568f6-5e9f-496e-908b-ef482048e7d1","method":"createWorkspace","name":"my-project","parentDirectory":"~/projects","agent":"codex"}
```

Creation requires an approved SSH device key. `id` must be a UUID, `name` a single folder basename, `parentDirectory` an existing absolute or home-relative directory, and `agent` either `codex` (Codex plus terminal) or `terminal`. Existing folders are never reused or overwritten. The agent executable is checked before folder creation and is launched without permission-bypass flags. Arguments are quoted and tmux format expansion is escaped.

The companion serializes creation and saves stable request, workspace, and tmux identities in its own `remote-workspaces.json` before starting processes. The response is `{id,type:"workspaceCreated",workspace}`, followed by a snapshot. Retrying the same UUID with the same normalized fields resumes an incomplete operation or returns the saved workspace; changing fields with a reused UUID fails. The phone retains that UUID while its creation form stays open with unchanged fields. Connection loss cannot prove creation failed: refresh or retry unchanged before starting another request. Failed operations never delete the folder or terminate already-started sessions.

Phone-created workspaces are merged into discovery, not written into Workbench's desktop layout. The running desktop CLI does not auto-import this registry. A companion restart preserves tmux; successful creation records do not automatically restart exited sessions or sessions lost in a machine reboot.

### Read-only workspace files

```json
{"id":"list-1","method":"listFiles","workspaceId":"workspace-id","path":"images"}
{"id":"read-1","method":"readFile","workspaceId":"workspace-id","path":"images/photo.png","offset":0}
```

`path` is workspace-relative; the empty string lists its root. Directory replies contain `{id,type:"directory",directory:{path,entries:[{name,path,kind,size}],truncated}}`. Kinds are `directory`, `file`, or `symlink`. Listings stop at 500 entries or 512 KiB of entry JSON; links are visible but cannot be opened. Root lookup uses the authenticated workspace snapshot, and traversal, absolute paths, control characters, and symbolic-link components are rejected. On Linux, open descriptors are verified through `/proc/self/fd` before reading.

File replies contain `{id,type:"fileChunk",fileChunk:{path,version,size,offset,nextOffset,data,eof}}`. `data` is base64 for at most 192 KiB; files larger than 20 MiB and non-regular files are rejected. `version` fingerprints descriptor identity, size, and nanosecond modification/change times. The host checks for changes during a chunk; the phone rejects changes in version or size between chunks and validates offsets, base64, and EOF. The channel allows four concurrent file operations. There are no file-write, upload, delete, or generic SFTP operations.

The iPhone displays at most 256 KiB of UTF-8/UTF-16 text and downsampled raster images. File bytes travel through the encrypted control stream; the relay does not decode or persist them. Previews are held in app memory, not synchronized as a local workspace.

SSH terminal channel: PTY request followed by exec `workbench-attach:<discovered-tmux-name>`. Channel bytes are terminal input/output, not structured agent messages. Window-change requests are gated by current ownership/local-attachment state. Arbitrary names not discovered from Workbench's private tmux server are rejected.

## Ownership, sizing, and reconnect

The first remote attachment becomes writer when no remote writer exists. Viewers receive terminal output but their input is rejected at injection time. `takeControl` is explicit and requires an existing attachment. Disconnecting releases the lease; another existing viewer is not silently promoted.

Remote tmux clients initially attach with `ignore-size`. The host excludes its own attachment TTYs when detecting local clients. While a local client is attached, remote sizing remains ignored. Without a local client, only the remote writer contributes to terminal size; viewers mirror that size. Local input remains possible at all times.

The iPhone requests **Fit to iPhone** on the first writable state when opening or reconnecting to a session; the writer can then choose Desktop size. The companion saves the window's sizing setting and uses the phone's requested dimensions until that mode is disabled, the writer disconnects, or another device takes control. The desktop sees this smaller layout too. The previous sizing setting is restored on normal teardown. Session state includes `phoneLayout`; older hosts omit it and clients treat it as false. An abrupt host process crash (such as SIGKILL) can leave the tmux window manually sized; crash recovery is not yet persisted.

The application does not promise exactly-once delivery: an SSH write succeeding does not prove an agent consumed the input. Nothing is resent on reconnect. Compose drafts are local, may contain sensitive text, and are not a synchronized offline coding workspace. Backgrounding closes the active client connection; the app reconnects on foreground and reattaches to a still-live session.

## Limits

The relay is single-instance, uses bounded frames and per-IP/account limits, and does not persist terminal content. It still needs production load/fault/security review. There is no end-to-end delivery acknowledgement protocol, agent-specific structured chat, snapshot replay, offline execution, automatic host wake, or automated key rotation. Credentials and host approvals require an explicit operational recovery process.
