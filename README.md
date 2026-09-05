# Workbench Remote

Continue the Workbench sessions running on your development machine from a native iPhone app. The host keeps running your agents, tools, and terminals; the phone connects to those same sessions. This is remote access, not a second copy of your workspace.

The public relay supports separate accounts and independently paired machines. Users do not need Tailscale, a VPN, public SSH access, or router port forwarding.

## Implementation status

Implemented: native iPhone app, shared Swift transport, host companion, authenticated relay, encrypted terminal transport, pairing and revocation, folder-based workspace creation, live session tabs, read-only text/image browsing, installation packaging, and automated integration tests.

The app has been built with Xcode, installed on a paired iPhone, and exercised with native simulator UI automation. A private deployment connects to Supernova over Tailscale; this is not a public production launch or TestFlight release. See the [phone UI review](docs/phone-ui-review.md) for verification boundaries and the [release checklist](docs/release-checklist.md) before public distribution. Apple account deletion/revocation integration and production hardening remain release gates.

## How it works

```text
iPhone app ── outbound HTTPS/WSS ── public relay ── outbound WSS ── host companion
    └────────────────── end-to-end SSH encryption ────────────────────┘
                                                                        │
                                                          existing Workbench tmux
```

The relay authenticates accounts, tracks device grants and routes encrypted bytes. The companion independently checks device keys approved on the host. Session names, terminal content and input travel inside SSH, not through the relay's HTTP API. The relay can see account/device/machine metadata, IP addresses, connection timing and traffic sizes.

The companion reads Workbench's saved layout and private tmux socket. It does not overwrite the desktop layout or kill sessions when a phone disconnects. New phone workspaces are saved separately and start fresh sessions only when requested. Run it as the **same OS user** as Workbench. The development machine must remain awake and online.

## Repository

| Location | Purpose |
| --- | --- |
| `apple/App` | Native iPhone UI: pairing, workspaces, tabs, terminal, files/images, drafts |
| `apple/Sources/WorkbenchCore` | API client, device identity, pinned SSH over WebSocket |
| `services/host` | Discovery, terminal attachment, workspace creation, read-only files, approvals |
| `services/relay` | Apple authentication, PostgreSQL grants and opaque tunnel routing |
| `deploy` | Single-instance HTTPS relay deployment |
| `tests/platform` | Isolated database + real tmux + encrypted relay integration tests |
| `src` | Earlier Electron desktop prototype; preserved, not the iPhone product |
| `workbench-cli` | Existing Workbench reference checkout; unchanged |

## Development

Use Node 24, npm, tmux, and Docker (or an isolated PostgreSQL database). Native dependency installation may require a C/C++ build toolchain.

```sh
npm ci
npm run check
npm run build:services
npm run package:host
```

`check` runs TypeScript checking, the existing desktop tests, and the new platform integration tests. By default the platform runner creates and removes its own PostgreSQL container. To use a test database you already run:

```sh
WORKBENCH_TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/testdb npm run test:platform
```

Never point tests at a production database. Tests create a temporary schema and their own temporary tmux server; they do not attach to your real Workbench sessions. The injected identity verifier exists only in test setup. The production server always verifies Apple identity tokens.

### iPhone build — on a Mac

Install Xcode with an iOS SDK and XcodeGen. The shared package uses Swift tools 6.0; the app targets iOS 17 or later.

```sh
swift test --package-path apple
swift scripts/make-icon.swift apple/App/Assets.xcassets/AppIcon.appiconset/icon.png
xcodegen generate --spec apple/project.yml
open apple/WorkbenchRemote.xcodeproj
```

In Xcode, select your development team and a bundle identifier you own; enable Sign in with Apple for that identifier in your developer account. Keep `APPLE_AUDIENCE` on the relay equal to the app bundle identifier. Set `WORKBENCH_RELAY_URL` to your HTTPS relay for a branded distribution, or leave it blank to populate from the companion's QR code. Persist project changes in `apple/project.yml`, because XcodeGen regenerates the project.

