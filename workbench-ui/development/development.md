# Workbench CLI Development

Developer notes for working on the Bun + React + Silvery TUI in `workbench-ui/`.

## Requirements

- [Bun](https://bun.sh) >= 1.3.5
- `tmux`
- At least one coding-agent CLI on your `PATH` (`claude` is the default)
- [Ghostty](https://ghostty.org/) for the supported terminal experience. Other
  terminals are experimental; they may launch, but rendering, images, cursor
  behavior, mouse input, or tmux passthrough may differ.

Optional viewer tools:

- `ffmpeg` / `ffprobe` for video playback
- `mmdc` for Mermaid diagrams
- `pdftoppm` / `pdfinfo` for PDF rendering

## Development Commands

Run from `workbench-ui/`:

```bash
bun run typecheck
bun test
bun run check
bun run fix
bun run screenshot
```

The screenshot suite drives the real app in a headless-browser PTY and doubles as
a golden-master regression check. Run it pointed at the package root:

```bash
WORKBENCH_UI_CWD="$PWD" bun run screenshot
```

## Runtime Options

```bash
work [path] [--harness <id>] [--hot]
```

- `path` opens a workspace directory (defaults to the current directory).
- `--harness <id>` / `--agent <id>` picks the default agent: `claude`,
  `gemini`, `codex`, `opencode`, or `cursor`.
- `--hot` (aliases `--dev`, `--watch`) restarts the UI on source changes while
  tmux panes reattach.

`workbench-cli` is kept as the long-form command name; `work` is the shorter
install alias.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `WORKBENCH_UI_HARNESS_ID` / `WORKBENCH_UI_AGENT_ID` | Default harness id |
| `WORKBENCH_UI_CWD` | Starting workspace directory |
| `WORKBENCH_UI_THEME` | Initial theme name |
| `WORKBENCH_UI_IMAGE_PROTOCOL` | Force image rendering: `kitty`, `sixel`, or `halfblock` |
| `WORKBENCH_UI_CELL_ASPECT` | Override terminal cell aspect ratio for image sizing |
| `WORKBENCH_CLI_HOT` | Set to `1` to enable hot reload |

Persistent state is saved under `~/.workbench`, and the private tmux server uses
the socket `~/.workbench/tmux-ui.sock`.

## Architecture

`bin/workbench-cli` is a thin bash launcher that execs the Bun app in
`workbench-ui/`. The app is organized into purpose folders under
`workbench-ui/src/`:

```text
app/         the controller (lifecycle, actions, diff polling, render throttle)
state/       app state, session/harness models, persistence
terminal/    PTY panels (@xterm/headless), terminal probing, cell sizing
media/       image/Kitty/Sixel pipeline, mermaid, pdf, video, splash
ui/          theme tokens and toasts
text/        regex syntax highlighting, diffing, file-tree, editor model
components/  React/Silvery views (Workbench, sidebar, tabs, dialogs)
  viewers/   per-kind file viewers (markdown, image, pdf, video, text)
```

See the root [`AGENT.md`](../../AGENT.md) for deeper architecture, performance,
and input-handling notes.
