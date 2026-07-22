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
    ├── scripts/        screenshot.ts (Playwright harness) + transient probes
    ├── test-harness/   harness server + fixtures used by the screenshot tests
    ├── biome.jsonc     Ultracite/Biome config
    └── assets/         splash art, etc.
```

## How it runs

`bin/workbench-cli` execs `bun workbench-ui/src/index.ts`. The default harness is
**Claude Code** (`claude` on PATH); by default it resumes the most recent
conversation for the session's cwd (`claude --continue`) and falls back to a
fresh `claude` when there is nothing to resume.

`src/index.ts` startup order: parse args (`--harness`/`--agent`, positional
cwd) → actively probe the terminal (`probeTerminal` in `terminal/terminal-probe.ts`,
DA1 fence) for cell aspect + graphics support → spoof `TERM` to
`xterm-kitty`/`foot` so silvery's `<Image>` emits graphics → `runWorkbench()`
(exported from `app/WorkbenchApp.tsx`). Probe + TERM spoof are skipped when
`WORKBENCH_UI_SCREENSHOT=1`.

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
```

## Hot reload

Opt-in. Enable with `WORKBENCH_CLI_HOT=1` or by passing `--hot` (aliases `--dev`,
`--watch`) to `workbench-cli`; or run `bun run dev` directly. The launcher runs
`scripts/hot-runner.ts`, which owns a clean child-process restart on source
changes.

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
- UI layout (sessions, harnesses, terminals, open tabs, active tab, sidebar,
  expanded dirs) is saved via `savePersistedState` and restored by
  `loadPersistedState`/`createInitialState`.
- Persistent IDs are not cosmetic: `activeMainTab` references them. Never save
  an active tab ID without saving the matching harness/terminal ID.
- `shutdown()` (SIGINT/SIGTERM/Ctrl+Q) detaches panels, never kills them.

## Overlay and close-control behavior

- Tab and session close buttons stay visible, use a three-cell hit target with
  a bold multiplication sign, and use the destructive/inverted color only on
  hover.
- Right-click menus expose directional batch closes: tabs use left/right and
  sessions use top/bottom, both with Close Others.
- Render `AnchoredOverlay` menus in Workbench's final overlay layer, after the
  main content. Rendering one inside the tab strip or sidebar allows later
  siblings to paint over it even though its state and layout are valid.

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
- The embedded `<Terminal onMouse>` exclusively owns wheel routing. Silvery
  wheel events bubble, so adding `onWheel` handlers to its parent pane or grid
  sends every physical gesture to tmux/the harness more than once and can
  corrupt an agent's inline redraw history while it is streaming.
- **Quick-switch (`Workbench.handleKey`)**: `Option/Alt+1..9` jumps to that tab in
  the active session; `Option/Alt+Shift+1..9` jumps to that session;
  `Option/Alt+Space` cycles forward through sessions (wraps). `key.meta`
  is true for Alt/Option in both legacy (`ESC`-prefixed, e.g. `\x1b2`) and Kitty
  (`CSI 50;3u`) modes, and `Shift+digit` always normalizes back to the base digit
  (`!`→`1`) with `key.shift` set — so `key.meta && input==="2"` and
  `key.meta && key.shift && input==="1"` are reliable across terminals. Handle
  this **before** the terminal/harness focus branches so it works while a CLI is
  focused (agent CLIs never bind Alt+digit). The matching index badges live in
  `MainTabs.tsx` (tabs) and `SessionsSidebar.tsx` (rows + `⌥`/`⌥⇧` legend).

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
- If the deterministic fixture stays green, stop before applying a speculative
  fix. Relaunch with `workbench-cli --terminal-trace` and reproduce once. The
  trace is written to `~/.workbench/terminal-trace.ndjson`; it contains only
  dimensions, buffer positions, opaque per-process row IDs, byte counts, and
  control-sequence counts -- never terminal text or raw ANSI. A custom path can
  be set with `WORKBENCH_TERMINAL_TRACE=/path/to/trace.ndjson`.

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
`gemini`, `codex`, `opencode`, ... Each maps to a `command()` spawned in the
session's cwd. New users default to whichever of Cursor or Claude Code is on
`PATH` (`defaultHarnessId()` probes each spec's `bin`, Cursor preferred); pick
another with `--harness <id>` / `--agent <id>` or `WORKBENCH_UI_HARNESS_ID`.

## Screenshot suite & fixtures (gotcha)

`bun run screenshot` builds a synthetic state from `cwd` (`createScreenshotState`
in `state/state.ts`) that opens fixtures `test-harness/sample.ts`, `README.md`,
and `test-harness/{sample.png,diagram.md,sample.pdf,sample.mp4}`. The harness
inherits `WORKBENCH_UI_CWD` from the environment, so if your shell exports
`WORKBENCH_UI_CWD` pointing elsewhere (e.g. `/mnt/nvme/programs`), those fixtures
don't exist and several checks fail with ENOENT
(explorer/markdown/image/mermaid/pdf/video/changes/new-agent/session-row).

`test-harness/sample.ts` is the editor/explorer fixture: it is intentionally
decoupled from the source tree and excluded from Biome formatting
(`biome.jsonc`) so the editor screenshot stays pixel-deterministic across
reorganization and reformatting passes. Don't move or reformat it.

Run it pointed at the workbench so all checks pass:

```bash
WORKBENCH_UI_CWD="$PWD" bun run screenshot   # from workbench-ui/
```

Screenshots land in `artifacts/screenshots/`.

## Style

ASCII-safe output, no emojis (matches the repo-root conventions). True-color
theme tokens live in `src/ui/theme.ts`. Formatting/linting is handled by
Ultracite/Biome (`biome.jsonc`); run `bun run check` before committing.
