# Release gates

This is an implementation with tested backend/transport behavior, not a signed, production-approved iPhone release. Do not mark the following complete from Linux syntax checks or a successful SSH fixture alone.

## Completed locally

- TypeScript type checks and existing desktop unit tests.
- Public relay integration using a real, isolated PostgreSQL schema and tmux server.
- Separate-account isolation, exact-key pairing, expiry, remote writer takeover, local geometry preservation, reconnection and grant revocation.
- Shared Swift package compilation and protocol tests.
- Swift transport connecting through the real relay and executing input in the real tmux fixture.
- Linux x64 host archive build, bundled runtime smoke check and native PTY check.
- Deployment and build workflow configuration added; workflows not yet executed remotely.

## Before a private iPhone beta

- Run the Xcode simulator build workflow and resolve any UIKit/SwiftUI/SwiftTerm integration issues. Linux parsing does not type-check those frameworks.
- Build and sign on a Mac with your bundle ID, development team and Sign in with Apple entitlement.
- Configure the relay's Apple audience and public HTTPS hostname. Verify real Apple sign-in, cancellation, expiry and reauthentication; tests use an injected verifier rather than Apple's service.
- Exercise QR camera permission denied/allowed, manual pairing, expired/reused QR, wrong verification code, a second device, wrong account, pin mismatch and revocation.
- Test on an actual small iPhone in portrait and landscape: software/hardware keyboard, accessory keys, paste, multiline input, selection, scrollback, horizontal scrolling, compose drafts, Unicode, font sizes and long-running streaming output.
- Test each supported coding harness in its existing Workbench terminal, especially interactive confirmations and redraw behavior.
- Test Wi-Fi ↔ cellular changes, lock/unlock, app switching, force quit, airplane mode, host sleep/offline, relay restart, tmux session exit and Workbench relaunch. Confirm no process is restarted and no input is duplicated.
- Check battery, memory and backpressure under large terminal output and poor network conditions. Check that losing control really prevents input and that local terminal geometry stays intact.
- Run host packaging on each supported OS/CPU; test installation, setup, service startup after login, update and uninstall on clean machines.
- Protect relay/database credentials, restrict network exposure, test backups and recovery, and define support contacts.

## Before public App Store distribution

- Implement in-app account deletion and the corresponding server-side deletion workflow, including Sign in with Apple token revocation/lifecycle handling. This is **not implemented**. Signing out and revoking one device are not substitutes.
- Review Apple identity revocation notifications/account state, stolen-device recovery, credential expiry, key rotation and abandoned machine cleanup with realistic failure scenarios.
- Publish an accurate privacy policy and support URL; review the privacy manifest, required-reason APIs and App Store data declarations against the final build and relay logging/retention policy.
- Complete encryption export-compliance declarations for the SSH implementation. No exemption is asserted by the project template.
- Sign/notarize applicable macOS host distributions and audit redistributable Node/dependency licenses, notices and package integrity.
- Independently review authentication/pairing/authorization, parser limits, terminal escape handling, dependency security and relay denial-of-service exposure.
- Load/fault-test the single-instance relay; define user limits, resource limits, alerting, retention, recovery time and update rollback procedures. Do not scale replicas without redesigning live host routing.
- Complete accessibility and usability review on actual supported phones. Prepare screenshots, review instructions, test credentials/setup and TestFlight feedback.
- Only after these gates: archive the signed app, upload to TestFlight, complete beta validation, then submit to App Review.

The later native Mac client, offline code sync, phone file editor and remote creation of new sessions remain outside this first release's scope.
