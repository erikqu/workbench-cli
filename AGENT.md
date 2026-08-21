# AGENT.md — workbench-cli

Notes for agents working in `workbench-cli/`. This is the **Bun + React + Silvery
terminal workbench** (a TUI that drives multiple coding-agent CLIs). The real app
lives under `workbench-ui/`; the repo root mainly holds the installer, launcher,
public readme, and this agent guide.

## Layout

```
workbench-cli/
├── bin/workbench-cli     bash launcher (resolves symlinks, execs the workbench)
├── README.md             published, open-source readme
├── LICENSE               MIT
└── workbench-ui/         the workbench (Bun + React 19 + silvery), the real code
    ├── src/
    │   ├── index.ts        entrypoint (arg parse, terminal probe, TERM spoof)
    │   ├── app/            WorkbenchApp.tsx — the controller class
    │   ├── state/          state.ts, types.ts, harnesses.ts, persistence
    │   ├── terminal/       terminal-panel.ts, terminal-probe.ts, cell-size.ts
    │   ├── media/          image*, mermaid.ts, pdf.ts, video.ts, splash.ts
    │   ├── ui/             theme.ts, toast.tsx
    │   ├── text/           syntax.ts, diff.ts, editor.ts, file-tree.ts
    │   └── components/     Workbench.tsx, sidebar/tabs/dialogs + viewers/
    ├── scripts/        hot runner, screenshot suite, terminal regression driver
    ├── test-harness/   deterministic agent, shell, browser, and media fixtures
    ├── biome.jsonc     Ultracite/Biome config
    └── assets/         splash art, etc.
```

## How it runs

`bin/workbench-cli` execs `bun workbench-ui/src/index.ts`. For a new installation
the harness preference is **Codex → Cursor → Claude Code**, choosing the first
CLI found on `PATH` and falling back to Codex. Each harness defines its own
resume/fallback command in `state/harnesses.ts`; Codex and Claude both try to
resume the most recent conversation for the workspace before starting fresh.

`src/index.ts` startup order: parse args (`--harness`/`--agent`, positional
cwd) → actively probe the terminal (`probeTerminal` in `terminal/terminal-probe.ts`,
DA1 fence) for cell aspect + graphics support → spoof `TERM` to
`xterm-kitty`/`foot` so silvery's `<Image>` emits graphics → `runWorkbench()`
(exported from `app/WorkbenchApp.tsx`). Probe + TERM spoof are skipped when
`WORKBENCH_UI_SCREENSHOT=1`.

`workbench-cli update` (and `work update`) is handled entirely by the Bash
launcher before Bun or the UI starts. It reruns the checked-in installer for
the launcher-resolved package root, preserves the invoked symlink directory,
and refuses dirty source checkouts. Keep update dispatch ahead of Bun/UI
validation so it can repair an installation whose runtime dependencies are
missing or outdated.

### Build / check / run (from `workbench-ui/`)

```bash
bun install
bun run typecheck     # tsc --noEmit
bun run start         # launch the workbench (needs a TTY)
bun run dev           # launch with hot reload (bun --watch)
bun test              # unit tests
bun run check         # Ultracite/Biome lint + format check
bun run fix           # apply formatting + safe fixes
bun run screenshot    # Playwright screenshot + interaction suite
bun run test:terminal # full PTY/tmux/rendering regression matrix
```

## Hot reload

Opt-in. Enable with `WORKBENCH_CLI_HOT=1` or by passing `--hot` (aliases `--dev`,
`--watch`) to `workbench-cli`; or run `bun run dev` directly. The launcher runs
`scripts/hot-runner.ts`, which owns a clean child-process restart on source
changes.

The installed `work` symlink resolves to the installed checkout
(`~/.local/share/workbench-cli`), so in hot mode the launcher detects when the
current directory sits inside a *different* workbench-cli source checkout and
runs/watches that checkout instead — otherwise `work --hot` in a dev repo
would run the installed sources and never reload on dev edits. Detection walks
up from `$PWD` looking for `workbench-ui/src/index.ts` + `bin/workbench-cli`,
requires the checkout's `node_modules` to be installed (warns and falls back
otherwise), and can be overridden with `WORKBENCH_CLI_HOT_ROOT`. Pinned by
`workbench-ui/scripts/launcher-hot-root.test.ts` (part of `bun test`).

