import { useEffect, useRef, useState } from "react";
import {
  AnchoredOverlay,
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
import { CloseButton } from "./CloseButton";
import { PaneResizeHandle } from "./PaneResizeHandle";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

export function SessionsSidebar({
  view,
  actions,
  onContextMenuChange,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onContextMenuChange(value: SessionContextMenuState | null): void;
}) {
  const { columns } = useWindowSize();
  if (!view.state.sidebarVisible) {
    return (
      <CollapsedSessionsRail
        actions={actions}
        onContextMenuChange={onContextMenuChange}
        view={view}
      />
    );
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
        <SessionList
          actions={actions}
          onContextMenuChange={onContextMenuChange}
          sidebarWidth={width}
          view={view}
        />
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
  onContextMenuChange,
  sidebarWidth,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onContextMenuChange(value: SessionContextMenuState | null): void;
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
        onContextMenuChange={onContextMenuChange}
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
  onContextMenuChange,
}: {
  listRef: React.RefObject<ListViewHandle | null>;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  nameMaxWidth: number;
  onContextMenuChange(value: SessionContextMenuState | null): void;
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
          canClose={sessions.length > 1}
          diff={view.diffs.get(session.cwd)}
          index={sessions.indexOf(session)}
          nameMaxWidth={nameMaxWidth}
          onContextMenuChange={onContextMenuChange}
          running={view.runningSessionIds.has(session.id)}
          selected={session.id === view.state.activeSessionId}
          session={session}
        />
      )}
    />
  );
}

