# Workbench UI

The Bun + React + Silvery package behind Workbench CLI. It renders the
full-screen terminal workbench that runs coding-agent CLIs, shell terminals,
workspace files, and live git changes side by side.

## Terminal Support

Develop and test the UI in [Ghostty](https://ghostty.org/). Ghostty is the
supported terminal target for Workbench CLI; all other terminal emulators are
experimental and may differ in rendering, images, cursor behavior, mouse input,
or tmux passthrough.

## Run Locally

From `workbench-ui/`:

```bash
bun install
bun run start
```

The launcher in `../bin/workbench-cli` is what installed users run as
`workbench-cli` or `work`; it resolves the repo location, optionally enables Bun
watch mode, and execs `src/index.ts`.

## Development Commands

```bash
bun run typecheck
bun test
bun run check
bun run fix
WORKBENCH_UI_CWD="$PWD" bun run screenshot
```

The screenshot harness drives the real app in a browser-backed PTY and writes
artifacts under `artifacts/screenshots/`. Point `WORKBENCH_UI_CWD` at this
package root so the bundled fixtures under `test-harness/` resolve correctly.

## Runtime Shape

Each workspace session owns:

- One or more agent harness tabs backed by persistent tmux sessions.
- Shell terminal tabs, also persistent across relaunches.
- File viewer tabs for text, Markdown preview/source, images, PDFs, videos, and
  Mermaid diagrams.
- A side pane with the active agent, Explorer, Terminals, and Changes sections.

Agent harnesses are defined in `src/state/harnesses.ts`. The current IDs are
`claude`, `gemini`, `goose`, `opencode`, and `cursor`; `claude` is the default.

## Runtime Options

```bash
work [path] [--harness <id>] [--hot]
```

- `path` opens a workspace directory.
- `--harness <id>` / `--agent <id>` selects the default harness for new
  workspaces.
- `--hot` (also `--dev` / `--watch`) restarts the UI on source changes while
  persistent tmux panes reattach.

Useful environment variables:

- `WORKBENCH_UI_HARNESS_ID` / `WORKBENCH_UI_AGENT_ID`
- `WORKBENCH_UI_CWD`
- `WORKBENCH_UI_THEME`
- `WORKBENCH_UI_IMAGE_PROTOCOL=kitty|sixel|halfblock`
- `WORKBENCH_UI_CELL_ASPECT`
- `WORKBENCH_CLI_HOT=1`

## Architecture Notes

`src/app/WorkbenchApp.tsx` owns lifecycle, state mutation, diff polling,
persistence, and the throttled top-level render. `src/components/Workbench.tsx`
renders the shell and routes keyboard input. `src/terminal/terminal-panel.ts`
wraps `@xterm/headless` plus Bun PTYs/tmux, exposing the `TerminalReadable`
shape consumed by Silvery's `<Terminal>`.

Terminal output should stay on the `TerminalPanel` subscription path. Do not
route PTY frames through the whole-app render loop; the terminal subtree
subscribes directly via `useSyncExternalStore` and a revision prop.

For deeper agent-facing guidance, see `../AGENT.md`.
