# Workbench OpenTUI Workbench

Experimental React/OpenTUI frontend for the Rust Workbench agent: a terminal
workbench that tracks multiple workbench agents (sessions) across workspaces.

Each session in the left sidebar is its own PTY-backed raw `workbench chat`
process running in that session's workspace folder. Every session owns its
own tab set: its terminals, its open file tabs, and its active tab. Switching
sessions swaps the whole tab strip; switching back restores it exactly. New
sessions start with one terminal in their workspace folder.

## Try It

From `workbench-agent-rs/`:

```bash
cargo build -p workbench --release
cd workbench-ui
bun install
bun start
```

Run the screenshot harness, which also simulates clicks and keystrokes to
verify the sessions sidebar, Explorer, terminal tabs, the [+] menu, and the
Workbench CLI stay interactive:

```bash
bun screenshot
```

Screenshots are written to `artifacts/screenshots/`: `workbench.png` (chat
tab), `workbench-editor.png` (editor tab), and `workbench-sessions.png`
(second session + second terminal). The script exits non-zero if any
interaction check fails.

## Layout

```text
+----------+----------------------------------------------------+
| Sessions | [ Workbench Chat | Terminal 1 | app-react.tsx ]  [+] |
|          +----------------------------------------------------+
| + New    | chat tab:     [ Explorer |  Workbench CLI PTY ]      |
| agent-1  | terminal tab: [ shell PTY (its own folder)  ]      |
| agent-2  | file tab:     [ editor                      ]      |
+----------+----------------------------------------------------+
```

Inside the UI:

```text
Sessions sidebar  one workbench agent per row; click to switch; x closes
+ New agent       new session dialog with folder autocomplete (Ctrl+N)
[+] button        top-right menu: New Workbench Chat / New Terminal
Workbench Chat tab  Explorer + raw `workbench chat` for the active session
Terminal tabs     the active session's shells (Ctrl+T adds one)
File tabs         the active session's buffers: editable text with syntax
                  highlighting, rendered markdown (.md), and decoded images
                  (.png/.jpg/.gif/...). Images use the kitty graphics protocol
                  (Unicode placeholders) when the terminal supports it, fall
                  back to sixel, then to true-color half-block art everywhere
                  else. Force a mode with WORKBENCH_UI_IMAGE_PROTOCOL=kitty|
                  sixel|halfblock (auto-detected by default; the screenshot
                  harness always uses half-block).
Tab x button      every tab except Workbench Chat closes with a click on its x
Ctrl+S            save active file tab
Tab               cycle focus: sessions -> explorer -> CLI (chat tab)
Esc               return focus to Workbench CLI / editor
Ctrl+B            toggle sessions sidebar
Ctrl+W            close active file or terminal tab
Ctrl+Q            quit workbench
Ctrl+C            sent to the focused Workbench CLI / terminal
```

In the new-agent dialog, the input is pre-filled with the active session's
folder. Type a path (with `~` and relative paths resolved), use Up/Down to
choose a directory suggestion, Tab to complete it, Enter to create the agent,
and Esc to cancel.

The Explorer is backed by `fast-glob`, `ignore`, and `chokidar`, follows the
active session's workspace, respects ignore rules, and workbenches after file
changes. The workbench shell uses `@opentui/react`.

All PTYs (each session's Workbench CLI and each terminal tab's shell) render
with full ANSI colors via `@xterm/headless` and spawn at the exact size of
their rendered panes. Typing goes to whichever pane has focus.
