# Workbench CLI Development

Developer guide for the Bun + React + Silvery TUI in `workbench-ui/`.

## Prerequisites

- Bun >= 1.3
- `tmux`
- Ghostty for the supported terminal target
- At least one of `codex`, `cursor-agent`, `claude`, `gemini`, or `opencode`

Optional viewer commands:

- `ffmpeg` and `ffprobe` for video
- `mmdc` for Mermaid diagrams
- `pdftoppm` and `pdfinfo` for PDFs

## Setup and Run

```bash
cd workbench-ui
bun install
bun run start
```

To exercise the real launcher from the repository root:

```bash
./bin/workbench-cli .
./bin/workbench-cli . --harness codex
./bin/workbench-cli . --hot
```

The short installed alias is `work`. Hot mode notices when the current
directory is inside a development checkout and runs that checkout when its
dependencies are installed. `WORKBENCH_CLI_HOT_ROOT` overrides detection.

## Validation

Run from `workbench-ui/`:

```bash
bun run typecheck
bun test
bun run check
bun run screenshot
bun run test:terminal
```

Use the checks proportionally:

- `typecheck`, `test`, and `check` are the normal baseline.
- `screenshot` drives the real Workbench through a browser PTY and checks UI
  interaction, layout, selection, previews, and resizing.
- `test:terminal` is required for changes to PTY output, cursor handling,
  resizing, scrolling, tmux, terminal ownership, or frame rendering. It runs
  alternate-screen, inline, Codex-style, sticky-transcript, and real-shell
  scenarios with fragmented ANSI input.

The screenshot runner chooses the package root as its fixture workspace and
writes ignored artifacts to `artifacts/screenshots/`.

## Runtime and Harness Selection

```bash
work [path] [--harness <id>] [--hot] [--terminal-trace]
```

- The path defaults to the current directory.
- Missing paths entered through New Workspace are created recursively.
- `--harness` and `--agent` accept `codex`, `cursor`, `claude`, `gemini`, or
  `opencode`.
- Automatic selection tries Codex, Cursor, then Claude Code, and falls back to
  Codex.
- `--hot`, `--dev`, and `--watch` are aliases for serialized process restart.
- `--terminal-trace` enables metadata-only terminal diagnostics.

Re-selecting the currently active harness is an intentional restart: Workbench
kills that harness's private tmux session and recreates it in the same tab.
The `↻` control in the harness header performs the same action.

## Persistence and Process Ownership

Workbench state lives at `~/.workbench/workbench-ui-state.json`. Harnesses and
terminals use named sessions on the private socket
`~/.workbench/tmux-ui.sock`.

- Shutdown and hot reload save state and detach panes.
- Closing a harness, terminal, or workspace kills its backing tmux session.
- Every workspace, harness, and terminal has a stable persisted ID.
- Each workspace starts with one harness and one shell terminal.
- Shell terminals are normalized to their owning workspace cwd when restored.

Never use or clean the user's default tmux server as part of Workbench tests.

## Hot Reload Contract

`scripts/hot-runner.ts` owns hot reload. It sends `SIGTERM`, waits for Workbench
to persist state, detach panes, and restore the host terminal, and only then
starts the replacement process.

Do not replace this with Bun's native `--watch` or in-process hot replacement.
Those paths can skip shutdown and leave multiple renderers or PTY owners
fighting over the same session.

## Terminal Debugging

Start with the deterministic regression suite. Do not apply speculative fixes
for terminal corruption while it is green.

If the fixture cannot reproduce a live issue:

```bash
work --terminal-trace
```

The default trace is `~/.workbench/terminal-trace.ndjson`. Set
`WORKBENCH_TERMINAL_TRACE=/path/to/file.ndjson` for another location. Traces
contain dimensions, buffer positions, opaque row identifiers, byte counts, and
control-sequence counts—not terminal text or raw ANSI.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `WORKBENCH_UI_CWD` | Starting workspace |
| `WORKBENCH_UI_HARNESS_ID` / `WORKBENCH_UI_AGENT_ID` | Initial harness |
| `WORKBENCH_UI_THEME` | Initial theme |
| `WORKBENCH_UI_IMAGE_PROTOCOL` | `kitty`, `sixel`, or `halfblock` |
| `WORKBENCH_UI_CELL_ASPECT` | Image cell-aspect override |
| `WORKBENCH_UI_PRESERVE_DIM=1` | Preserve SGR dim |
| `WORKBENCH_CLI_HOT=1` | Enable hot mode |
| `WORKBENCH_CLI_HOT_ROOT` | Explicit development checkout |
| `WORKBENCH_TERMINAL_TRACE` | `1` or a custom trace path |
| `WORKBENCH_SCREENSHOT_QUERY` | Browser fixture options |

## Source Guide

```text
src/index.ts              startup and terminal capability probing
src/app/                  controller, lifecycle, persistence scheduling
src/state/                state creation, restoration, harness definitions
src/terminal/             PTY/tmux/xterm, scrolling, cursor, trace/probe
src/components/           shell, tabs, sidebars, dialogs, viewers
src/components/viewers/   Markdown, text, image, PDF, and video surfaces
src/media/                decoding and terminal image protocols
src/text/                 file tree, syntax, diffs, editor data
src/ui/                   theme, pane sizing, toasts
scripts/                  hot runner, screenshots, terminal regression
test-harness/             deterministic coding-agent and browser fixtures
```

The three central files are `app/WorkbenchApp.tsx`,
`components/Workbench.tsx`, and `terminal/terminal-panel.ts`. Consult the root
[`AGENT.md`](../../AGENT.md) before changing their lifecycle, input, or rendering
contracts.

## Release Process

Releases are tag-driven. After the version in `package.json` is bumped and the
commit is on `main`, push a `v<version>` tag. `.github/workflows/release.yml`
runs typechecking/tests, packages the source tarball, and creates the GitHub
Release.
