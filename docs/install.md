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
