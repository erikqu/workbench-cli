import { useRef, useState } from "react";
import {
  AnchoredOverlay,
  Box,
  displayWidth,
  Text,
  useBoxRectDangerously,
} from "silvery";
import { harnessIdFromTab } from "../state/types";
import { colors } from "../ui/theme";
import { CloseButton } from "./CloseButton";
import type {
  TabSelectOption,
  WorkbenchActions,
  WorkbenchViewModel,
} from "./types";

export function MainTabs({
  view,
  actions,
  onContextMenuChange,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onContextMenuChange(value: TabContextMenuState | null): void;
}) {
  const rect = useBoxRectDangerously();
  const canCloseHarness = view.session.harnesses.length > 1;
  return (
    <Box
      backgroundColor={colors.editor}
      flexDirection="row"
      height={2}
      onMouseDown={(event) => {
        if (event.button !== 2) {
          return;
        }
        const index = tabIndexAtOffset(
          view.mainTabOptions,
          Math.floor(event.x - rect.x),
          canCloseHarness
        );
        const option = view.mainTabOptions[index];
        if (!option) {
          return;
        }
        onContextMenuChange({
          anchorId: `workbench-tab-${index}`,
          value: option.value,
        });
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {view.mainTabOptions.map((option, index) => (
        <Tab
          actions={actions}
          active={option.value === view.session.activeMainTab}
          anchorId={`workbench-tab-${index}`}
          canCloseHarness={canCloseHarness}
          index={index}
          key={String(option.value)}
          onContextMenuChange={onContextMenuChange}
          option={option}
        />
      ))}
    </Box>
  );
}

export interface TabContextMenuState {
  anchorId: string;
  value: string;
}

function Tab({
  option,
  index,
  active,
  canCloseHarness,
  actions,
  anchorId,
  onContextMenuChange,
}: {
  option: TabSelectOption;
  index: number;
  active: boolean;
  canCloseHarness: boolean;
  actions: WorkbenchActions;
  anchorId: string;
  onContextMenuChange(value: TabContextMenuState | null): void;
}) {
  const [hovered, setHovered] = useState(false);
  const suppressNextClick = useRef(false);
  const value = option.value;
  const closable = harnessIdFromTab(value) ? canCloseHarness : true;
  const select = (event: { button: number; stopPropagation(): void }) => {
    if (suppressNextClick.current || event.button !== 0) {
      suppressNextClick.current = false;
      event.stopPropagation();
      return;
    }
    onContextMenuChange(null);
    actions.selectMainTab(option);
    event.stopPropagation();
  };
  const rowBg = active
    ? colors.selected
    : hovered
      ? colors.selectedMuted
      : colors.editor;
  const labelColor = active
    ? colors.accent
    : hovered
      ? colors.text
      : colors.dim;
  // Keep every available close action visible. The shared close button is
  // three cells wide and bold, with the destructive inverse color reserved
  // for hover so the strip stays calm until the user targets the action.
  const showClose = closable;
  // The first 9 tabs get a dim index badge matching their Option+N shortcut.
  const hint = index < 9 ? String(index + 1) : undefined;
  const openContextMenu = (event: {
    button: number;
    preventDefault(): void;
    stopPropagation(): void;
  }) => {
    if (event.button !== 2) {
      return;
    }
    suppressNextClick.current = true;
    onContextMenuChange({ anchorId, value });
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Box
      anchorRef={anchorId}
      flexDirection="column"
      flexShrink={0}
      height={2}
      onMouseDown={openContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseUp={openContextMenu}
    >
      <Box
        alignItems="center"
        backgroundColor={rowBg}
        flexDirection="row"
        height={1}
        onClick={select}
        onMouseDown={openContextMenu}
        onMouseUp={openContextMenu}
        paddingLeft={1}
        paddingRight={showClose ? 0 : 1}
      >
        {hint ? (
          <Text color={active ? colors.accent : colors.dim}>{`${hint} `}</Text>
        ) : null}
        <Text color={labelColor}>{option.name}</Text>
        {showClose ? (
          <CloseButton onClose={() => actions.closeTab(value)} />
        ) : null}
      </Box>
      <Box
        backgroundColor={active ? colors.accent : colors.editor}
        height={1}
        width="100%"
      />
    </Box>
  );
}

type TabCloseScope = "left" | "others" | "right";

export function tabCloseTargets(
  options: readonly TabSelectOption[],
  target: string,
  scope: TabCloseScope,
  canCloseHarness: boolean
): string[] {
  const targetIndex = options.findIndex((option) => option.value === target);
  if (targetIndex === -1) {
    return [];
  }
  return options
    .filter((option, index) => {
      if (option.value === target) {
        return false;
      }
      if (scope === "left" && index >= targetIndex) {
        return false;
      }
      if (scope === "right" && index <= targetIndex) {
        return false;
      }
      return !harnessIdFromTab(option.value) || canCloseHarness;
    })
    .map((option) => option.value);
}

export function tabIndexAtOffset(
  options: readonly TabSelectOption[],
  offset: number,
  canCloseHarness: boolean
): number {
  let start = 0;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (!option) {
      continue;
    }
    const closable = !harnessIdFromTab(option.value) || canCloseHarness;
    const hintWidth = index < 9 ? 2 : 0;
    const width =
      1 + hintWidth + displayWidth(option.name) + (closable ? 3 : 1);
    if (offset >= start && offset < start + width) {
      return index;
    }
    start += width;
  }
  return -1;
}

export function TabContextMenuOverlay({
  contextMenu,
  view,
  actions,
  onClose,
}: {
  contextMenu: TabContextMenuState | null;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
  onClose(): void;
}) {
  if (!contextMenu) {
    return null;
  }
  const close = (scope: TabCloseScope) => {
    const targets = tabCloseTargets(
      view.mainTabOptions,
      contextMenu.value,
      scope,
      view.session.harnesses.length > 1
    );
    onClose();
    for (const value of targets) {
      actions.closeTab(value);
    }
  };
  const targetExists = view.mainTabOptions.some(
    (option) => option.value === contextMenu.value
  );
  if (!targetExists) {
    return null;
  }

  return (
    <AnchoredOverlay
      anchorId={contextMenu.anchorId}
      backgroundColor={colors.panel}
      borderColor={colors.borderFocus}
      borderStyle="round"
      flexDirection="column"
      onMouseDown={(event) => event.stopPropagation()}
      open
      placement="bottom-start"
      size={{ width: 24, height: 5 }}
    >
      <TabContextMenuRow label="Close Others" onPress={() => close("others")} />
      <TabContextMenuRow
        label="Close to the Left"
        onPress={() => close("left")}
      />
      <TabContextMenuRow
        label="Close to the Right"
        onPress={() => close("right")}
      />
    </AnchoredOverlay>
  );
}

function TabContextMenuRow({
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
