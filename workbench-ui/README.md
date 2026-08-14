# Workbench UI

The Bun + React + Silvery package behind Workbench CLI. It renders the
full-screen terminal workbench and owns workspace state, persistent agent and
shell panes, file previews, Git changes, input routing, and terminal rendering.

## Requirements

- Bun 1.3 or newer
- `tmux`
- At least one supported coding-agent CLI
- Ghostty for the supported terminal experience

Optional preview tools are `ffmpeg`/`ffprobe` for video, `mmdc` for Mermaid,
and `pdftoppm`/`pdfinfo` for PDFs.

## Run Locally

From this directory:

```bash
bun install
bun run start
```

The normal installed entry points are `work` and `workbench-cli`. The launcher
resolves its checkout, handles `update` and hot mode, sets the starting cwd, and
executes `src/index.ts`.

```bash
work [path] [--harness <id>] [--hot]
```

- `path` defaults to the current directory.
- `--harness <id>` and `--agent <id>` choose the initial harness.
- `--hot`, `--dev`, and `--watch` use the application-owned restart runner.
- `--terminal-trace` writes metadata-only rendering diagnostics.

Harness IDs are `codex`, `cursor`, `claude`, `gemini`, and `opencode`. Automatic
selection prefers the first installed CLI in the order Codex, Cursor, Claude
Code, then falls back to Codex.

## Development Commands

```bash
bun run typecheck       # TypeScript, no emit
bun test                # unit + integration tests
bun run check           # Ultracite/Biome validation
bun run fix             # formatting and safe fixes
bun run screenshot      # browser-backed interaction/screenshot suite
bun run test:terminal   # complete PTY/tmux/rendering regression matrix
bun run dev             # serialized hot-reload runner
```

Screenshot artifacts are written under `artifacts/screenshots/`. The script
sets its fixture cwd to this package automatically; no `WORKBENCH_UI_CWD`
override is required for the standard run.

## Runtime Model

Each workspace session owns:

- One or more coding-agent harness tabs.
- One or more shell terminals rooted in the workspace directory.
- A per-workspace top-tab set containing harnesses, terminals, Changes, and
  opened files.
- Explorer expansion state and the selected Git diff.

Harness and shell panes are `TerminalPanel` instances backed by Bun PTYs,
`@xterm/headless`, and named sessions on a private tmux server. Stable IDs and
tmux names are persisted so a normal relaunch or hot restart can reattach them.
Closing a pane kills it; shutting down the app detaches it.

State is stored under `~/.workbench`, including:

```text
~/.workbench/workbench-ui-state.json
~/.workbench/tmux-ui.sock
~/.workbench/terminal-trace.ndjson   # only when tracing is enabled
```

## Source Layout

```text
src/
├── index.ts        argument parsing, host-terminal probe, runtime startup
├── app/            WorkbenchApp controller and lifecycle
├── components/     Silvery views, dialogs, tabs, sidebars, viewers
├── state/          models, persistence, harness definitions
├── terminal/       PTY/tmux/xterm adapter, input, tracing, terminal probes
├── media/          image protocols, PDF, Mermaid, video, splash
├── text/           file tree, syntax, diff, editor model
└── ui/             theme, pane layout, toasts
```

The major ownership boundaries are:

- `src/app/WorkbenchApp.tsx`: lifecycle, state mutation, panel registry,
  persistence, file watching, diff/activity polling, and top-level rendering.
- `src/components/Workbench.tsx`: shell layout, overlay ordering, clipboard
  handling, and global keyboard routing.
- `src/terminal/terminal-panel.ts`: PTY/tmux ownership, xterm state, viewport
  behavior, frame publication, and the `TerminalReadable` interface.

Terminal output must remain on `TerminalPanel.subscribe` →
`useSyncExternalStore` → Silvery `<Terminal revision={...}>`. Sending PTY output
through the whole-app render loop causes avoidable latency and rendering races.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `WORKBENCH_UI_CWD` | Starting workspace when no positional path is supplied |
| `WORKBENCH_UI_HARNESS_ID` / `WORKBENCH_UI_AGENT_ID` | Initial harness ID |
| `WORKBENCH_UI_THEME` | Initial theme (`dark`, `light`, `midnight`, `amber`, `red`, `forest`) |
| `WORKBENCH_UI_IMAGE_PROTOCOL` | Force `kitty`, `sixel`, or `halfblock` rendering |
| `WORKBENCH_UI_CELL_ASPECT` | Override terminal cell aspect ratio |
| `WORKBENCH_UI_PRESERVE_DIM=1` | Preserve SGR dim in mirrored terminals |
| `WORKBENCH_CLI_HOT=1` | Enable serialized hot reload |
| `WORKBENCH_CLI_HOT_ROOT` | Override the source checkout used by hot mode |
| `WORKBENCH_TERMINAL_TRACE=1` | Write the default metadata-only trace |
| `WORKBENCH_TERMINAL_TRACE=/path/file.ndjson` | Write trace metadata to a custom path |
| `WORKBENCH_SCREENSHOT_QUERY` | Browser fixture query, such as `fontSize=16&lineHeight=1.15` |

Variables beginning `WORKBENCH_UI_SCREENSHOT`, `WORKBENCH_UI_E2E`, or
`WORKBENCH_E2E_` are internal test-fixture controls rather than supported user
configuration.

## More Documentation

- [Development guide](development/development.md)
- [Repository engineering invariants](../AGENT.md)
- [Public README](../README.md)
