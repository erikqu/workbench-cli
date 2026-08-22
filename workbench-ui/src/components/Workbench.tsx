import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AnchoredOverlay,
  Box,
  Button,
  type Key,
  Screen,
  type SilveryWheelEvent,
  type TerminalMouseEvent,
  Text,
  useBoxRectDangerously,
  useInput,
  useRawKeyEvent,
  useScreenRect,
  useSelection,
  useSelectionActions,
  useWindowSize,
} from "silvery";
import { SPLASH_VERSION } from "../media/splash";
import { focusForMainTab } from "../state/state";
import {
  harnessIdFromTab,
  isChangesTab,
  terminalIdFromTab,
} from "../state/types";
import {
  type ClipboardFocus,
  requestClipboardPaste,
  selectionClipboardShortcut,
} from "../terminal/clipboard";
import { terminalInputForKey } from "../terminal/terminal-panel";
import { terminalTrace } from "../terminal/terminal-trace";
import {
  COLLAPSED_SESSIONS_SIDEBAR_WIDTH,
  COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH,
} from "../ui/pane-layout";
import { colors } from "../ui/theme";
import { ToastHost } from "../ui/toast";
import { DiffDetailView } from "./ChangesView";
import { FocusedTerminal } from "./FocusedTerminal";
import { LatexInlineOverlay } from "./LatexInlineOverlay";
import {
  MainTabs,
  TabContextMenuOverlay,
  type TabContextMenuState,
  tabIndexAtOffset,
} from "./MainTabs";
import { MermaidInlineOverlay } from "./MermaidInlineOverlay";
import { NewAgentDialog } from "./NewAgentDialog";
import { NewHarnessDialog } from "./NewHarnessDialog";
import { PaneScrollIndicator } from "./PaneScrollIndicator";
import { SessionsHelpDialog } from "./SessionsHelpDialog";
import {
  SessionContextMenuOverlay,
  type SessionContextMenuState,
  SessionsSidebar,
} from "./SessionsSidebar";
import { Splash } from "./Splash";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";
import { SuppressImagesContext, SyntaxViewer } from "./viewers/SyntaxViewer";
import { WorkspaceSidePane } from "./WorkspaceSidePane";

const PLUS_ANCHOR_ID = "workbench-plus-button";