**A hot launch runs in its own namespace.** `state/workbench-paths.ts` resolves
the tmux socket and the persisted state file once at load: normally
`~/.workbench`, and under `WORKBENCH_CLI_HOT=1` a sibling
`~/.workbench/hot-<sha1(checkout)>`. Without this, `work --hot` and the everyday
`work` share one tmux server and one state file, and because panes attach with
`new-session -A -D` the later mount **detaches the other instance's client** —
the loser then paints a stale mirror at its own size, which shows up as an
agent's bottom-anchored input box missing entirely. The namespace is derived from
the checkout path rather than randomised, because hot reload must reattach the
same running agents after every restart; two different checkouts still separate.
Never bypass these helpers by rebuilding `~/.workbench` paths inline. Pinned by
`src/state/workbench-paths.test.ts`.

Two instances in the *same* namespace remain possible (two ordinary `work`
windows). `state/instance-lock.ts` records the owning pid/tty and the next
launch surfaces a toast naming the other instance instead of silently corrupting
a pane. It claims the namespace anyway rather than refusing, so a stale lock from
a killed run can never lock a user out. The isolated hot instance also labels
itself in the title bar so two open windows are distinguishable.

Do not replace the hot runner with native `bun --watch` or in-process
`bun --hot`. Native watch can replace the program without completing its JS
shutdown handlers; this has reproduced lost composer state and restarted coding
agents. In-process hot reload would re-run top-level terminal side effects and
stack instances fighting over stdin and PTYs.

The required handoff is serialized: the hot runner sends **SIGTERM** →
`shutdown()` saves layout + **detaches** (never kills) the tmux panels + restores
the terminal → the runner waits for exit → only then does it launch the next UI,
which reattaches the same sessions. Don't weaken or parallelize this sequence.

Hot-reload identity is part of that contract. Persist and restore both the
stable `id` and `tmux` fields for every workspace, harness, and terminal:
`activeMainTab` contains one of those IDs and cannot be restored if IDs are
regenerated. A hot launch must also skip the startup splash, because the splash
masks the reattached pane and consumes the user's first keypress. Before
changing lifecycle or persistence code, run
`bun test src/state/state.persistence.test.ts` and exercise a watched restart
with text already present in the agent composer.

## Persistence model (important)

