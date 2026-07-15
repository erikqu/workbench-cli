import { useRef } from "react";
import {
  Badge,
  Box,
  Button,
  ListView,
  type ListViewHandle,
  Text,
  truncateText,
  useBoxRectDangerously,
  useWindowSize,
} from "silvery";
import type { AgentSession } from "../state/types";
import type { SessionDiff } from "../text/diff";
import {
  COLLAPSED_SESSIONS_SIDEBAR_WIDTH,
  clampPaneWidth,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  maxSessionsSidebarWidth,
} from "../ui/pane-layout";
import { colors, THEME_LABELS } from "../ui/theme";
import { PaneResizeHandle } from "./PaneResizeHandle";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

export function SessionsSidebar({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const { columns } = useWindowSize();
  if (!view.state.sidebarVisible) {
    return <CollapsedSessionsRail actions={actions} view={view} />;
  }
  const maxWidth = maxSessionsSidebarWidth(
    columns,
    view.state.workspaceSidePaneWidth
  );
  const width = clampPaneWidth(
    view.state.sessionsSidebarWidth,
    MIN_SESSIONS_SIDEBAR_WIDTH,
    maxWidth
  );

  return (
    <Box
      flexShrink={0}
      height="100%"
      minHeight={1}
      minWidth={1}
      overflow="hidden"
      position="relative"
      width={width}
    >
      <Box
        backgroundColor={colors.panel}
        borderColor={
          view.state.focus === "sessions" ? colors.borderFocus : colors.border
        }
        borderStyle="single"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={1}
        minWidth={1}
        onMouseDown={() => actions.focus("sessions")}
        overflow="hidden"
        padding={1}
      >
        <Box flexDirection="row" height={1} justifyContent="space-between">
          <Text color={colors.dim}>Sessions</Text>
          <Box flexDirection="row">
            <Text color={colors.dim}>{`${view.state.sessions.length} `}</Text>
            <CollapseButton
              actions={actions}
              pinned={view.state.sidebarVisible}
            />
          </Box>
        </Box>
        <NewAgentRow actions={actions} compact={width < 22} />
        <SessionList actions={actions} sidebarWidth={width} view={view} />
        <SidebarControls actions={actions} sidebarWidth={width} view={view} />
      </Box>
      <PaneResizeHandle
        maxWidth={maxWidth}
        minWidth={MIN_SESSIONS_SIDEBAR_WIDTH}
        onDragStart={() => actions.focus("sessions")}
        onResize={actions.resizeSessionsSidebar}
        width={width}
      />
    </Box>
  );
}

// Reminds keyboard users how to jump around. The badges on the tabs and session
// rows map 1:1 to these numbers; Shift selects the left (session) column.
function SidebarControls({
  view,
  actions,
  sidebarWidth,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  sidebarWidth: number;
}) {
  const themeLabel =
    THEME_LABELS[view.state.themeName as keyof typeof THEME_LABELS] ??
    view.state.themeName;
  const cycleTheme = (event?: { stopPropagation(): void }) => {
    actions.cycleTheme();
    event?.stopPropagation();
  };
  const quit = (event?: { stopPropagation(): void }) => {
    actions.shutdown(0);
    event?.stopPropagation();
  };
  const compact = sidebarWidth < 24;
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      <Box flexDirection="row" height={1} justifyContent="space-between">
        <Text color={colors.accentAlt} onClick={cycleTheme} wrap={false}>
          {compact ? "Theme" : `Theme: ${themeLabel}`}
        </Text>
        <Text color={colors.dim} onClick={quit}>
          Quit
        </Text>
      </Box>
      <LegendRow keys="⌥1-9" label="tab" />
      <LegendRow keys="⌥⇧1-9" label={compact ? "sess" : "session"} />
      <LegendRow keys="⌥Space" label={compact ? "next" : "next session"} />
      <LegendRow keys="⌥Tab" label="theme" />
      <LegendRow keys="Ctrl+Q" label="quit" />
    </Box>
  );
}

function LegendRow({ keys, label }: { keys: string; label: string }) {
  return (
    <Box flexDirection="row" height={1}>
      <Text color={colors.accentAlt}>{keys}</Text>
      <Text color={colors.dim}>{` ${label}`}</Text>
    </Box>
  );
}