Build for an iPhone or simulator. The camera pairing flow needs a physical device; the manual link supports simulator testing. The checked-in GitHub workflow includes an unsigned simulator build, but it has not been executed remotely from this workspace.

The optional native transport test runs the exact Swift transport against the isolated relay and tmux fixture:

```sh
swift build --package-path apple
WORKBENCH_SWIFT_CHECK_ARGS='["apple/.build/debug/workbench-transport-check"]' npm run test:platform
```

This needs a platform with WebSocket support in `URLSession`; macOS provides it. Linux FoundationNetworking support depends on its libcurl build. The test passes an ephemeral fixture containing test credentials to the executable and deletes it afterward.

## Deploy and connect

See [deployment instructions](docs/deployment.md) for the relay, downloadable host builds, Apple configuration, and operations.

Once your HTTPS relay and host download are available, a user installs the companion, then pairs interactively:

```sh
curl --proto '=https' --tlsv1.2 -fsSLo workbench-install.sh https://relay.example.com/install.sh
# Inspect the downloaded script before running it.
bash workbench-install.sh --relay https://relay.example.com
~/.local/bin/workbench-remote setup --relay https://relay.example.com
~/.local/bin/workbench-remote service
```

On the phone, scan the QR, sign in with Apple, claim the pairing, then enter the phone's six-digit code in the companion terminal. Choose the machine, workspace, and live session. A second phone must be separately paired with the same owner's account; knowing an account password alone does not approve a new device key.

For development without installation:

```sh
npm run host -- setup --relay https://relay.example.com
npm run host -- start
```

`setup --directory /path/to/.workbench` selects a non-default Workbench directory. `WORKBENCH_REMOTE_CONFIG` selects a separate companion configuration. Never run the companion as root merely to reach another user's sessions.

## Session behavior

- One remote connection holds terminal input control. Other connections can view and explicitly take control. Local terminal input is not locked out.
- Opening a writable session automatically fits its grid to the iPhone. This temporarily changes desktop geometry too; choose Desktop size to retain the original grid and pan. Detaching restores the previous sizing policy. Read-only viewers cannot resize the writer's session.
- Tabs remain visible above the terminal. A spinner reflects a recognized agent busy marker; other harnesses can show recent output activity. These are terminal-derived indicators, not a structured agent status API.
- Backgrounding or losing connectivity detaches the phone, not the running agent. Reconnection creates a new attachment to the same live session.
- Input is never replayed automatically. Delivery can be uncertain during a network failure; inspect the terminal before resending. Unsent compose drafts stay on the phone.
- Saved but stopped sessions are shown as unavailable and are not automatically restarted.
- Relaunching the current Workbench CLI may detach another tmux client. The phone can reattach without restarting the underlying process.

### Create a workspace and browse files

Choose **New workspace** from the machine's workspace list, enter a new folder name and an existing parent folder on the host, and select Codex + terminal or Terminal only. The parent defaults to the last workspace's parent. Existing folders are never overwritten. Codex starts with its normal safety defaults. Retries with unchanged fields reuse the same request and sessions.

The phone's workspace registry is `<workbench-directory>/remote-workspaces.json`. Its folders and tmux sessions are real on the host and appear in the phone list, but the currently running desktop Workbench CLI does not automatically import them into its sidebar. Keeping this registry separate avoids overwriting the desktop's in-memory layout. Companion restarts preserve tmux sessions; host reboots do not automatically recreate them.

Use **Files** from a workspace or terminal to browse folders, read selectable text, and preview images with pinch zoom. Access is read-only, confined to that workspace, and does not follow symbolic links. Files are limited to 20 MiB, directory listings to 500 entries, and text display to 256 KiB. Supported raster formats include PNG, JPEG, GIF (first frame), HEIC, WebP, TIFF, and BMP; previews are downsampled to at most 1600 pixels on the longest edge. Modified files must be reopened if they change during download.

This implementation excludes offline code synchronization, a phone file editor, Windows hosts, collaboration between different account owners, and the later native Mac client. See [protocol and security boundaries](docs/protocol.md).