- Each agent/terminal pane is a `TerminalPanel` backed by `@xterm/headless`,
  spawned **inside a private tmux server** at socket `~/.workbench/tmux-ui.sock`
  (never the user's tmux, never `-L`). tmux session names are persisted, so
  relaunch/hot-reload **reattaches the same running processes**.
- UI layout (sessions, harnesses, terminals, open tabs, active tab, sidebar) is
  saved via `savePersistedState` and restored by
  `loadPersistedState`/`createInitialState`.
- Explorer directory expansion is deliberately ephemeral: restored workspaces
  start with every directory collapsed.
- The Explorer header's `<` action collapses the complete workspace side pane;
  its narrow `>` rail expands the pane again. This visibility is persisted
  independently from directory expansion.
- Persistent IDs are not cosmetic: `activeMainTab` references them. Never save
  an active tab ID without saving the matching harness/terminal ID.
- `shutdown()` (SIGINT/SIGTERM/Ctrl+Q) detaches panels, never kills them.
- A user close action is different from shutdown: tab/workspace X must kill the
  backing private tmux session immediately. Persisted panes are lazy and may
  not have a `TerminalPanel` in the current process, so close by the persisted
  tmux name when the local panel map has no entry; never remove state first and
  leave the live tmux session orphaned.
- New-workspace paths may be missing. `createAgent()` resolves shell-style path
  input and creates the directory tree recursively before adding the session;
  creation failures keep the dialog open and surface an error instead of
  silently falling back to the active workspace.
- New Workspace has separate Local folder and Clone GitHub repo modes so a
  prefilled path never has to be cleared before pasting a URL. Local mode starts
  at the active workspace's parent. Clone mode starts empty and accepts GitHub
  HTTPS, SSH, or `github.com/owner/repo` input; it clones with argument-array
  `git clone` into that parent. While Git runs, an ephemeral animated card is
  shown in Sessions; success replaces it with the real selected session and
  failure removes it. Its X cancels Git and removes a partial destination only
  when that destination did not exist before cloning. Never interpolate
  repository input into a shell command.

## Overlay and close-control behavior

- The sessions pane has a framed header, a full-width New Workspace action, and
  three-row outlined cards separated by one blank row. Session names and
  Option+Shift number hints live inside the cards; do not reintroduce a topic
  row or footer shortcut legend. Selected and hovered cards use themed surfaces.
  The vertical Workbench mark has a horizontal drag grip above it; its preferred
  height is persisted and only temporarily clamped when the terminal is short.
- `? Help` opens `SessionsHelpDialog`; enhanced-keyboard terminals also toggle
  it with Ctrl+?. Never interpret legacy DEL as Help because that breaks
  Backspace. Keep the clickable header action as the universal fallback.
- Tab and session close buttons stay visible, use a three-cell hit target with
  a bold multiplication sign, and use the destructive/inverted color only on
  hover.
- Right-click menus expose directional batch closes: tabs use left/right and
  sessions use top/bottom, both with Close Others.
- Render `AnchoredOverlay` menus in Workbench's final overlay layer, after the
  main content. Rendering one inside the tab strip or sidebar allows later
  siblings to paint over it even though its state and layout are valid.
- The startup splash is the exact `888` ASCII wordmark from the root README,
  rendered as ordinary monochrome text. Image previews inside Changes use
  colored terminal-cell art. Neither surface may use Kitty/Sixel/native
  graphics because native compositors can flash above the TUI during redraws.
  Ordinary image tabs may use the best supported protocol.

## Performance — keep it fast (this was an explicit requirement)

- **Terminal output must NOT go through the full-app render.** `TerminalPanel`
  exposes `subscribe`/`getSnapshot`/`emit`; the `<Terminal>` (in
  `components/Workbench.tsx`, `MeasuredTerminalGrid`) subscribes via
  `useSyncExternalStore` so PTY frames repaint only that subtree. Routing PTY
  output through `app.render()` re-renders the whole Workbench per frame and was
  the original "terminal is slow" bug.
- **`render()` is a leading-edge throttle** (`RENDER_INTERVAL_MS = 16`): first
  change in a quiet period paints immediately (zero input latency), bursts
  coalesce to ~60fps. It runs the view listener synchronously on the leading
  edge — keep it free of render-phase re-entrancy.
- **Keep heavy modules off the cold-start path.** `jimp` (~100ms) is lazy-loaded
  via `await import("jimp")` inside the decode paths in `media/image.ts` /
  `media/splash.ts` — do not re-add a top-level `import { Jimp }`. This shaved
  ~50ms off startup.
- Highlighting in `text/syntax.ts` is regex-based and the file tree
  (`text/file-tree.ts`) uses `readdirSync` + `ignore`. `web-tree-sitter` and
  `fast-glob` were removed as dead dependencies — don't reintroduce either.
- **The harness activity poll owns its own timer.** `startHarnessActivityPolling`
  re-arms itself and nothing else restarts it, so no other scheduler may clear
  `harnessActivityTimer` — only `shutdown()` may. `scheduleDiffTick` used to
  clear it, which silently froze the animated session rail a few seconds into
  every launch (the diff loop re-schedules after every pass, and the activity
  tick spends nearly its whole 750ms cycle parked on that timeout).
- **The animated rail is why an "idle" pane must really be idle.** While any
  session is in `runningSessionIds` the rail animates, and every animation frame
  repaints cells, so the app emits bytes. `assertIdleWindows` in the terminal
  regression demands *zero* bytes from a settled pane, so the running heuristic
  must retire promptly: `TMUX_ACTIVITY_WINDOW_MS` (the output-based fallback in
  `terminal/tmux-activity.ts`) doubles as how long the rail keeps spinning after
  an agent goes quiet. Lengthening it re-breaks that gate.
- `actions()` returns a cached, stable object (`workbenchActions`) — don't
  rebuild it per render.

## Input handling gotchas

- The app entry uses `run()` from **`silvery/runtime`** (not `render()` from
  `silvery`) specifically to pass `handleTabCycling: false`, so Tab reaches the
  focused PTY for shell tab-completion instead of being swallowed by silvery's
  focus cycling.
- `terminalInputForKey` (`terminal/terminal-panel.ts`) sends `key.text ?? input` to the
  PTY, **not** `input`. Silvery's Kitty-protocol normalizes `input` to base keys
  (`!`→`1`, `A`→`a`); using `input` mangles every shifted symbol/capital. Keep
  `key.text` first.
- `TerminalPanel.write()` and `paste()` call `snapToBottomIfScrolled()` before
  forwarding user input. Keep this behavior: if a user scrolls up in a
  primary-buffer pane, xterm parks `viewportY` above `baseY`; without snapping
  back on input, later agent output makes the prompt appear to drift downward
  off the visible pane.
- The `FocusedTerminal` wrapper Box's `onWheel` exclusively owns wheel routing
  (its handler stops propagation). Silvery's runtime coalesces same-direction
  wheel bursts into ONE event whose `deltaY` accumulates the step count, and
  the `<Terminal onMouse>` callback only exposes a direction — so wheel must be
  handled where the raw `SilveryWheelEvent` magnitude is available and
  forwarded as `sendMouseWheel(..., steps)`. Collapsing a burst to one report
  strands tmux copy-mode panes in scrollback (up and down streams shrink
  unevenly, the pane never scrolls back to the bottom to auto-exit copy mode,
  and the composer disappears). Wheel events bubble: never add another
  `onWheel` handler on an ancestor pane or grid, and keep `onMouse` ignoring
  wheel, or gestures reach tmux/the harness more than once.
- Codex uses native SGR wheel events whenever its TUI enables mouse tracking.
  Older already-running Codex panes can remain inline after an update, leaving
  differential composer/status redraws in pane history with no mouse mode. Its
  `HarnessCommand` therefore keeps `wheelNavigation: "transcript"` as a runtime
  fallback only: mouse-aware panes receive native wheel reports, while inline
  panes open Codex's Ctrl+T transcript pager and receive row-level Up/Down keys.
  Scale each coalesced burst with the gesture (`transcriptBurstRows`, three rows
  per wheel tick) and cap it at one screenful, not at a small fixed number: the
  pager repaints ONCE per burst regardless of how many arrows arrive (measured
  against Codex 0.147 — twelve back-to-back Down arrows produced a single ~12.5ms
  repaint), so a low cap throttles scrolling without saving the agent any work.
  Do not use PageUp/PageDown because current Codex transcript layouts can jump
  into an unpainted blank region.
  Balanced wheel-down closes the fallback pager and returns to the composer.
  Do not map wheel input directly to PageUp/PageDown (the main composer does not
  scroll), and do not enter tmux copy mode. Keep ordinary shell and other
  harness wheel behavior intact.
- The pager transition protocol exists to make wheel scrolling feel continuous;
  measured against real Codex 0.147 (open <15ms, close <10ms, but arrow keys
  sent during the pager's startup window are silently DISCARDED):
  - Open with Ctrl+T ALONE. Queue the scroll rows (`transcriptPendingRows`) and
    flush them only when the pager header has painted; writing them with the
    Ctrl+T loses them and the first gesture scrolls nothing.
  - Hold the presented frame (`transcriptFrameHold`, bounded by a timer) across
    open AND close so the cleared alternate screen / stale primary screen never
    paint — that intermediate frame is the "flash".
  - The at-bottom auto-close waits `TRANSCRIPT_WHEEL_SETTLE_MS` (hundreds of
    ms, not tens): an up/down/up reversal must never pay a close->reopen
    alt-screen cycle. A wheel-up that lands while the pager is closing is
    queued (`transcriptReopenSteps`) and reopens the pager — never dropped.
  - `transcriptWheelClosing` must always be time-bounded: if the header grep
    never resolves, the bounded hold flushes `pendingTranscriptInput` anyway,
    or typed keys vanish into a permanently-closing pager.
- Focus harness/terminal panes from the embedded terminal's `onMouse` callback,
  not only an ancestor `onMouseDown`; selection handling can consume the event
  before it bubbles. In a focused harness, Ctrl+C copies an active Silvery
  selection but remains PTY interrupt with no selection, while Ctrl+V requests
  the host clipboard through OSC 52 and uses the existing paste path. Copy an
  active selection from a raw-key observer because Silvery clears the range
  before ordinary input dispatch; use the ordinary handler only to consume the
  chord so it is not also forwarded to the PTY.
- **Quick-switch (`Workbench.handleKey`)**: `Option/Alt+1..9` jumps to that tab in
  the active session; `Option/Alt+Shift+1..9` jumps to that session;
  `Option/Alt+Space` cycles forward through sessions (wraps). `key.meta`
  is true for Alt/Option in both legacy (`ESC`-prefixed, e.g. `\x1b2`) and Kitty
  (`CSI 50;3u`) modes, and `Shift+digit` always normalizes back to the base digit
  (`!`→`1`) with `key.shift` set — so `key.meta && input==="2"` and
  `key.meta && key.shift && input==="1"` are reliable across terminals. Handle
  this **before** the terminal/harness focus branches so it works while a CLI is
  focused (agent CLIs never bind Alt+digit). The matching index badges live in
  `MainTabs.tsx` (tabs) and `SessionsSidebar.tsx` (session cards). The Help
  overlay is the consolidated shortcut reference; there is no sidebar footer
  legend.

## Terminal-corruption workflow

- Do not change renderer, cursor, resize, or tmux behavior until
  `bun run test:terminal` has a deterministic failing frame. A pane that looks
  clean after output stops does not disprove a transient streaming failure, but
  a browser grid sampled while xterm still has queued writes is not a settled
  frame either. Read the grid, parser queue counters, and DEC 2026 mode in one
  atomic browser evaluation before declaring a regression red.
- The plain-shell regression must cross the bottom edge, include an unthrottled
  burst, scroll up and naturally back down while output continues, and run with
  seeded ANSI fragmentation (`--chunk-seed=N`). Keep `convertEol: false` in the
  outer xterm fixture so it has real-terminal LF semantics.
- `bun run test:terminal` runs the default alt-screen fixture, a mouse-aware
  Codex alt-screen fixture, generic `--inline`, and `--inline --codex` (plus the
  sticky transcript variant). The generic inline fixture renders
  Claude-Code-style (primary
  buffer, no mouse tracking, Ink-style bottom-block repaint, history in tmux
  scrollback) so wheel gestures exercise tmux copy-mode enter/exit. The inline
  pass must include zero-delay wheel bursts in BOTH directions across several
  cycles — that is the shape that reproduced the stranded-in-scrollback
  composer bug — and needs `--chunk-seed` to keep timing adversarial. The Codex
  pass preserves stale differential footer blocks in primary-buffer history
  while keeping the live viewport clean; it must prove that wheel navigation
  uses the native transcript and never exposes duplicated, missing, or displaced
  composer markers through tmux copy mode. It must also prove that wheel-up
  actually leaves the live composer for conversation history and wheel-down
  returns to exactly one composer; a stationary composer is broken scrolling.
- If the deterministic fixture stays green, stop before applying a speculative
  fix. Relaunch with `workbench-cli --terminal-trace` and reproduce once. The
  trace is written to `~/.workbench/terminal-trace.ndjson`; it contains only
  dimensions, buffer positions, opaque per-process row IDs, byte counts, and
  control-sequence counts -- never terminal text or raw ANSI. A custom path can
  be set with `WORKBENCH_TERMINAL_TRACE=/path/to/trace.ndjson`.
- A detached harness can retain its old bottom-anchored composer after tmux
  resizes the pane on reattach: the pane geometry changes, but a dormant TUI can
  miss that attach-time `SIGWINCH` and leave blank rows below its old cursor.
  Persistent harness panels therefore send one coalesced redraw signal to the
  pane process group after attach/resizes settle. Do not remove it unless the
  dormant-old-size integration regression is replaced with equivalent coverage.

## Viewers

File tabs are rendered by `components/viewers/` — a `SyntaxViewer.tsx` dispatcher
that picks a per-kind viewer (`MarkdownViewer`, `ImageViewer`, `PdfViewer`,
`VideoViewer`, `TextEditor`) sharing `shared.ts` helpers.
Markdown tabs open as a **rendered Preview** by default and carry a small
`Preview | Source` segmented toggle in the viewer header (under the main tab
strip); Source shows the line-numbered, syntax-highlighted raw `.md`. The mode is
per-tab (`EditorTab.mdView`, default `"preview"`), set via
`actions.setMarkdownView(path, mode)`, and is in-memory only (resets to preview
on relaunch/hot-reload). File editing is not wired in the UI yet — text viewers
are scrollable/read-only displays, though the state layer still carries dirty
buffer/save plumbing for future editor work.

## Silvery: authority + conformance

The workbench is built on **silvery** (v0.21.1). Consult the installed package
types/source plus upstream Silvery docs before changing rendering, input, focus,
theming, or the embedded terminal. Our usage was cross-referenced against
Silvery's intended APIs:

Validated as canonical (do not "fix" these — they match silvery's intended API):

- **`run()` from `silvery/runtime`** with `handleTabCycling: false`. The source
  (`ag-term/src/runtime/event-handlers.ts`) documents this exact opt-out so
  `Tab`/`Shift+Tab` reach `useInput` instead of focus cycling — the
  "Claude-Code-style agent CLI" pattern. Ours uses it so Tab reaches the PTY.
- **`<Terminal terminal={panel} revision={n} …>`**: silvery's `<Terminal>`
  *deliberately does not subscribe* to the backend; the consumer must drive
  repaints via the `revision` prop. Our `MeasuredTerminalGrid` does this with
  `useSyncExternalStore(panel.subscribe, panel.getSnapshot)` → `revision`. The
  `TerminalReadable` shape (`cols`/`rows`/`getLines()`/`getCursor()`) is what
  `TerminalPanel` implements.
- **`key.text ?? input`** in `terminal/terminal-panel.ts`: the `Key.text` docstring in
  `ag/src/keys.ts` says verbatim to use `text` (not the normalized `input`,
  which maps shifted chars to base keys) for text insertion.
- **`useBoxRectDangerously`**: we already use the current name (silvery renamed
  `useBoxRect` and added a lint fence).
- **Theme**: `<ThemeProvider tokens={tokens}>` with a Sterling-derived theme
  (`ui/theme.ts`) themes all built-in components and resolves bare `$tokens`. We
  intentionally pass pre-resolved hex (`colors.*`) to our own `Box`/`Text` and
  the terminal/image renderers that need literal colors.

Intentional, documented deviations (silvery discourages these in general — keep
the rationale if you touch them):

- `terminal/terminal-probe.ts` uses the `wasRaw` + `stdin.setRawMode`/`stdin.on("data")`
  probe shape that silvery's CLAUDE.md bans *inside silvery*. Ours runs at the
  app level **before** `run()` owns stdin, bails if another reader exists
  (`listenerCount("data") > 0`), and is fully awaited before `run()` — we need
  cell-aspect/graphics results to set `TERM` before the renderer starts.
- `writeRawStdout` (kitty-graphics-over-tmux passthrough in
  `media/image-protocol.ts`, used by `components/viewers/ImageViewer.tsx`) writes
  stdout directly because silvery's `<Image>` can't do tmux passthrough
  placeholders.
- Viewers reimplement scrolling (non-`nav` `ListView` + container `onWheel` +
  `useInput`) instead of built-in nav — built-in nav scrolled 1 row/tick and
  only when focused. Revisit if silvery's scroll API improves.

## Harnesses

Agent backends are defined in `src/state/harnesses.ts`: `cursor`, `claude`,
`gemini`, `codex`, and `opencode`. Each maps to a `command()` spawned in the
session's cwd. `selectDefaultHarnessId()` probes the preference order Codex,
Cursor, then Claude Code and falls back to Codex. Pick another with
`--harness <id>` / `--agent <id>` or `WORKBENCH_UI_HARNESS_ID`.

Re-selecting the active harness type is an explicit restart. It keeps the tab
identity but kills the backing tmux session so the panel starts cleanly. The
`↻` control beside `switch ...` invokes the same path.

## Screenshot suite & fixtures (gotcha)

`bun run screenshot` builds a synthetic state from the package root
(`createScreenshotState` in `state/state.ts`) that opens fixtures
`test-harness/sample.ts`, `README.md`, and
`test-harness/{sample.png,sample.gif,diagram.md,sample.pdf,sample.mp4}`. The
screenshot script explicitly sets `WORKBENCH_UI_CWD` to `workbench-ui/`, so an
exported shell value cannot redirect the fixtures.

`test-harness/sample.ts` is the editor/explorer fixture: it is intentionally
decoupled from the source tree and excluded from Biome formatting
(`biome.jsonc`) so the editor screenshot stays pixel-deterministic across
reorganization and reformatting passes. Don't move or reformat it.

Run it from `workbench-ui/`:

```bash
bun run screenshot
```

Screenshots land in `artifacts/screenshots/`.

## Releases

The version in `workbench-ui/package.json` and the Git tag must agree. Releases
are triggered by pushing `v<version>`; `.github/workflows/release.yml` installs
with the lockfile, typechecks, tests, packages a source tarball, and creates the
GitHub Release. Do not tag until the release commit is already on `main`.

## Style

ASCII-safe output, no emojis (matches the repo-root conventions). True-color
theme tokens live in `src/ui/theme.ts`. Formatting/linting is handled by
Ultracite/Biome (`biome.jsonc`); run `bun run check` before committing.