// Keyboard session navigation (up/down/x/return) stays in Workbench.handleKey;
// this ListView windows the rows and adds ref-driven wheel scrolling so the two
// input paths never fight over arrow keys.
function SessionList({
  view,
  actions,
  sidebarWidth,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  sidebarWidth: number;
}) {
  const listRef = useRef<ListViewHandle>(null);
  return (
    <Box
      flexGrow={1}
      flexShrink={1}
      marginTop={1}
      minHeight={1}
      minWidth={1}
      onWheel={(event) => {
        listRef.current?.scrollBy(event.deltaY > 0 ? 3 : -3);
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <SessionListBody
        actions={actions}
        listRef={listRef}
        nameMaxWidth={Math.max(3, sidebarWidth - 9)}
        view={view}
      />
    </Box>
  );
}

function SessionListBody({
  listRef,
  view,
  actions,
  nameMaxWidth,
}: {
  listRef: React.RefObject<ListViewHandle | null>;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  nameMaxWidth: number;
}) {
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  const sessions = view.state.sessions;
  return (
    <ListView
      active={false}
      estimateHeight={2}
      getKey={(session) => session.id}
      height={height}
      items={sessions}
      ref={listRef}
      renderItem={(session) => (
        <SessionRow
          actions={actions}
          active={session.id === view.state.activeSessionId}
          canClose={sessions.length > 1}
          diff={view.diffs.get(session.cwd)}
          index={sessions.indexOf(session)}
          nameMaxWidth={nameMaxWidth}
          session={session}
        />
      )}
    />
  );
}

function CollapsedSessionsRail({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const click = (event: { stopPropagation(): void }) => {
    actions.toggleSidebar();
    event.stopPropagation();
  };

  return (
    <Box
      alignItems="center"
      backgroundColor={colors.panel}
      borderColor={colors.border}
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      onClick={click}
      width={COLLAPSED_SESSIONS_SIDEBAR_WIDTH}
    >
      <Text color={colors.accentAlt}>{">"}</Text>
      <Text color={colors.dim}>
        {String(view.state.sessions.length).slice(0, 1)}
      </Text>
    </Box>
  );
}

function CollapseButton({
  pinned,
  actions,
}: {
  pinned: boolean;
  actions: WorkbenchActions;
}) {
  const toggle = () => actions.toggleSidebar();
  return (
    <Button
      color={colors.accentAlt}
      focusable={false}
      label={pinned ? "<" : "*"}
      onClick={(event) => {
        toggle();
        event.stopPropagation();
      }}
      onPress={toggle}
    />
  );
}

function NewAgentRow({
  actions,
  compact,
}: {
  actions: WorkbenchActions;
  compact: boolean;
}) {
  const open = () => actions.openNewAgent();
  return (
    <Box marginTop={1}>
      <Button
        focusable={false}
        label={compact ? "+ New" : "+ New workspace"}
        onClick={(event) => {
          open();
          event.stopPropagation();
        }}
        onPress={open}
        variant="accent"
        width="100%"
      />
    </Box>
  );
}

function SessionRow({
  session,
  index,
  active,
  canClose,
  diff,
  actions,
  nameMaxWidth,
}: {
  session: AgentSession;
  index: number;
  active: boolean;
  canClose: boolean;
  diff?: SessionDiff;
  actions: WorkbenchActions;
  nameMaxWidth: number;
}) {
  const select = (event: { stopPropagation(): void }) => {
    actions.selectSession(session.id);
    event.stopPropagation();
  };
  const close = (event: { stopPropagation(): void }) => {
    actions.closeSession(session.id);
    event.stopPropagation();
  };
  const hasChanges = diff && diff.files.length > 0;
  // First 9 sessions get a dim index badge matching their Option+Shift+N shortcut.
  const hint = index < 9 ? String(index + 1) : undefined;

  return (
    <Box
      backgroundColor={active ? colors.selectedMuted : colors.panel}
      flexDirection="column"
      flexShrink={0}
      height={2}
      onClick={select}
      paddingLeft={1}
    >
      <Box flexDirection="row" height={1}>
        <Box flexDirection="row" flexGrow={1} marginRight={1} minWidth={1}>
          {hint ? (
            <Text
              color={active ? colors.accent : colors.dim}
            >{`${hint} `}</Text>
          ) : null}
          <Text
            color={active ? colors.accent : colors.text}
            flexShrink={1}
            minWidth={1}
            wrap={false}
          >
            {truncateText(session.name, nameMaxWidth, "...")}
          </Text>
        </Box>
        {canClose ? (
          <Text color={colors.dim} onClick={close}>
            x
          </Text>
        ) : null}
      </Box>
      {hasChanges ? (
        <Box flexDirection="row" height={1} justifyContent="flex-end">
          <Badge label={`+${diff.totalAdded}`} variant="success" />
          <Text> </Text>
          <Badge label={`-${diff.totalDeleted}`} variant="error" />
        </Box>
      ) : null}
    </Box>
  );
}
