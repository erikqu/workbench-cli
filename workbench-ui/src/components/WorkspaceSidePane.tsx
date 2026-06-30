import { useRef } from "react";
import {
  Box,
  Button,
  ListView,
  type ListViewHandle,
  Text,
  useBoxRectDangerously,
} from "silvery";
import { harnessSpec } from "../state/harnesses";
import { harnessIdFromTab, terminalIdFromTab } from "../state/types";
import { colors } from "../ui/theme";
import { ChangesSidebarList } from "./ChangesView";
import { ExplorerSection } from "./Explorer";
import type { WorkbenchActions, WorkbenchViewModel } from "./types";

const sidePaneWidth = 30;
const agentRows = 3;
const minTerminalRows = 3;
const minChangesRows = 4;
const maxTerminalRows = 6;

export function WorkspaceSidePane({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const rect = useBoxRectDangerously();
  const totalRows = Math.max(1, Math.floor(rect.height));
  // Fixed row budgets: no section flexes after mount, which avoids measured
  // ListViews growing the side pane and pushing lower controls out of sight.
  const contentRows = Math.max(1, totalRows - 2);
  const availableRows = Math.max(3, contentRows - agentRows);
  const terminalTarget = Math.min(
    maxTerminalRows,
    Math.max(minTerminalRows, view.session.terminals.length + 1)
  );
  const terminalRows = Math.min(terminalTarget, Math.max(1, availableRows - 2));
  const changesTarget = Math.max(
    minChangesRows,
    Math.floor(availableRows * 0.3)
  );
  const changesRows = Math.max(
    1,
    Math.min(changesTarget, availableRows - terminalRows - 1)
  );
  const explorerRows = Math.max(1, availableRows - terminalRows - changesRows);

  return (
    <Box
      backgroundColor={colors.panel}
      borderColor={
        view.state.focus === "explorer" ? colors.borderFocus : colors.border
      }
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      height="100%"
      minHeight={1}
      overflow="hidden"
      padding={1}
      width={sidePaneWidth}
    >
      <AgentButton actions={actions} view={view} />
      <ExplorerSection actions={actions} height={explorerRows} view={view} />
      <TerminalSection actions={actions} height={terminalRows} view={view} />
      <ChangesSection actions={actions} height={changesRows} view={view} />
    </Box>
  );
}

function TerminalSection({
  view,
  actions,
  height,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  height: number;
}) {
  const listRef = useRef<ListViewHandle>(null);
  const terminals = view.session.terminals;
  const activeId = terminalIdFromTab(view.session.activeMainTab);
  const listHeight = Math.max(1, height - 1);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={height}
      minHeight={1}
      minWidth={1}
      overflow="hidden"
    >
      <Box
        backgroundColor={colors.panelAlt}
        flexDirection="row"
        flexShrink={0}
        height={1}
        justifyContent="space-between"
        paddingX={1}
      >
        <Text color={colors.accentAlt}>Terminals</Text>
        <Text color={colors.accentAlt} onClick={() => actions.newTerminal()}>
          +
        </Text>
      </Box>
      {terminals.length === 0 ? (
        <Text color={colors.dim}>No terminals</Text>
      ) : (
        <Box
          flexShrink={0}
          height={listHeight}
          minWidth={1}
          onWheel={(event) => {
            listRef.current?.scrollBy(event.deltaY > 0 ? 3 : -3);
            event.preventDefault();
            event.stopPropagation();
          }}
          overflow="hidden"
        >
          <ListView
            active={false}
            getKey={(terminal) => terminal.id}
            height={listHeight}
            items={terminals}
            ref={listRef}
            renderItem={(terminal) => (
              <TerminalRow
                active={terminal.id === activeId}
                name={terminal.name}
                onSelect={() =>
                  actions.selectMainTab({
                    description: terminal.cwd,
                    name: terminal.name,
                    value: `term:${terminal.id}`,
                  })
                }
              />
            )}
          />
        </Box>
      )}
    </Box>
  );
}

function TerminalRow({
  name,
  active,
  onSelect,
}: {
  name: string;
  active: boolean;
  onSelect(): void;
}) {
  return (
    <Box
      backgroundColor={active ? colors.selectedMuted : colors.panel}
      flexShrink={0}
      height={1}
      onClick={(event) => {
        onSelect();
        event.stopPropagation();
      }}
    >
      <Text color={active ? colors.accent : colors.text} wrap={false}>
        {name}
      </Text>
    </Box>
  );
}

function ChangesSection({
  view,
  actions,
  height,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  height: number;
}) {
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={height}
      minHeight={1}
      minWidth={1}
      overflow="hidden"
    >
      <ChangesSidebarList actions={actions} view={view} />
    </Box>
  );
}

function AgentButton({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const harness =
    view.session.harnesses.find(
      (item) => `harness:${item.id}` === view.session.activeMainTab
    ) ?? view.session.harnesses[0];
  const spec = harnessSpec(harness?.harnessId ?? "cursor");
  const active = harness
    ? harnessIdFromTab(view.session.activeMainTab) === harness.id
    : false;

  const select = () => {
    if (!harness) {
      return;
    }
    actions.selectMainTab({
      description: `${spec.label} | ${harness.cwd}`,
      name: harness.name,
      value: `harness:${harness.id}`,
    });
  };

  return (
    <Box flexDirection="column" flexShrink={0} height={agentRows}>
      <Box
        backgroundColor={colors.panelAlt}
        flexDirection="row"
        flexShrink={0}
        height={1}
        justifyContent="space-between"
        paddingX={1}
      >
        <Text color={colors.accentAlt}>Agent</Text>
        <Text color={colors.dim}>{spec.label}</Text>
      </Box>
      <Button
        color={active ? colors.onSelected : colors.accentAlt}
        focusable={false}
        label={harness?.name ?? "Agent"}
        onClick={(event) => {
          select();
          event.stopPropagation();
        }}
        onPress={select}
        variant="accent"
        width="100%"
      />
    </Box>
  );
}
