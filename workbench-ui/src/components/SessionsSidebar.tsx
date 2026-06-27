import { homedir } from "node:os";
import { useRef } from "react";
import {
  Badge,
  Box,
  Button,
  ListView,
  type ListViewHandle,
  Text,
  useBoxRectDangerously,
} from "silvery";
import { harnessSpec } from "../state/harnesses";
import type { AgentSession } from "../state/types";
import type { SessionDiff } from "../text/diff";
import { colors, THEME_LABELS } from "../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

const sidebarWidth = 26;
const collapsedWidth = 3;
const pathWidth = sidebarWidth - 4;

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
      onMouseDown={() => actions.focus("sessions")}
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
      <Button
        color={colors.accentAlt}
        focusable={false}
        label={`Theme: ${themeLabel}`}
        onClick={cycleTheme}
        onPress={() => actions.cycleTheme()}
        width="100%"
      />
      <Button
        color={colors.dim}
        focusable={false}
        label="Quit"
        onClick={quit}
        onPress={() => actions.shutdown(0)}
        width="100%"
      />
      <Box height={1} />
      <LegendRow keys="⌥1-9" label="tab" />
      <LegendRow keys="⌥⇧1-9" label="session" />
      <LegendRow keys="⌥Space" label="cycle" />
      <LegendRow keys="⌥+" label="new" />
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
      marginTop={1}
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
      <Box flexDirection="row" height={1} justifyContent="space-between">
        <Box flexDirection="row" minWidth={1}>
          {hint ? (
            <Text
              color={active ? colors.accent : colors.dim}
            >{`${hint} `}</Text>
          ) : null}
          <Text color={active ? colors.accent : colors.text} wrap={false}>
            {session.name}
          </Text>
        </Box>
        {canClose ? (
          <Text color={colors.dim} onClick={close}>
            x
          </Text>
        ) : null}
      </Box>
      {hasChanges ? (
        <Box flexDirection="row" height={1}>
          <Badge label={`+${diff!.totalAdded}`} variant="success" />
          <Text> </Text>
          <Badge label={`-${diff!.totalDeleted}`} variant="error" />
          <Text color={colors.dim} wrap={false}>
            {` ${activeHarnessLabel(session)}`}
          </Text>
        </Box>
      ) : (
        <Text
          color={colors.dim}
        >{`${activeHarnessLabel(session)} | ${shortenPath(session.cwd)}`}</Text>
      )}
    </Box>
  );
}

function activeHarnessLabel(session: AgentSession) {
  const active = session.harnesses.find(
    (harness) => `harness:${harness.id}` === session.activeMainTab
  );
  return harnessSpec(
    active?.harnessId ?? session.harnesses[0]?.harnessId ?? "workbench"
  ).label;
}

function shortenPath(path: string) {
  const home = homedir();
  const display = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  if (display.length <= pathWidth) {
    return display;
  }
  return `..${display.slice(display.length - pathWidth + 2)}`;
}
