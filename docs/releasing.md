# Workbench releases

The CLI, iPhone app, host companion, and relay share one version. The canonical
repository remains `erikqu/workbench-cli`, preserving its stars, history, issues,
and installer links.

## Source and host release

1. Run `npm run version:set -- X.Y.Z`, then `npm run check`.
2. Commit and push to `main`. Wait for the CLI, remote integration, and native
   iPhone simulator checks.
3. Tag that commit `vX.Y.Z` and push the tag.
4. Wait for **Release** to build all four host platforms and publish the release.

The version check rejects a tag that differs from any product's package version
or the iPhone marketing version. Publication waits for every package to succeed.
Release assets include:

- The compatible `workbench-cli-vX.Y.Z.tar.gz` source package.
- `workbench-vX.Y.Z.tar.gz`, containing the entire monorepo.
- Host packages for Linux/macOS, x64/arm64, each with Node and the native PTY.
- A SHA-256 sidecar for every archive.
- The shared `install.sh`, standalone `install-host.sh`, and `distribution.json`.
- `iphone-install-url.txt` once an official iPhone install URL is configured.

A manual **Release** workflow run against a branch builds and tests the same
artifacts without creating a public release. Packages can be downloaded from the
workflow's artifacts for validation. A native binding smoke test runs with each
host archive's actual bundled runtime before it can be published.

## iPhone distribution

The **iPhone TestFlight** workflow signs an existing version tag and uploads it
to App Store Connect. It requires a paid Apple developer team and an existing
App Store Connect app. The bundle ID must have Sign in with Apple enabled and
match the relay's `APPLE_AUDIENCE`.

Configure a GitHub environment named `apple-distribution`:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `APPLE_TEAM_ID` | Apple developer team ID |
| Variable | `APPLE_BUNDLE_ID` | Registered app bundle identifier |
| Variable | `WORKBENCH_RELAY_URL` | Optional default HTTPS relay; blank uses the pairing QR |
| Secret | `APPLE_CERTIFICATE_P12` | Base64-encoded Apple Distribution identity, including its private key |
| Secret | `APPLE_CERTIFICATE_PASSWORD` | Password for the P12 |
| Secret | `APPLE_PROVISIONING_PROFILE` | Base64-encoded App Store distribution profile |
| Secret | `APP_STORE_CONNECT_KEY_ID` | API key ID |
| Secret | `APP_STORE_CONNECT_ISSUER_ID` | API issuer ID |
| Secret | `APP_STORE_CONNECT_PRIVATE_KEY` | The `.p8` private key contents |

Store credentials in GitHub's secret interface; do not commit them or paste them
into issue bodies or build logs. The workflow validates the profile's team,
bundle identifier, expiry, and distribution type, imports the certificate into
a temporary keychain, and removes the signing files when it finishes.

Run **iPhone TestFlight** with the released tag. A successful upload means the
build reached App Store Connect; it does not mean Apple has processed or approved
it, or that an external user can install it.

In App Store Connect, complete the build's encryption/export information, beta
review information, and external testing group. After the build is approved,
enable the group's public link and verify installation on an iPhone. Set that
real `https://testflight.apple.com/join/...` URL in `distribution.json`.
An App Store URL may replace it after an App Store release.

To publish a newly activated install link without changing binaries, commit the
verified link on `main`, run `npm run package:release`, and upload only the new
`iphone-install-url.txt` and updated `distribution.json` to the current release:

```sh
gh release upload vX.Y.Z release/iphone-install-url.txt release/distribution.json --clobber
```

Verify that the shared installer prints the correct link before announcing app
availability. The [app release checklist](../apps/remote/docs/release-checklist.md)
records product requirements beyond packaging, including account lifecycle and
real-device validation.

For a local signed build on an already configured Mac, run
`bash scripts/release-ios.sh --help`. The script exports an IPA by default;
`--upload` explicitly uploads it through fastlane.
