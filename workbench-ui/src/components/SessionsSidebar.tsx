import { useEffect, useRef, useState } from "react";
import {
  AnchoredOverlay,
  Box,
  Button,
  displayWidth,
  ListView,
  type ListViewHandle,
  Text,
  truncateText,
  useBoxRectDangerously,
  useWindowSize,
} from "silvery";
import { buildVerticalWorkbenchArt } from "../media/splash";
import type { AgentSession } from "../state/types";
import type { SessionDiff } from "../text/diff";
import {
  COLLAPSED_SESSIONS_SIDEBAR_WIDTH,
  COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH,
  clampPaneWidth,
  MIN_SESSIONS_SIDEBAR_WIDTH,
  maxSessionsSidebarWidth,
} from "../ui/pane-layout";
import { colors } from "../ui/theme";
import { CloseButton } from "./CloseButton";
import { PanelCollapseButton } from "./PanelCollapseButton";
import { PaneResizeHandle } from "./PaneResizeHandle";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

export function SessionsSidebar({
  view,
  actions,
  onOpenHelp,
  onContextMenuChange,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onOpenHelp(): void;
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
    view.state.workspaceSidePaneVisible
      ? view.state.workspaceSidePaneWidth
      : COLLAPSED_WORKSPACE_SIDE_PANE_WIDTH
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
      >
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={1}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
        >
          <Box flexDirection="row" height={1} justifyContent="space-between">
            <Box flexDirection="row" minWidth={1}>
              <Text bold color={colors.text}>
                Sessions
              </Text>
              <Text color={colors.dim}>{` ${view.state.sessions.length}`}</Text>
            </Box>
            <Box flexDirection="row">
              <HelpButton compact={width < 26} onOpen={onOpenHelp} />
              <CollapseButton actions={actions} />
            </Box>
          </Box>
          <NewAgentRow actions={actions} compact={width < 22} />
          <SessionList
            actions={actions}
            onContextMenuChange={onContextMenuChange}
            view={view}
          />
        </Box>
        <VerticalWorkbenchArt />
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

// Keyboard session navigation (up/down/x/return) stays in Workbench.handleKey;
// this ListView windows the rows and adds ref-driven wheel scrolling so the two
// input paths never fight over arrow keys.
function SessionList({
  view,
  actions,
  onContextMenuChange,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onContextMenuChange(value: SessionContextMenuState | null): void;
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
        listRef.current?.scrollBy(
          event.deltaY > 0
            ? SESSION_CARD_HEIGHT + SESSION_CARD_GAP
            : -(SESSION_CARD_HEIGHT + SESSION_CARD_GAP)
        );
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <SessionListBody
        actions={actions}
        listRef={listRef}
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
  onContextMenuChange,
}: {
  listRef: React.RefObject<ListViewHandle | null>;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onContextMenuChange(value: SessionContextMenuState | null): void;
}) {
  const rect = useBoxRectDangerously();
  const height = Math.max(1, Math.floor(rect.height));
  const cardWidth = Math.max(8, Math.floor(rect.width));
  const sessions = view.state.sessions;
  return (
    <ListView
      active={false}
      estimateHeight={SESSION_CARD_HEIGHT + SESSION_CARD_GAP}
      gap={SESSION_CARD_GAP}
      getKey={(session) => session.id}
      height={height}
      items={sessions}
      ref={listRef}
      renderItem={(session) => (
        <SessionCard
          actions={actions}
          canClose={sessions.length > 1}
          diff={view.diffs.get(session.cwd)}
          index={sessions.indexOf(session)}
          onContextMenuChange={onContextMenuChange}
          running={view.runningSessionIds.has(session.id)}
          selected={session.id === view.state.activeSessionId}
          session={session}
          width={cardWidth}
        />
      )}
    />
  );
}

export const SESSION_CARD_HEIGHT = 3;
export const SESSION_CARD_GAP = 0;

function VerticalWorkbenchArt() {
  const { rows } = useWindowSize();
  const artRows = Math.min(32, Math.max(1, rows - 20));
  const lines = buildVerticalWorkbenchArt(artRows, 1.5);
  return (
    <Box
      alignItems="flex-end"
      flexDirection="column"
      flexShrink={1}
      height={artRows}
      justifyContent="flex-end"
      minHeight={1}
      overflow="hidden"
    >
      {lines.map((line, index) => (
        <Text color={colors.accentAlt} key={`${index}-${line}`} wrap={false}>
          {line}
        </Text>
      ))}
    </Box>
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

function CollapseButton({ actions }: { actions: WorkbenchActions }) {
  return <PanelCollapseButton onCollapse={actions.toggleSidebar} />;
}

function HelpButton({ compact, onOpen }: { compact: boolean; onOpen(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      backgroundColor={hovered ? colors.selectedMuted : undefined}
      mouseCursor="pointer"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Button
        color={hovered ? colors.accent : colors.accentAlt}
        focusable={false}
        label={compact ? "?" : "? Help"}
        onClick={(event) => {
          onOpen();
          event.stopPropagation();
        }}
        onPress={onOpen}
      />
    </Box>
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

function SessionCard({
  session,
  index,
  running,
  selected,
  canClose,
  diff,
  actions,
  width,
  onContextMenuChange,
}: {
  session: AgentSession;
  index: number;
  running: boolean;
  selected: boolean;
  canClose: boolean;
  diff?: SessionDiff;
  actions: WorkbenchActions;
  width: number;
  onContextMenuChange(value: SessionContextMenuState | null): void;
}) {
  const [hovered, setHovered] = useState(false);
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
  const added = hasChanges ? compactDiffCount(diff.totalAdded) : "";
  const deleted = hasChanges ? compactDiffCount(diff.totalDeleted) : "";
  const diffWidth = hasChanges ? added.length + deleted.length + 3 : 0;
  // First 9 sessions get a dim index badge matching their Option+Shift+N shortcut.
  const hint = index < 9 ? String(index + 1) : undefined;
  const hintText = hint ? `${hint} ` : "";
  const closeWidth = canClose ? 3 : 0;
  const titleMaxWidth = Math.max(1, width - 4 - hintText.length);
  const title = `${hintText}${truncateText(session.name, titleMaxWidth, "...")}`;
  const titleFillWidth = Math.max(0, width - 4 - displayWidth(title));
  const topFillWidth = Math.max(0, width - 2 - closeWidth);
  const flowWidth = running
    ? Math.max(1, Math.min(11, width - diffWidth - 2))
    : 0;
  const bottomFillWidth = Math.max(0, width - 2 - flowWidth - diffWidth);
  const surface = selected
    ? hovered
      ? colors.selectedHover
      : colors.selected
    : hovered
      ? colors.selectedMuted
      : colors.panel;
  const foreground = selected ? colors.onSelected : colors.text;
  const border = selected || hovered ? colors.borderFocus : colors.border;

  return (
    <Box
      anchorRef={anchorId}
      backgroundColor={surface}
      flexDirection="column"
      flexShrink={0}
      height={SESSION_CARD_HEIGHT}
      onClick={select}
      onMouseDown={(event) => {
        if (event.button !== 2) {
          return;
        }
        onContextMenuChange({ anchorId, sessionId: session.id });
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      width={width}
    >
      <Box backgroundColor={surface} flexDirection="row" height={1}>
        <Text color={border}>╭</Text>
        <Text color={border}>{"─".repeat(topFillWidth)}</Text>
        {canClose ? (
          <CloseButton
            color={foreground}
            onClose={() => actions.closeSession(session.id)}
          />
        ) : null}
        <Text color={border}>╮</Text>
      </Box>
      <Box backgroundColor={surface} flexDirection="row" height={1}>
        <Text color={border}>│ </Text>
        <Text bold={selected || running} color={foreground} wrap={false}>
          {title}
        </Text>
        <Text color={surface}>{" ".repeat(titleFillWidth)}</Text>
        <Text color={border}> │</Text>
      </Box>
      <Box backgroundColor={surface} flexDirection="row" height={1}>
        <Text color={border}>╰</Text>
        {running ? <RunningSessionFlow width={flowWidth} /> : null}
        <Text color={border}>{"─".repeat(bottomFillWidth)}</Text>
        {hasChanges ? (
          <>
            <Text color={colors.diffAddFg}>{`+${added}`}</Text>
            <Text color={border}> </Text>
            <Text color={colors.diffDelFg}>{`-${deleted}`}</Text>
          </>
        ) : null}
        <Text color={border}>╯</Text>
      </Box>
    </Box>
  );
}

export function compactDiffCount(value: number): string {
  const count = Math.max(0, Math.floor(value));
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${Math.floor(count / 1000)}k`;
  }
  return `${Math.min(999, Math.floor(count / 1_000_000))}m`;
}

const SESSION_FLOW_INTERVAL_MS = 100;
const SESSION_FLOW_STRENGTHS = [1, 0.72, 0.48, 0.28, 0.12] as const;

function RunningSessionFlow({ width }: { width: number }) {
  const [step, setStep] = useState(0);
  const point = sessionFlowOffset(step, width);

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

export function sessionFlowOffset(step: number, width: number): number {
  // The bright point itself travels edge-to-edge. Its fading tail is clipped
  // naturally by sessionFlowStrengths(), so subtracting the tail width here
  // would freeze short rails (notably rows narrowed by diff badges).
  const travel = Math.max(0, Math.floor(width) - 1);
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