function CollapsedSessionsRail({
  view,
  actions,
  onContextMenuChange,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onContextMenuChange(value: SessionContextMenuState | null): void;
}) {
  const click = (event: { stopPropagation(): void }) => {
    actions.toggleSidebar();
    event.stopPropagation();
  };
  const shortcutSessions = view.state.sessions.slice(0, 9);

  return (
    <Box
      alignItems="center"
      backgroundColor={colors.panel}
      borderColor={colors.border}
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      onClick={click}
      overflow="hidden"
      width={COLLAPSED_SESSIONS_SIDEBAR_WIDTH}
    >
      <Text color={colors.accentAlt}>{">"}</Text>
      {shortcutSessions.map((session, index) => {
        const selected = session.id === view.state.activeSessionId;
        const running = view.runningSessionIds.has(session.id);
        return (
          <Box
            anchorRef={`workbench-session-${session.id}`}
            backgroundColor={selected ? colors.selected : colors.panel}
            key={session.id}
            onClick={(event) => {
              if (event.button !== 0) {
                return;
              }
              actions.selectSession(session.id);
              event.stopPropagation();
            }}
            onMouseDown={(event) => {
              if (event.button !== 2) {
                return;
              }
              onContextMenuChange({
                anchorId: `workbench-session-${session.id}`,
                sessionId: session.id,
              });
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <Text
              bold={selected || running}
              color={
                selected
                  ? colors.onSelected
                  : running
                    ? colors.accentAlt
                    : colors.dim
              }
            >
              {String(index + 1)}
            </Text>
          </Box>
        );
      })}
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
  running,
  selected,
  canClose,
  diff,
  actions,
  nameMaxWidth,
  onContextMenuChange,
}: {
  session: AgentSession;
  index: number;
  running: boolean;
  selected: boolean;
  canClose: boolean;
  diff?: SessionDiff;
  actions: WorkbenchActions;
  nameMaxWidth: number;
  onContextMenuChange(value: SessionContextMenuState | null): void;
}) {
  const anchorId = `workbench-session-${session.id}`;
  const select = (event: { button: number; stopPropagation(): void }) => {
    if (event.button !== 0) {
      event.stopPropagation();
      return;
    }
    onContextMenuChange(null);
    actions.selectSession(session.id);
    event.stopPropagation();
  };
  const hasChanges = diff && diff.files.length > 0;
  const diffWidth = hasChanges
    ? String(diff.totalAdded).length + String(diff.totalDeleted).length + 5
    : 0;
  const flowWidth = Math.max(1, nameMaxWidth - diffWidth);
  // First 9 sessions get a dim index badge matching their Option+Shift+N shortcut.
  const hint = index < 9 ? String(index + 1) : undefined;

  return (
    <Box
      anchorRef={anchorId}
      backgroundColor={selected ? colors.selectedMuted : colors.panel}
      flexDirection="column"
      flexShrink={0}
      height={2}
      onClick={select}
      onMouseDown={(event) => {
        if (event.button !== 2) {
          return;
        }
        onContextMenuChange({ anchorId, sessionId: session.id });
        event.preventDefault();
        event.stopPropagation();
      }}
      paddingLeft={1}
    >
      <Box flexDirection="row" height={1}>
        <Box flexDirection="row" flexGrow={1} minWidth={1}>
          {hint ? (
            <Text
              color={selected ? colors.accent : colors.dim}
            >{`${hint} `}</Text>
          ) : null}
          <Text
            bold={selected || running}
            color={selected ? colors.onSelected : colors.text}
            flexShrink={1}
            minWidth={1}
            wrap={false}
          >
            {truncateText(session.name, nameMaxWidth, "...")}
          </Text>
        </Box>
        {canClose ? (
          <CloseButton onClose={() => actions.closeSession(session.id)} />
        ) : null}
      </Box>
      <Box flexDirection="row" height={1} justifyContent="space-between">
        {running ? <RunningSessionFlow width={flowWidth} /> : <Text> </Text>}
        {hasChanges ? (
          <Box flexDirection="row">
            <Badge label={`+${diff.totalAdded}`} variant="success" />
            <Text> </Text>
            <Badge label={`-${diff.totalDeleted}`} variant="error" />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

const SESSION_FLOW_SEGMENT_WIDTH = 5;
const SESSION_FLOW_INTERVAL_MS = 100;
const SESSION_FLOW_STRENGTHS = [1, 0.72, 0.48, 0.28, 0.12] as const;

function RunningSessionFlow({ width }: { width: number }) {
  const [step, setStep] = useState(0);
  const point = sessionFlowOffset(step, width, 1);

  useEffect(() => {
    const interval = setInterval(
      () => setStep((value) => value + 1),
      SESSION_FLOW_INTERVAL_MS
    );
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="row" height={1}>
      {sessionFlowStrengths(point, width).map((strength, index) => (
        <Text
          bold={strength === 1}
          color={mixHexColors(colors.border, colors.accentAlt, strength)}
          key={index}
        >
          {strength > 0 ? "━" : "─"}
        </Text>
      ))}
    </Box>
  );
}

export function sessionFlowStrengths(point: number, width: number): number[] {
  const safeWidth = Math.max(0, Math.floor(width));
  return Array.from({ length: safeWidth }, (_, index) => {
    const distance = Math.abs(index - point);
    return SESSION_FLOW_STRENGTHS[distance] ?? 0;
  });
}

function mixHexColors(low: string, high: string, strength: number): string {
  const parse = (value: string) =>
    /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i
      .exec(value)
      ?.slice(1)
      .map((part) => Number.parseInt(part, 16));
  const lowRgb = parse(low);
  const highRgb = parse(high);
  if (!(lowRgb && highRgb)) {
    return strength >= 0.5 ? high : low;
  }
  const channel = (index: number) =>
    Math.round(lowRgb[index] + (highRgb[index] - lowRgb[index]) * strength)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function sessionFlowOffset(
  step: number,
  width: number,
  segmentWidth = SESSION_FLOW_SEGMENT_WIDTH
): number {
  const travel = Math.max(
    0,
    Math.floor(width) - Math.max(1, Math.floor(segmentWidth))
  );
  if (travel === 0) {
    return 0;
  }
  const cycle = travel * 2;
  const phase = ((Math.floor(step) % cycle) + cycle) % cycle;
  return phase <= travel ? phase : cycle - phase;
}

export interface SessionContextMenuState {
  anchorId: string;
  sessionId: string;
}

type SessionCloseScope = "bottom" | "others" | "top";

export function sessionCloseTargets(
  sessions: readonly AgentSession[],
  target: string,
  scope: SessionCloseScope
): string[] {
  const targetIndex = sessions.findIndex((session) => session.id === target);
  if (targetIndex === -1) {
    return [];
  }
  return sessions
    .filter((session, index) => {
      if (session.id === target) {
        return false;
      }
      if (scope === "top") {
        return index < targetIndex;
      }
      if (scope === "bottom") {
        return index > targetIndex;
      }
      return true;
    })
    .map((session) => session.id);
}

export function SessionContextMenuOverlay({
  actions,
  contextMenu,
  onClose,
  view,
}: {
  actions: WorkbenchActions;
  contextMenu: SessionContextMenuState | null;
  onClose(): void;
  view: WorkbenchViewModel;
}) {
  if (!contextMenu) {
    return null;
  }
  if (
    !view.state.sessions.some((session) => session.id === contextMenu.sessionId)
  ) {
    return null;
  }
  const close = (scope: SessionCloseScope) => {
    const targets = sessionCloseTargets(
      view.state.sessions,
      contextMenu.sessionId,
      scope
    );
    onClose();
    for (const id of targets) {
      actions.closeSession(id);
    }
  };

  return (
    <AnchoredOverlay
      anchorId={contextMenu.anchorId}
      backgroundColor={colors.panel}
      borderColor={colors.borderFocus}
      borderStyle="round"
      flexDirection="column"
      onMouseDown={(event) => event.stopPropagation()}
      open
      placement="right-start"
      size={{ width: 24, height: 5 }}
    >
      <SessionContextMenuRow
        label="Close Others"
        onPress={() => close("others")}
      />
      <SessionContextMenuRow
        label="Close to the Top"
        onPress={() => close("top")}
      />
      <SessionContextMenuRow
        label="Close to the Bottom"
        onPress={() => close("bottom")}
      />
    </AnchoredOverlay>
  );
}

function SessionContextMenuRow({
  label,
  onPress,
}: {
  label: string;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      backgroundColor={hovered ? colors.selected : colors.panel}
      height={1}
      onClick={(event) => {
        if (event.button !== 0) {
          return;
        }
        onPress();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      paddingX={1}
      width="100%"
    >
      <Text color={hovered ? colors.onSelected : colors.text}>{label}</Text>
    </Box>
  );
}