export function Workbench({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const [tabContextMenu, setTabContextMenu] =
    useState<TabContextMenuState | null>(null);
  const [sessionContextMenu, setSessionContextMenu] =
    useState<SessionContextMenuState | null>(null);
  const [sessionsHelpOpen, setSessionsHelpOpen] = useState(false);
  const [latexOverlay, setLatexOverlay] = useState(false);
  const [mermaidOverlay, setMermaidOverlay] = useState(false);
  const [latexLoading, setLatexLoading] = useState(false);
  const [mermaidLoading, setMermaidLoading] = useState(false);
  const selection = useSelection();
  const selectionActions = useSelectionActions();
  const selectionPresent = useRef(false);
  const observedSelectionRange = useRef(selection?.range);
  const rawSelectionCopy = useRef(false);
  if (selection?.range !== observedSelectionRange.current) {
    observedSelectionRange.current = selection?.range;
    selectionPresent.current = Boolean(selection?.range);
  }
  useRawKeyEvent(({ input, key }) => {
    rawSelectionCopy.current = false;
    if (
      isClipboardFocus(view.state.focus) &&
      selectionClipboardShortcut(
        input,
        key,
        view.state.focus,
        selectionPresent.current
      ) === "copy"
    ) {
      // Raw-key observers run before Silvery handles selection shortcuts.
      // Copy while the range is still available and clear the highlight so
      // the next click or key is routed normally.
      rawSelectionCopy.current = true;
      selectionActions.copy?.();
      selectionActions.clear?.();
      selectionPresent.current = false;
    }
  });
  useInput(
    (input, key) => {
      if (isHelpShortcut(input, key)) {
        setSessionsHelpOpen((open) => !open);
        return;
      }
      if (sessionsHelpOpen) {
        if (key.escape) {
          setSessionsHelpOpen(false);
        }
        return;
      }
      if ((tabContextMenu || sessionContextMenu) && key.escape) {
        setTabContextMenu(null);
        setSessionContextMenu(null);
        return;
      }
      if (isClipboardFocus(view.state.focus)) {
        const clipboard = selectionClipboardShortcut(
          input,
          key,
          view.state.focus,
          rawSelectionCopy.current || selectionPresent.current
        );
        if (clipboard === "copy") {
          if (!rawSelectionCopy.current) {
            selectionActions.copy?.();
          }
          selectionActions.clear?.();
          rawSelectionCopy.current = false;
          selectionPresent.current = false;
          return;
        }
        if (clipboard === "paste") {
          selectionActions.clear?.();
          rawSelectionCopy.current = false;
          selectionPresent.current = false;
          requestClipboardPaste();
          return;
        }
        if (clipboard === "consume") {
          rawSelectionCopy.current = false;
          selectionPresent.current = false;
          return;
        }
        rawSelectionCopy.current = false;
        selectionPresent.current = false;
      }
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
          color={colors.text}
          flexDirection="column"
          height="100%"
          onMouseDown={(event) => {
            if (event.button === 2 && event.y === 0) {
              const tabStart = view.state.sidebarVisible
                ? view.state.sessionsSidebarWidth + 1
                : COLLAPSED_SESSIONS_SIDEBAR_WIDTH;
              const workspaceOffset = view.state.workspaceSidePaneVisible
                ? view.state.workspaceSidePaneWidth
                : COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH;
              const index = tabIndexAtOffset(
                view.mainTabOptions,
                Math.floor(event.x - tabStart - workspaceOffset),
                view.session.harnesses.length > 1
              );
              const option = view.mainTabOptions[index];
              if (option) {
                actions.closePlusMenu();
                setSessionContextMenu(null);
                setTabContextMenu({
                  anchorId: `workbench-tab-${index}`,
                  value: option.value,
                });
                event.preventDefault();
                event.stopPropagation();
                return;
              }
            }
            actions.closePlusMenu();
            setTabContextMenu(null);
            setSessionContextMenu(null);
          }}
          width="100%"
        >
          <Box
            backgroundColor={colors.bg}
            flexDirection="row"
            flexGrow={1}
            minHeight={1}
          >
            <SessionsSidebar
              actions={actions}
              onContextMenuChange={(value) => {
                actions.closePlusMenu();
                setTabContextMenu(null);
                setSessionContextMenu(value);
              }}
              onOpenHelp={() => {
                actions.closePlusMenu();
                setTabContextMenu(null);
                setSessionContextMenu(null);
                setSessionsHelpOpen(true);
              }}
              view={view}
            />
            <WorkspaceSidePane actions={actions} view={view} />
            <Box
              backgroundColor={colors.bg}
              flexDirection="column"
              flexGrow={1}
              minHeight={1}
              minWidth={20}
            >
              <Box
                backgroundColor={colors.editor}
                flexDirection="row"
                flexShrink={0}
                height={1}
              >
                <Box flexGrow={1} minWidth={10}>
                  <MainTabs
                    actions={actions}
                    onContextMenuChange={(value) => {
                      actions.closePlusMenu();
                      setSessionContextMenu(null);
                      setTabContextMenu(value);
                    }}
                    view={view}
                  />
                </Box>
                <PlusButton actions={actions} view={view} />
              </Box>
              <Box
                flexDirection="column"
                flexGrow={1}
                minHeight={1}
                minWidth={1}
              >
                {terminalTab ? (
                  <TerminalView
                    actions={actions}
                    selectionChanged={(selected) => {
                      selectionPresent.current = selected;
                      if (!selected) {
                        rawSelectionCopy.current = false;
                        selectionActions.clear?.();
                      }
                    }}
                    view={view}
                  />
                ) : harnessTab ? (
                  <HarnessView
                    actions={actions}
                    latexLoading={latexLoading}
                    latexOverlay={latexOverlay}
                    mermaidLoading={mermaidLoading}
                    mermaidOverlay={mermaidOverlay}
                    onLatexLoadingChange={setLatexLoading}
                    onMermaidLoadingChange={setMermaidLoading}
                    onToggleMath={() => {
                      if (latexOverlay) {
                        setLatexOverlay(false);
                        setLatexLoading(false);
                        return;
                      }
                      setLatexOverlay(true);
                    }}
                    onToggleMermaid={() => {
                      if (mermaidOverlay) {
                        setMermaidOverlay(false);
                        setMermaidLoading(false);
                        return;
                      }
                      setMermaidOverlay(true);
                    }}
                    selectionChanged={(selected) => {
                      selectionPresent.current = selected;
                      if (!selected) {
                        rawSelectionCopy.current = false;
                        selectionActions.clear?.();
                      }
                    }}
                    view={view}
                  />
                ) : changesTab ? (
                  <DiffDetailView actions={actions} view={view} />
                ) : (
                  <Box
                    backgroundColor={colors.editor}
                    flexDirection="column"
                    flexGrow={1}
                    minHeight={1}
                    minWidth={1}
                  >
                    <SyntaxViewer actions={actions} view={view} />
                  </Box>
                )}
              </Box>
            </Box>
          </Box>
          <PlusMenu actions={actions} open={view.state.plusMenuOpen} />
          <TabContextMenuOverlay
            actions={actions}
            contextMenu={tabContextMenu}
            onClose={() => setTabContextMenu(null)}
            view={view}
          />
          <SessionContextMenuOverlay
            actions={actions}
            contextMenu={sessionContextMenu}
            onClose={() => setSessionContextMenu(null)}
            view={view}
          />
          {sessionsHelpOpen ? (
            <SessionsHelpDialog onClose={() => setSessionsHelpOpen(false)} />
          ) : null}
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

export function isHelpShortcut(input: string, key: Key): boolean {
  // Enhanced keyboard protocols can distinguish Ctrl+Shift+/ (Ctrl+?) from
  // Backspace. Legacy terminals encode both as DEL (0x7f), which Silvery
  // correctly reports as key.backspace; never treat that ambiguous byte as
  // Help or terminal deletion would stop working.
  return (
    key.ctrl &&
    key.shift &&
    !key.backspace &&
    !key.meta &&
    !key.super &&
    (input === "?" || input === "/")
  );
}

function isClipboardFocus(focus: string): focus is ClipboardFocus {
  return focus === "editor" || focus === "harness" || focus === "terminal";
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
    if (isSplashDismissKey(input, key)) {
      actions.dismissSplash();
    }
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

  if (isCloseTabShortcut(input, key)) {
    actions.closeActiveTab();
    return;
  }

  if (isThemeCycleKey(input, key)) {
    actions.cycleTheme(key.shift ? -1 : 1);
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
    // Option++ opens the new-workspace/agent picker — a quick "new session"
    // without reaching for the sidebar button or the + menu. Accept "=" too so
    // it fires whether or not Shift is held for the +/= key.
    if (input === "+" || input === "=") {
      actions.openNewAgent();
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
    if (input === "q") {
      actions.shutdown(0);
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

export function isSplashDismissKey(input: string, key: Key): boolean {
  // Terminal capability replies arrive on stdin during startup too. Unknown
  // CSI replies parse as an empty key, while OSC replies can surface as text
  // containing their terminating Escape. Neither is a human interaction and
  // must not dismiss the splash before its asynchronously decoded art appears.
  if (key.text !== undefined) {
    return !key.text.includes("\x1b");
  }
  return Boolean(
    input ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageDown ||
      key.pageUp ||
      key.home ||
      key.end ||
      key.return ||
      key.escape ||
      key.tab ||
      key.backspace ||
      key.delete
  );
}

// Map a "1".."9" keypress to a 0-based index (1 -> 0). Anything else -> undefined.
function digitIndex(input: string): number | undefined {
  if (input.length !== 1 || input < "1" || input > "9") {
    return;
  }
  return input.charCodeAt(0) - 49;
}

export function isThemeCycleKey(input: string, key: Key): boolean {
  if (key.ctrl || key.super) {
    return false;
  }
  if (key.meta && key.tab) {
    return true;
  }
  // Legacy Alt/Option+Tab can arrive as ESC + Tab. silvery strips ESC and gives
  // us a literal tab input without setting key.meta/key.tab.
  return input === "\t" && !key.tab && !key.escape;
}

export function isCloseTabShortcut(input: string, key: Key): boolean {
  return (
    key.meta &&
    !key.ctrl &&
    !key.super &&
    !key.shift &&
    input.toLowerCase() === "w"
  );
}

function HarnessView({
  view,
  actions,
  latexOverlay,
  latexLoading,
  mermaidOverlay,
  mermaidLoading,
  onLatexLoadingChange,
  onMermaidLoadingChange,
  onToggleMath,
  onToggleMermaid,
  selectionChanged,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  latexOverlay: boolean;
  latexLoading: boolean;
  mermaidOverlay: boolean;
  mermaidLoading: boolean;
  onLatexLoadingChange(loading: boolean): void;
  onMermaidLoadingChange(loading: boolean): void;
  onToggleMath(): void;
  onToggleMermaid(): void;
  selectionChanged(selected: boolean): void;
}) {
  const activeHarness = view.session.harnesses.find(
    (harness) => `harness:${harness.id}` === view.session.activeMainTab
  );
  const restart = () => {
    if (activeHarness) {
      actions.addHarness(activeHarness.harnessId);
    }
  };
  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={
        view.state.focus === "harness" ? colors.borderFocus : colors.border
      }
      borderStyle="round"
      flexDirection="column"
      flexGrow={1}
      minHeight={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("harness");
        event.stopPropagation();
      }}
    >
      <Box
        borderBottom
        borderColor={colors.border}
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderTop={false}
        flexDirection="row"
        flexShrink={0}
        height={2}
        justifyContent="space-between"
      >
        <Box flexDirection="row">
          <WorkbenchUpdateControl actions={actions} />
          <InlinePreviewButton
            active={latexOverlay}
            label="math"
            loading={latexLoading}
            onToggle={onToggleMath}
          />
          <InlinePreviewButton
            active={mermaidOverlay}
            label="mermaid"
            loading={mermaidLoading}
            onToggle={onToggleMermaid}
          />
        </Box>
        <Box flexDirection="row">
          <RestartHarnessButton onRestart={restart} />
          <SwitchHarnessButton onSwitch={actions.openNewHarness} />
        </Box>
      </Box>
      {view.harnessPanel ? (
        <PaneScrollIndicator panel={view.harnessPanel} top={2} />
      ) : null}
      {view.harnessPanel ? (
        <TerminalGrid
          focus={() => actions.focus("harness")}
          focused={view.state.focus === "harness"}
          panel={view.harnessPanel}
          resize={actions.resizeHarness}
          scroll={actions.scrollHarness}
          selectionChanged={selectionChanged}
        />
      ) : null}
      {latexOverlay && view.harnessPanel ? (
        <LatexInlineOverlay
          mode={view.state.themeName === "light" ? "light" : "dark"}
          onLoadingChange={onLatexLoadingChange}
          panel={view.harnessPanel}
        />
      ) : null}
      {mermaidOverlay && view.harnessPanel ? (
        <MermaidInlineOverlay
          mode={view.state.themeName === "light" ? "light" : "dark"}
          onLoadingChange={onMermaidLoadingChange}
          panel={view.harnessPanel}
        />
      ) : null}
    </Box>
  );
}

function WorkbenchUpdateControl({ actions }: { actions: WorkbenchActions }) {
  const [hovered, setHovered] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "updating" | "updated" | "failed"
  >("idle");
  const label =
    status === "idle"
      ? "Update"
      : status === "updating"
        ? "Updating"
        : status === "updated"
          ? "Updated"
          : "Failed";
  const loadingGlyph = useLoadingGlyph(status === "updating");
  return (
    <Box flexDirection="row" height={1}>
      <Text color={colors.dim} wrap={false}>
        {`Workbench v${SPLASH_VERSION}:`}
      </Text>
      <Box
        backgroundColor={hovered ? colors.selected : undefined}
        height={1}
        mouseCursor={status === "updating" ? undefined : "pointer"}
        onClick={(event) => {
          if (event.button !== 0 || status === "updating") {
            return;
          }
          setStatus("updating");
          actions.updateWorkbench().then((updated) => {
            setStatus(updated ? "updated" : "failed");
          });
          event.stopPropagation();
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        paddingX={1}
      >
        <Text
          color={hovered ? colors.onSelected : colors.accentAlt}
          wrap={false}
        >
          {status === "updating" ? `${label} ${loadingGlyph}` : label}
        </Text>
      </Box>
    </Box>
  );
}

function InlinePreviewButton({
  active,
  label,
  loading,
  onToggle,
}: {
  active: boolean;
  label: string;
  loading: boolean;
  onToggle(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const loadingGlyph = useLoadingGlyph(loading);
  return (
    <Box
      backgroundColor={
        active
          ? hovered
            ? colors.accentAlt
            : colors.accent
          : hovered
            ? colors.selected
            : undefined
      }
      focusable={false}
      height={1}
      mouseCursor="pointer"
      onClick={(event) => {
        if (event.button !== 0) {
          return;
        }
        onToggle();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      paddingX={1}
    >
      <Text
        bold={active || hovered}
        color={
          active ? colors.bg : hovered ? colors.onSelected : colors.accentAlt
        }
      >
        {`${active ? `${label} on` : label}${loading ? ` ${loadingGlyph}` : ""}`}
      </Text>
    </Box>
  );
}

const LOADING_GLYPHS = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

function useLoadingGlyph(loading: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!loading) {
      setFrame(0);
      return;
    }
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % LOADING_GLYPHS.length);
    }, 80);
    return () => clearInterval(interval);
  }, [loading]);
  return LOADING_GLYPHS[frame] ?? LOADING_GLYPHS[0];
}

function RestartHarnessButton({ onRestart }: { onRestart(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      alignItems="center"
      backgroundColor={hovered ? colors.selected : undefined}
      focusable={false}
      height={1}
      justifyContent="center"
      mouseCursor="pointer"
      onClick={(event) => {
        if (event.button !== 0) {
          return;
        }
        onRestart();
        event.stopPropagation();
      }}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      width={3}
    >
      <Text bold color={hovered ? colors.onSelected : colors.accentAlt}>
        ↻
      </Text>
    </Box>
  );
}

function SwitchHarnessButton({ onSwitch }: { onSwitch(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      backgroundColor={hovered ? colors.selected : undefined}
      flexDirection="row"
      mouseCursor="pointer"
      onClick={(event) => {
        if (event.button !== 0) {
          return;
        }
        onSwitch();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Text
        bold={hovered}
        color={hovered ? colors.onSelected : colors.accentAlt}
      >
        switch ...
      </Text>
    </Box>
  );
}

function TerminalView({
  view,
  actions,
  selectionChanged,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  selectionChanged(selected: boolean): void;
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
      minHeight={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("terminal");
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
        <PaneScrollIndicator panel={view.terminalPanel} top={1} />
      ) : null}
      {view.terminalPanel ? (
        <TerminalGrid
          focus={() => actions.focus("terminal")}
          focused={view.state.focus === "terminal"}
          panel={view.terminalPanel}
          resize={actions.resizeTerminal}
          scroll={actions.scrollTerminal}
          selectionChanged={selectionChanged}
        />
      ) : null}
    </Box>
  );
}

function TerminalGrid({
  panel,
  focus,
  focused,
  selectionChanged,
  resize,
  scroll,
}: {
  panel: NonNullable<WorkbenchViewModel["harnessPanel"]>;
  focus(): void;
  focused: boolean;
  selectionChanged?(selected: boolean): void;
  resize(cols: number, rows: number): void;
  scroll(lines: number): void;
}) {
  return (
    <Box flexGrow={1} minHeight={1} minWidth={1} overflow="hidden">
      <MeasuredTerminalGrid
        focus={focus}
        focused={focused}
        panel={panel}
        resize={resize}
        scroll={scroll}
        selectionChanged={selectionChanged}
      />
    </Box>
  );
}

function MeasuredTerminalGrid({
  panel,
  focus,
  focused,
  selectionChanged,
  resize,
  scroll,
}: {
  panel: NonNullable<WorkbenchViewModel["harnessPanel"]>;
  focus(): void;
  focused: boolean;
  selectionChanged?(selected: boolean): void;
  resize(cols: number, rows: number): void;
  scroll(lines: number): void;
}) {
  const rect = useBoxRectDangerously();
  const screenRect = useScreenRect();
  const windowSize = useWindowSize();
  const { cols, rows } = terminalGridSize(rect, windowSize);
  useEffect(() => {
    terminalTrace("grid-layout", {
      cols,
      rectHeight: rect.height,
      rectWidth: rect.width,
      rectX: rect.x,
      rectY: rect.y,
      rows,
      screenHeight: screenRect.height,
      screenWidth: screenRect.width,
      screenX: screenRect.x,
      screenY: screenRect.y,
      windowColumns: windowSize.columns,
      windowRows: windowSize.rows,
    });
  }, [
    cols,
    rect.height,
    rect.width,
    rect.x,
    rect.y,
    rows,
    screenRect.height,
    screenRect.width,
    screenRect.x,
    screenRect.y,
    windowSize.columns,
    windowSize.rows,
  ]);
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
    if (event.type === "press" && event.button === "left") {
      selectionChanged?.(false);
      focus();
    }
    // Wheel events are deliberately NOT handled here: the Terminal onMouse
    // callback only exposes a direction, while silvery's runtime coalesces
    // same-direction wheel bursts into one event whose deltaY accumulates the
    // step count. The wrapper Box's onWheel below receives that magnitude.
  };

  // Single wheel owner for this pane. Wheel events bubble, so any additional
  // onWheel handler on an ancestor pane or grid would double-send gestures to
  // tmux/the harness; this handler stops propagation to enforce that.
  const onWheel = (event: SilveryWheelEvent) => {
    const gesture = wheelGesture(event.deltaY);
    if (!gesture) {
      return;
    }
    const col = Math.max(0, Math.floor(event.x - rect.x));
    const row = Math.max(0, Math.floor(event.y - rect.y));
    if (!panel.sendMouseWheel(col, row, gesture.direction, gesture.steps)) {
      scroll((gesture.direction === "up" ? -3 : 3) * gesture.steps);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <FocusedTerminal
      cols={cols}
      focused={focused}
      onMouse={onMouse}
      onWheel={onWheel}
      revision={revision}
      rows={rows}
      selectable
      terminal={panel}
    />
  );
}

// Translate a wheel event's deltaY into a direction plus how many wheel steps
// it represents. Silvery's runtime coalesces same-direction wheel bursts into
// one event whose deltaY is the sum of the per-report deltas (each report is
// +-1), so the absolute value is the number of physical wheel ticks. Dropping
// it to one step per event loses most of a fast flick, which strands tmux
// copy-mode panes in scrollback because the pane scrolls up further than any
// later wheel-down stream can recover.
export function wheelGesture(
  deltaY: number
): { direction: "up" | "down"; steps: number } | undefined {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return;
  }
  return {
    direction: deltaY < 0 ? "up" : "down",
    steps: Math.max(1, Math.round(Math.abs(deltaY))),
  };
}

// Rows deliberately left unused at the bottom of every harness/terminal pane.
//
// Agent CLIs anchor their composer to the last row they believe they have. Any
// disagreement between the height we hand the PTY and the height we actually
// paint therefore hides the input box first — the single worst thing that can
// happen to this pane, since the user loses the ability to type at all. Giving
// the PTY a slightly shorter grid than the box costs a few rows of transcript
// and makes that class of failure impossible to reach: the composer lands
// several rows above the frame, so even a stale measurement or an off-by-a-row
// reflow leaves it on screen.
const TERMINAL_BOTTOM_SAFETY_ROWS = 3;

export function terminalGridSize(
  rect: { x: number; y: number; width: number; height: number },
  windowSize: { columns: number; rows: number }
): { cols: number; rows: number } {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  // TerminalGrid always sits inside a framed pane. Keep its trailing edge one
  // cell inside the host window so a stale flex measurement cannot place the
  // PTY (and its composer) underneath the pane's right or bottom border.
  const visibleCols = Math.max(1, Math.floor(windowSize.columns) - x - 1);
  const visibleRows = Math.max(1, Math.floor(windowSize.rows) - y - 1);
  const height = Math.min(Math.floor(rect.height), visibleRows);
  return {
    cols: Math.max(1, Math.min(Math.floor(rect.width), visibleCols)),
    // Keep at least one row on panes too short for the full margin.
    rows: Math.max(1, height - TERMINAL_BOTTOM_SAFETY_ROWS),
  };
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
      height={1}
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
