# Phone UI review — 2026-09-05

Reviewed the first-party iOS app and core transport, companion, relay, desktop
client, shared protocol, and build/test paths. SwiftTerm was checked at the
integration, layout, font, and gesture boundaries; this was not a complete audit
of vendored dependencies.

## Changes

- The renderer preview now uses the actual navigation and terminal screen.
  It is visibly labelled as sample data and does not read credentials or connect.
- Added a labelled Menu button, text-size settings, keyboard visibility control,
  Compose, and a compact, horizontally scrollable terminal shortcut row.
- Replaced desktop mouse-selection drags with vertical mouse-wheel gestures for
  tmux/TUI scrollback. Local scrollback and oversized desktop-grid panning remain
  available; copying requires a deliberate long press or text selection.
- Terminal geometry uses SwiftTerm's own cell measurements. Desktop-sized
  sessions can be panned; the explicit phone-layout control fits the remote grid.
- Sessions automatically request phone layout on their first writable state
  (including reconnection). A manual desktop-size choice lasts until reopening.
  Read-only viewers cannot resize another writer's terminal. The screen title
  comes from the containing workspace, not the agent/pane name.
- Phone layout overrides tmux sizing temporarily, then restores the original
  explicit or inherited policy (and dimensions for manual sizing). Geometry work
  is serialized, and tmux window queries use an exact session/window target.
- Reattachment resets resize deduplication and ignores callbacks from older
  terminal attachments. Text-size preferences persist on the phone.
- macOS installs and host packaging repair node-pty's executable spawn helper.

## Verification

- TypeScript typecheck and diff whitespace checks passed.
- Six Node tests passed, including real PTYs and inherited/manual sizing restore.
- Four platform tests passed: relay authentication/pairing, encrypted SSH, real
  tmux, leases, geometry, reconnect, and revocation.
- Four Swift package tests passed.
- Desktop UI automation passed onboarding, terminal input, tabs, resize,
  filtering, offline panes, reconnect, and disconnect.
- iPhone simulator UI automation passed vertical swipe-to-wheel handling without
  a Copy menu, menu presentation, text-size changes, keyboard shortcuts/Ctrl,
  Compose editing, landscape rotation, and phone/desktop layout switching.
  The preview uses a steady cursor so XCTest does not wait on its blink animation.
- Production dependency audit reported no known vulnerabilities.
- Signed device builds installed successfully on the paired iPhone; the swipe
  fix was also launched successfully. The latest auto-fit/workspace-title update
  installed, but reopening was blocked by the phone's lock screen. Live device
  interaction needs the user's confirmation; UI automation uses the simulator.
- Supernova companion updated to `phone-layout-20260905`; service and relay health
  checks passed. The previous companion release remains available for rollback.

## Remaining limits

Forced process termination (SIGKILL) cannot restore a temporary tmux sizing
override. Normal detach, disconnect, and control handoff are covered. A preview
screenshot or simulator test does not prove a live phone-to-host connection;
transport behavior is tested separately by the integration suite.
