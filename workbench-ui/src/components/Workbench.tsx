import { useEffect, useSyncExternalStore } from "react";
import {
  AnchoredOverlay,
  Box,
  Button,
  type Key,
  Screen,
  Terminal,
  type TerminalMouseEvent,
  Text,
  useBoxRectDangerously,
  useInput,
} from "silvery";
import { harnessSpec } from "../state/harnesses";
import { focusForMainTab } from "../state/state";
import {
  harnessIdFromTab,
  isChangesTab,
  terminalIdFromTab,
} from "../state/types";
import { terminalInputForKey } from "../terminal/terminal-panel";
import { colors } from "../ui/theme";
import { ToastHost } from "../ui/toast";
import { ChangesView } from "./ChangesView";
import { Explorer } from "./Explorer";
import { MainTabs } from "./MainTabs";
import { NewAgentDialog } from "./NewAgentDialog";
import { NewHarnessDialog } from "./NewHarnessDialog";
import { SessionsSidebar } from "./SessionsSidebar";
import { Splash } from "./Splash";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";
import { SuppressImagesContext, SyntaxViewer } from "./viewers/SyntaxViewer";

const PLUS_ANCHOR_ID = "workbench-plus-button";

export function Workbench({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  useInput(
    (input, key) => {
      handleKey(input, key, view, actions);
    },
    {
      // Bracketed paste is captured by the runtime and delivered here as a
      // single string rather than per-key events, so it never reaches
      // handleKey. Forward it to whichever PTY pane is focused.
      onPaste: (text) => {
        if (view.state.focus === "terminal") {
          view.terminalPanel?.paste(text);
        } else if (view.state.focus === "harness") {
          view.harnessPanel?.paste(text);
        }
      },
    }
  );

  const terminalTab = terminalIdFromTab(view.session.activeMainTab);
  const harnessTab = harnessIdFromTab(view.session.activeMainTab);
  const changesTab = isChangesTab(view.session.activeMainTab);

  return (
    <Screen flexDirection="column">
      <SuppressImagesContext.Provider value={view.state.splashVisible}>
        <Box
          backgroundColor={colors.bg}
          flexDirection="column"
          height="100%"
          onMouseDown={() => actions.closePlusMenu()}
          width="100%"
        >
          <Box
            backgroundColor={colors.panel}
            flexDirection="row"
            flexShrink={0}
            height={1}
            paddingX={2}
          >
            <Text bold color={colors.accent}>
              Workbench
            </Text>
          </Box>
          <Box backgroundColor={colors.bg} flexDirection="row" flexGrow={1}>
            <SessionsSidebar actions={actions} view={view} />
            <Box
              backgroundColor={colors.bg}
              flexDirection="column"
              flexGrow={1}
              minWidth={20}
            >
              <Box
                backgroundColor={colors.editor}
                flexDirection="row"
                flexShrink={0}
                height={2}
              >
                <Box flexGrow={1} minWidth={10}>
                  <MainTabs actions={actions} view={view} />
                </Box>
                <PlusButton actions={actions} view={view} />
              </Box>
              {harnessTab ? (
                <Box
                  backgroundColor={colors.bg}
                  flexDirection="row"
                  flexGrow={1}
                  minWidth={1}
                >
                  <Explorer actions={actions} view={view} />
                  <HarnessView actions={actions} view={view} />
                </Box>
              ) : terminalTab ? (
                <TerminalView actions={actions} view={view} />
              ) : changesTab ? (
                <ChangesView actions={actions} view={view} />
              ) : (
                <Box
                  backgroundColor={colors.editor}
                  flexDirection="column"
                  flexGrow={1}
                >
                  <SyntaxViewer actions={actions} view={view} />
                </Box>
              )}
            </Box>
          </Box>
          <PlusMenu actions={actions} open={view.state.plusMenuOpen} />
          {view.state.newAgentOpen ? (
            <NewAgentDialog actions={actions} view={view} />
          ) : null}
          {view.state.newHarnessOpen ? (
            <NewHarnessDialog actions={actions} view={view} />
          ) : null}
          {view.state.splashVisible ? <Splash actions={actions} /> : null}
          <ToastHost />
        </Box>
      </SuppressImagesContext.Provider>
    </Screen>
  );
}

function handleKey(
  input: string,
  key: Key,
  view: WorkbenchViewModel,
  actions: WorkbenchActions
) {
  if (key.ctrl && input === "q") {
    actions.shutdown(0);
    return;
  }

  // The startup splash swallows the first interaction to dismiss itself.
  if (view.state.splashVisible) {
    actions.dismissSplash();
    return;
  }

  if (view.state.newAgentOpen || view.state.newHarnessOpen) {
    return;
  }

  if (view.state.plusMenuOpen) {
    if (key.escape) {
      actions.closePlusMenu();
    } else if (key.return || input === "h") {
      actions.openNewHarness();
    } else if (input === "t") {
      actions.newTerminal();
    } else if (input === "n") {
      actions.openNewAgent();
    }
    return;
  }

  if (key.ctrl && input === "t") {
    actions.newTerminal();
    return;
  }
  if (key.ctrl && input === "n") {
    actions.openNewAgent();
    return;
  }
  if (key.ctrl && input === "h") {
    actions.openNewHarness();
    return;
  }
  if (key.ctrl && input === "b") {
    actions.toggleSidebar();
    return;
  }

  // Ergonomic quick-switch. Option/Alt is the prefix; the number you press is the
  // index badge shown in the UI:
  //   Option+1..9        -> jump to that tab in the active session (top strip)
  //   Option+Shift+1..9  -> jump to that session/workspace (left pane)
  // Handled before the terminal/harness focus branches so it works even while a
  // CLI panel is focused (agent CLIs never bind Alt+digit). Both encodings parse
  // identically in legacy (ESC-prefixed) and Kitty terminals.
  if (key.meta && !key.ctrl && !key.super) {
    // Option+Tab cycles UI themes (Option+Shift+Tab reverses). Handled before
    // the digit/space switches and before any focus branch so it works while a
    // CLI panel is focused.
    if (key.tab) {
      actions.cycleTheme(key.shift ? -1 : 1);
      return;
    }
    const index = digitIndex(input);
    if (index !== undefined) {
      if (key.shift) {
        const session = view.state.sessions[index];
        if (session) {
          actions.selectSession(session.id);
        }
      } else {
        const tab = view.mainTabOptions[index];
        if (tab) {
          actions.selectMainTab(tab);
        }
      }
      return;
    }
    // Option+Space cycles forward through sessions (wraps) — a quick "next
    // workspace" when you don't want to aim for a specific Option+Shift+N.
    if (input === " ") {
      const sessions = view.state.sessions;
      const current = sessions.findIndex(
        (session) => session.id === view.state.activeSessionId
      );
      const next = sessions[(current + 1) % sessions.length];
      if (next) {
        actions.selectSession(next.id);
      }
      return;
    }
  }

  if (view.state.focus === "terminal") {
    if (key.pageUp) {
      if (!view.terminalPanel?.sendViewportKey("\x1b[5~")) {
        actions.scrollTerminal(-10);
      }
      return;
    }
    if (key.pageDown) {
      if (!view.terminalPanel?.sendViewportKey("\x1b[6~")) {
        actions.scrollTerminal(10);
      }
      return;
    }
    const data = terminalInputForKey(input, key);
    if (data) {
      actions.writeTerminal(data);
    }
    return;
  }

  if (view.state.focus === "harness") {
    if (key.pageUp) {
      if (!view.harnessPanel?.sendViewportKey("\x1b[5~")) {
        actions.scrollHarness(-10);
      }
      return;
    }
    if (key.pageDown) {
      if (!view.harnessPanel?.sendViewportKey("\x1b[6~")) {
        actions.scrollHarness(10);
      }
      return;
    }
    const data = terminalInputForKey(input, key);
    if (data) {
      actions.writeHarness(data);
    }
    return;
  }

  if (key.ctrl && input === "c") {
    actions.shutdown(0);
    return;
  }
  if (key.ctrl && input === "w") {
    actions.closeActiveTab();
    return;
  }
  if (key.ctrl && input === "s") {
    actions.saveActiveFile();
    return;
  }

  if (view.state.focus === "sessions") {
    if (key.upArrow || key.downArrow) {
      const index = view.state.sessions.findIndex(
        (session) => session.id === view.state.activeSessionId
      );
      const next = view.state.sessions[index + (key.downArrow ? 1 : -1)];
      if (next) {
        actions.selectSession(next.id);
      }
      return;
    }
    if (input === "x") {
      actions.closeSession(view.state.activeSessionId);
      return;
    }
    if (key.return) {
      actions.focus(focusForMainTab(view.session.activeMainTab));
      return;
    }
  }

  if (key.tab) {
    const current = view.mainTabOptions.findIndex(
      (option) => option.value === view.session.activeMainTab
    );
    const delta = key.shift ? -1 : 1;
    const next =
      view.mainTabOptions[
        (current + delta + view.mainTabOptions.length) %
          view.mainTabOptions.length
      ];
    actions.selectMainTab(next ?? null);
    return;
  }
  if (key.escape) {
    actions.focus(focusForMainTab(view.session.activeMainTab));
  }
}

// Map a "1".."9" keypress to a 0-based index (1 -> 0). Anything else -> undefined.
function digitIndex(input: string): number | undefined {
  if (input.length !== 1 || input < "1" || input > "9") {
    return;
  }
  return input.charCodeAt(0) - 49;
}

function HarnessView({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const activeHarness = view.session.harnesses.find(
    (harness) => `harness:${harness.id}` === view.session.activeMainTab
  );
  const activeSpec = harnessSpec(
    activeHarness?.harnessId ??
      view.session.harnesses[0]?.harnessId ??
      "workbench"
  );
  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={
        view.state.focus === "harness" ? colors.borderFocus : colors.border
      }
      borderStyle="round"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("harness");
        event.stopPropagation();
      }}
      onWheel={(event) => {
        if (
          !view.harnessPanel?.sendMouseWheel(
            event.x,
            event.y,
            event.deltaY > 0 ? "down" : "up"
          )
        ) {
          actions.scrollHarness(event.deltaY > 0 ? 3 : -3);
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Box
        flexDirection="row"
        flexShrink={0}
        height={1}
        justifyContent="space-between"
        paddingX={1}
      >
        <Text
          color={view.state.focus === "harness" ? colors.accent : colors.dim}
        >{`CLI: ${activeSpec.label}`}</Text>
        <Box
          flexDirection="row"
          onClick={(event) => {
            actions.openNewHarness();
            event.stopPropagation();
          }}
        >
          <Text color={colors.accentAlt}>switch ...</Text>
        </Box>
      </Box>
      {view.harnessPanel ? (
        <TerminalGrid
          focused={view.state.focus === "harness"}
          panel={view.harnessPanel}
          resize={actions.resizeHarness}
          scroll={actions.scrollHarness}
        />
      ) : null}
    </Box>
  );
}

function TerminalView({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  return (
    <Box
      backgroundColor={colors.panelAlt}
      borderColor={
        view.state.focus === "terminal" ? colors.borderFocus : colors.border
      }
      borderStyle="round"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("terminal");
        event.stopPropagation();
      }}
      onWheel={(event) => {
        if (
          !view.terminalPanel?.sendMouseWheel(
            event.x,
            event.y,
            event.deltaY > 0 ? "down" : "up"
          )
        ) {
          actions.scrollTerminal(event.deltaY > 0 ? 3 : -3);
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Text
        color={view.state.focus === "terminal" ? colors.accent : colors.dim}
      >
        {" "}
        Terminal{" "}
      </Text>
      {view.terminalPanel ? (
        <TerminalGrid
          focused={view.state.focus === "terminal"}
          panel={view.terminalPanel}
          resize={actions.resizeTerminal}
          scroll={actions.scrollTerminal}
        />
      ) : null}
    </Box>
  );
}

function TerminalGrid({
  panel,
  focused,
  resize,
  scroll,
}: {
  panel: NonNullable<WorkbenchViewModel["harnessPanel"]>;
  focused: boolean;
  resize(cols: number, rows: number): void;
  scroll(lines: number): void;
}) {
  return (
    <Box
      flexGrow={1}
      minWidth={1}
      onWheel={(event) => {
        if (
          !panel.sendMouseWheel(
            event.x,
            event.y,
            event.deltaY > 0 ? "down" : "up"
          )
        ) {
          scroll(event.deltaY > 0 ? 3 : -3);
        }
        event.preventDefault();
        event.stopPropagation();
      }}
      overflow="hidden"
    >
      <MeasuredTerminalGrid
        focused={focused}
        panel={panel}
        resize={resize}
        scroll={scroll}
      />
    </Box>
  );
}

function MeasuredTerminalGrid({
  panel,
  focused,
  resize,
  scroll,
}: {
  panel: NonNullable<WorkbenchViewModel["harnessPanel"]>;
  focused: boolean;
  resize(cols: number, rows: number): void;
  scroll(lines: number): void;
}) {
  const rect = useBoxRectDangerously();
  const cols = Math.max(1, Math.floor(rect.width));
  const rows = Math.max(1, Math.floor(rect.height));
  // Subscribe to the panel directly so terminal output repaints ONLY this
  // subtree. Previously every PTY frame bumped the whole-app view and re-ran the
  // entire Workbench render (sidebar, tabs, explorer, ...) just to redraw the
  // grid, which made busy terminals feel sluggish.
  const revision = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot
  );

  useEffect(() => {
    if (cols < 20 || rows < 5) {
      return;
    }
    resize(cols, rows);
    const timer = setTimeout(() => {
      panel.start();
    }, 80);
    return () => clearTimeout(timer);
  }, [cols, rows, panel, resize]);

  const onMouse = (event: TerminalMouseEvent) => {
    if (event.type === "wheel") {
      const direction =
        event.button === "wheelUp"
          ? "up"
          : event.button === "wheelDown"
            ? "down"
            : undefined;
      if (!direction) {
        return;
      }
      if (!panel.sendMouseWheel(event.x, event.y, direction)) {
        scroll(direction === "up" ? -3 : 3);
      }
    }
  };

  return (
    <Terminal
      cols={cols}
      cursor={focused}
      onMouse={onMouse}
      onResize={resize}
      revision={revision}
      rows={rows}
      selectable
      terminal={panel}
    />
  );
}

function PlusButton({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const toggle = () => actions.togglePlusMenu();
  return (
    <Box
      alignItems="center"
      anchorRef={PLUS_ANCHOR_ID}
      flexShrink={0}
      height={2}
      justifyContent="center"
      width={5}
    >
      <Button
        color={view.state.plusMenuOpen ? colors.onSelected : colors.accentAlt}
        focusable={false}
        isActive={view.state.plusMenuOpen}
        label="+"
        onClick={(event) => {
          toggle();
          event.stopPropagation();
        }}
        onPress={toggle}
      />
    </Box>
  );
}

function PlusMenu({
  open,
  actions,
}: {
  open: boolean;
  actions: WorkbenchActions;
}) {
  return (
    <AnchoredOverlay
      anchorId={PLUS_ANCHOR_ID}
      backgroundColor={colors.panel}
      borderColor={colors.borderFocus}
      borderStyle="round"
      flexDirection="column"
      offset={0}
      onMouseDown={(event) => event.stopPropagation()}
      open={open}
      placement="bottom-end"
      size={{ width: 30, height: 5 }}
    >
      <PlusMenuRow
        hint="Ctrl+H"
        label="New Harness"
        onClick={() => actions.openNewHarness()}
      />
      <PlusMenuRow
        hint="Ctrl+T"
        label="New Terminal"
        onClick={() => actions.newTerminal()}
      />
      <PlusMenuRow
        hint="Ctrl+N"
        label="New Workspace"
        onClick={() => actions.openNewAgent()}
      />
    </AnchoredOverlay>
  );
}

function PlusMenuRow({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick(): void;
}) {
  const click = (event: { stopPropagation(): void }) => {
    onClick();
    event.stopPropagation();
  };

  return (
    <Box
      flexDirection="row"
      height={1}
      justifyContent="space-between"
      onClick={click}
      paddingX={1}
    >
      <Text color={colors.text}>{label}</Text>
      <Text color={colors.dim}>{hint}</Text>
    </Box>
  );
}
