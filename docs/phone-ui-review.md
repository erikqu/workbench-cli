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
- Added New workspace: exclusive host folder creation with Codex + terminal or
  Terminal only. Stable request/session identities make unchanged retries safe;
  the desktop layout is never overwritten. Phone-created workspaces have their
  own companion registry.
- Added a persistent horizontal session tab strip and busy/recent-activity
  indicators. Busy tabs animate unless Reduce Motion is enabled. Switching tabs
  invalidates stale attachment callbacks and preserves per-session drafts.
- The machine workspace overview now has working/recent indicators and agent
  counts too. Active workspaces appear first, preserving order within each group;
  idle workspaces remain accessible below them.
- Added Files from the workspace list and terminal, with folder navigation,
  selectable text, downsampled images, pinch zoom, retry/empty/error states, and
  strict read-only access. File versions detect changes between download chunks.
- Replaced unconstrained file text with a native read-only text view: long source
  lines wrap to the viewport, rotation reflows them, and normal swipes scroll
  without invoking selection or the keyboard. Snapshot updates keep scroll state.
- Fixed a large-transfer disconnect found by the actual Swift client: NIOSSH's
  packet size can exceed the WebSocket limit. Host encrypted writes are now split
  into ordered, backpressured 64 KiB frames without raising the tunnel limits.

## Verification

- TypeScript typecheck and diff whitespace checks passed.
- 23 Node tests passed, including real PTYs, geometry restore, idempotent folder
  creation, tmux quoting, activity, traversal/symlink guards, file versions/limits,
  and binary reconstruction. Seven file tests also passed on isolated Linux.
- Four platform tests passed: relay authentication/pairing, encrypted SSH, real
  tmux, leases, geometry, reconnect, and revocation.
- The platform suite also passed with the actual Swift transport executable:
  workspace creation/retry, concurrent listing/PNG/chunk requests, byte-identical
  multi-chunk transfer, file versions, and recovery after a rejected request.
- Six Swift package tests passed, including new capability/activity/file models.
- Desktop UI automation passed onboarding, terminal input, tabs, resize,
  filtering, offline panes, reconnect, and disconnect.
- iPhone simulator UI automation passed vertical swipe-to-wheel handling without
  a Copy menu, menu presentation, text-size changes, keyboard shortcuts/Ctrl,
  Compose editing, landscape rotation, and phone/desktop layout switching.
  The preview uses a steady cursor so XCTest does not wait on its blink animation.
- Five simulator UI tests passed in `workbench-overview-files-final.xcresult`. In
  addition to existing controls they exercise workspace creation, tab switching,
  a working-agent indicator, directory/text/image previews, image zoom, and
  rotation, active-first workspace ordering and overview indicators. Exported
  screenshots were visually inspected; text previews are top-aligned and wrap,
  and double-tap restores image fit after zoom/rotation. The long-line regression
  failed before the fix (2790-point content on a 402-point screen), then passed
  with bounded text width, swipe scrolling, and rotation.
- Production dependency audit reported no known vulnerabilities.
- Signed device builds installed successfully on the paired iPhone. The latest
  overview/text-wrap build installed, but reopening was blocked by the phone's
  lock screen. Live device interaction needs the user's confirmation; UI
  automation uses the simulator.
- Supernova companion updated to `workspace-files-20260905`; service and relay health
  checks passed. The previous companion release remains available for rollback.

## Remaining limits

Forced process termination (SIGKILL) cannot restore a temporary tmux sizing
override. Normal detach, disconnect, and control handoff are covered. A preview
screenshot or simulator test does not prove a live phone-to-host connection;
transport behavior is tested separately by the integration suite.

The running desktop Workbench CLI does not automatically import the phone's
workspace registry into its sidebar. Existing stopped sessions are not restarted
automatically. Agent status is inferred from terminal markers/activity, not an
agent lifecycle API. File previews allow at most 20 MiB, display 256 KiB of text,
and do not follow symlinks. Large directories are truncated at 500 entries.
