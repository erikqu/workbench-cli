# Workbench CLI

![Workbench CLI](workbench-ui/assets/images/sample.png)

```text
888       888                  888      888                                 888
888   o   888                  888      888                                 888
888  d8b  888                  888      888                                 888
888 d888b 888  .d88b.  888d888 888  888 88888b.   .d88b.  88888b.   .d8888b 88888b.
888d88888b888 d88""88b 888P"   888 .88P 888 "88b d8P  Y8b 888 "88b d88P"    888 "88b
88888P Y88888 888  888 888     888888K  888  888 88888888 888  888 888      888  888
8888P   Y8888 Y88..88P 888     888 "88b 888 d88P Y8b.     888  888 Y88b.    888  888
888P     Y888  "Y88P"  888     888  888 88888P"   "Y88888 888  888  "Y8888P 888  888
```

A terminal workbench that runs coding-agent CLIs side by side. Each workspace
gets a persistent, tmux-backed pane for an agent (Claude Code, Gemini, Goose,
OpenCode, Cursor, ...), an integrated file Explorer, extra shell terminals, and
rich read-only viewers for the files you are working on — all in one full-screen
TUI.

```bash
curl -fsSL https://raw.githubusercontent.com/erikqu/workbench-cli/main/install.sh | bash
```

Built with [Bun](https://bun.sh), [React 19](https://react.dev), and
[Silvery](https://www.npmjs.com/package/silvery).

## Highlights

- **Multiple agents, side by side.** A left sidebar lists workspaces; each is its
  own agent session with an independent tab strip (harness panes, terminals, and
  open files). Switching workspaces swaps the whole strip and restores it on the
  way back.
- **Pluggable harnesses.** Claude Code is the default; switch to Gemini, Goose,
  OpenCode, or the Cursor agent with one flag.
- **Persistent sessions.** Agent and terminal panes run on a private tmux server,
  so relaunching (or a hot-reload restart) detaches and reattaches the *same live
  processes* with tabs intact.
- **Rich viewers.** Syntax-highlighted text, Preview/Source markdown, images
  (Kitty graphics / Sixel / true-color half-block fallback), PDFs, video
  playback, and rendered Mermaid diagrams.
- **Changes tab.** A live git working-tree diff per workspace, with a sidebar
  badge when files have changed.
- **Themes and quick-switch.** Cycle true-color themes and jump between tabs and
  workspaces with ergonomic `Option`/`Alt` chords.

## Requirements

- [Bun](https://bun.sh) >= 1.3.5 (the runtime and package manager; the built-in
  PTY support that backs the agent/terminal panes landed in 1.3.5)
- `tmux` (persistent agent/terminal panes)
- At least one coding-agent CLI on your `PATH` (e.g. `claude` for the default
  harness)
- A terminal that speaks the Kitty graphics protocol for crisp inline images —
  ideally [Ghostty](https://ghostty.org) (also [Kitty](https://sw.kovidgoyal.net/kitty/)).
  Sixel terminals work too, and everything else falls back to true-color
  half-block art.

Optional, for the corresponding viewers (each degrades gracefully if missing):

- `ffmpeg` / `ffprobe` — video playback
- `mmdc` ([mermaid-cli](https://github.com/mermaid-js/mermaid-cli)) — Mermaid
  diagrams rendered as images
- `pdftoppm` / `pdfinfo` (Poppler) — PDF page rendering

## Install

### Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/erikqu/workbench-cli/main/install.sh | bash
```

This installs Bun if it is missing, checks out the source into
`~/.local/share/workbench-cli`, runs `bun install`, and symlinks the launcher
to `~/.local/bin/workbench-cli`. Pin a specific release with
`WORKBENCH_CLI_REF=v0.1.0`, or change the locations with `WORKBENCH_CLI_HOME` /
`WORKBENCH_CLI_BIN`. Tagged builds are published on the
[Releases](https://github.com/erikqu/workbench-cli/releases) page.

### Manual install

```bash
git clone https://github.com/erikqu/workbench-cli.git
cd workbench-cli/workbench-ui
bun install
```

Make the launcher available on your `PATH` (optional but recommended):

```bash
ln -s "$PWD/../bin/workbench-cli" ~/.local/bin/workbench-cli
```

## Run

From anywhere, launch the workbench in the current directory:

```bash
workbench-cli
```

Or run it directly without the launcher (from `workbench-ui/`):

```bash
bun run start
```

### Options

```bash
workbench-cli [path] [--harness <id>] [--hot]
```

- `path` — workspace directory to open (defaults to the current directory).
- `--harness <id>` / `--agent <id>` — pick the default agent backend: `claude`
  (default), `gemini`, `goose`, `opencode`, or `cursor`.
- `--hot` (aliases `--dev`, `--watch`) — restart on source changes; near-seamless
  thanks to tmux reattachment.

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+T` | New terminal in the active workspace |
| `Ctrl+N` | New workspace (folder picker) |
| `Ctrl+H` | Add a harness (agent) to the active workspace |
| `Ctrl+B` | Toggle the sessions sidebar |
| `Ctrl+W` | Close the active file or terminal tab |
| `Ctrl+S` | Save the active file tab |
| `Ctrl+Q` | Quit |
| `Tab` / `Shift+Tab` | Cycle focus (or sent to the focused agent/terminal) |
| `Esc` | Return focus to the agent / editor |
| `Option+1..9` | Jump to that tab in the active workspace |
| `Option+Shift+1..9` | Jump to that workspace |
| `Option+Space` | Cycle to the next workspace |
| `Option+Tab` | Cycle the UI theme (`Option+Shift+Tab` reverses) |
| `PageUp` / `PageDown` | Scroll the focused agent / terminal scrollback |

The top-right `[+]` menu opens with a click: `n` new workspace, `h`/`Enter` add a
harness, `t` new terminal.

## Configuration

Behavior is driven by environment variables:

| Variable | Purpose |
| --- | --- |
| `WORKBENCH_UI_HARNESS_ID` / `WORKBENCH_UI_AGENT_ID` | Default harness id |
| `WORKBENCH_UI_CWD` | Starting workspace directory |
| `WORKBENCH_UI_THEME` | Initial theme name |
| `WORKBENCH_UI_IMAGE_PROTOCOL` | Force image rendering: `kitty`, `sixel`, or `halfblock` (auto-detected by default) |
| `WORKBENCH_UI_CELL_ASPECT` | Override terminal cell aspect ratio for image sizing |
| `WORKBENCH_CLI_HOT` | Set to `1` to enable hot-reload (same as `--hot`) |

Persistent state (workspaces, tabs, sidebar, theme) is saved under `~/.workbench`,
and the private tmux server uses the socket `~/.workbench/tmux-ui.sock`.

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

See [AGENT.md](AGENT.md) for the in-depth architecture, performance, and
input-handling notes.

## Development

All commands run from `workbench-ui/`:

```bash
bun run typecheck     # tsc --noEmit
bun test              # unit tests
bun run check         # Ultracite/Biome lint + format check
bun run fix           # apply formatting/safe fixes
bun run screenshot    # Playwright interaction + screenshot suite
```

The screenshot suite drives the real app in a headless-browser PTY and doubles as
a golden-master regression check; run it pointed at the package root:

```bash
WORKBENCH_UI_CWD="$PWD" bun run screenshot
```

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `bun run
typecheck`, `bun test`, and `bun run check`, and make sure the screenshot suite
still passes.

## License

[MIT](LICENSE).

---

![Workbench CLI running Claude Code](workbench-ui/assets/splash/og-image.jpg)
