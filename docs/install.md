# Install Workbench

Workbench has a terminal CLI and a native iPhone app. Both use the same live
agents and terminals on your development machine. The repository and releases
are maintained together in `erikqu/workbench-cli`.

## Terminal CLI

```sh
curl -fsSL https://ehq.so/install | bash
work
```

Existing installations update with `work update`. The monorepo keeps the original
launcher paths, installation directory, saved workspaces, and private tmux socket.
You do not need to reinstall or migrate your sessions.

## Connect your iPhone over Tailscale

Install Tailscale on the computer and iPhone and sign in to the same tailnet.
Enable MagicDNS and HTTPS certificates in your Tailscale admin console. The
computer also needs Node.js 24 or newer and tmux.

In Workbench, click **Connect phone** beside **mermaid**. Setup checks Tailscale,
starts a user companion service, and shows a private QR code. Scan it in the
Workbench iPhone app, then enter the phone's six-digit code in the computer's
pairing dialog. The QR expires after five minutes. You can also run:

```sh
work phone pair
work phone status
```

The companion listens on loopback port 9419, with Tailscale Serve providing
private HTTPS on port 8443. Setup refuses an existing conflicting handler or
Funnel exposure. Access requires a locally approved phone key; joining the
same tailnet alone does not grant terminal access. Phone disconnection leaves
agents running, and the user service reconnects after login.

Pairing identities and grants are stored with owner-only permissions under
`~/.config/workbench-remote`. Closing the pairing dialog cancels the current QR;
the companion continues serving previously approved phones. To stop it:

- macOS: unload `~/Library/LaunchAgents/dev.workbench.remote.tailscale.plist`
  with `launchctl bootout` for your GUI domain.
- Linux: `systemctl --user disable --now workbench-phone.service`.

The iPhone app is available through TestFlight once its signed build is uploaded
and Apple enables testing. A public invitation link has not been published yet.

### Linux containers

Run the companion as the same container user as Workbench so it can reach the
saved sessions and private tmux socket. Containers without a systemd user service
need a foreground companion. In one container terminal, run:

```sh
work phone start
```

Keep it running, then open **Connect phone** or run `work phone pair` in a second
terminal in that same container. Use your container supervisor to keep the
companion running in normal use. Preserve `~/.workbench` and
`~/.config/workbench-remote` across container replacements.

The container needs Node.js 24, npm, tmux, and the Tailscale CLI. If native npm
dependencies need compilation, install Python 3, make, and a C++ compiler too.
Tailscale Serve connects to `127.0.0.1:9419` in the Tailscale daemon's network
namespace. If Tailscale runs on the Linux host, the Workbench container needs
host networking (`--network=host`) and access to the host daemon's socket
(`/var/run/tailscale/tailscaled.sock`) for its Tailscale CLI. With Tailscale inside
the container or a sidecar, share its network namespace with Workbench.
Publishing port 9419 from a bridge container alone does not expose a companion
that binds only to container loopback.

## Remote host companion

On the development machine, install tmux, then:

```sh
curl -fsSL https://ehq.so/install | bash -s -- host --relay https://YOUR-RELAY
workbench-remote setup --relay https://YOUR-RELAY
workbench-remote service
```

The first command downloads a matching archive from GitHub Releases and verifies
its SHA-256 checksum. Node is included; Git, npm, and a compiler are not needed.
The installer supports Linux with glibc and macOS, on x64 and arm64. Use the same
OS user as the CLI. Setup shows a QR code and requires explicit confirmation of
the phone's pairing code.

Use the HTTPS relay address supplied by your deployment. Self-hosting instructions
are in [the relay deployment guide](../apps/remote/docs/deployment.md). Installing
the companion does not deploy a relay or sign you into an account.

You can download archives directly from the
[latest release](https://github.com/erikqu/workbench-cli/releases/latest).
Each archive has a matching `.sha256` file. To select a release:

```sh
curl -fsSL https://ehq.so/install |
  WORKBENCH_VERSION=v0.1.70 bash -s -- host --relay https://YOUR-RELAY
```

Re-run the installer to update. It retains the prior binary directory and all
pairing configuration. Run `workbench-remote service` after updating; on Linux,
restart an already running service with
`systemctl --user restart workbench-remote.service`.

## iPhone

Install the signed app through its TestFlight or App Store link, then scan the
companion's QR code. A Mac or Xcode is not required for a TestFlight installation.

The installer exposes the official Apple link once it is published:

```sh
curl -fsSL https://ehq.so/install | bash -s -- app
```

**A public iPhone installation link has not been configured yet.** Until the
signed build is distributed, this command reports that the link is unavailable.
Source archives and unsigned simulator artifacts are not iPhone installers.

Maintainers publish a signed build using
[the iPhone distribution workflow](releasing.md). After beta approval, they set
`iphoneInstallUrl` in `distribution.json` to the actual public TestFlight or App
Store link. Release packaging publishes that link as `iphone-install-url.txt`.
