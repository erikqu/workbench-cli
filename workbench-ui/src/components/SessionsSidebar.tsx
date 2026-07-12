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
} from "silvery";
import type { AgentSession } from "../state/types";
import type { SessionDiff } from "../text/diff";
import { colors, THEME_LABELS } from "../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

const sidebarWidth = 26;
const collapsedWidth = 3;
// Leaves room for sidebar padding, the shortcut index, a gap, and the close x.
const sessionNameMaxWidth = sidebarWidth - 9;

export function SessionsSidebar({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  if (!view.state.sidebarVisible) {
    return <CollapsedSessionsRail actions={actions} view={view} />;
  }

  return (
    <Box
      backgroundColor={colors.panel}
      borderColor={
        view.state.focus === "sessions" ? colors.borderFocus : colors.border
      }
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      height="100%"
      minHeight={1}
      onMouseDown={() => actions.focus("sessions")}
      overflow="hidden"
      padding={1}
      width={sidebarWidth}
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
      <NewAgentRow actions={actions} />
      <SessionList actions={actions} view={view} />
      <SidebarControls actions={actions} view={view} />
    </Box>
  );
}

// Reminds keyboard users how to jump around. The badges on the tabs and session
// rows map 1:1 to these numbers; Shift selects the left (session) column.
function SidebarControls({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
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
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      <Box flexDirection="row" height={1} justifyContent="space-between">
        <Text color={colors.accentAlt} onClick={cycleTheme} wrap={false}>
          {`Theme: ${themeLabel}`}
        </Text>
        <Text color={colors.dim} onClick={quit}>
          Quit
        </Text>
      </Box>
      <LegendRow keys="⌥1-9" label="tab" />
      <LegendRow keys="⌥⇧1-9" label="session" />
      <LegendRow keys="⌥Space" label="next session" />
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
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
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
      <SessionListBody actions={actions} listRef={listRef} view={view} />
    </Box>
  );
}

function SessionListBody({
  listRef,
  view,
  actions,
}: {
  listRef: React.RefObject<ListViewHandle | null>;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
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
      width={collapsedWidth}
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

function NewAgentRow({ actions }: { actions: WorkbenchActions }) {
  const open = () => actions.openNewAgent();
  return (
    <Box marginTop={1}>
      <Button
        focusable={false}
        label="+ New workspace"
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
}: {
  session: AgentSession;
  index: number;
  active: boolean;
  canClose: boolean;
  diff?: SessionDiff;
  actions: WorkbenchActions;
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
            {truncateText(session.name, sessionNameMaxWidth, "...")}
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
