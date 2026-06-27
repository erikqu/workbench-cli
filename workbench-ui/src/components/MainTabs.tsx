import { useState } from "react";
import { Box, Button, Text } from "silvery";
import { harnessIdFromTab } from "../state/types";
import { colors } from "../ui/theme";
import type {
  TabSelectOption,
  WorkbenchActions,
  WorkbenchViewModel,
} from "./types";

export function MainTabs({
  view,
  actions,
}: {
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  return (
    <Box backgroundColor={colors.editor} flexDirection="row" height={2}>
      {view.mainTabOptions.map((option, index) => (
        <Tab
          actions={actions}
          active={option.value === view.session.activeMainTab}
          canCloseHarness={view.session.harnesses.length > 1}
          index={index}
          key={String(option.value)}
          option={option}
        />
      ))}
    </Box>
  );
}

function Tab({
  option,
  index,
  active,
  canCloseHarness,
  actions,
}: {
  option: TabSelectOption;
  index: number;
  active: boolean;
  canCloseHarness: boolean;
  actions: WorkbenchActions;
}) {
  const [hovered, setHovered] = useState(false);
  const value = option.value;
  const closable = harnessIdFromTab(value) ? canCloseHarness : true;
  const select = (event: { stopPropagation(): void }) => {
    actions.selectMainTab(option);
    event.stopPropagation();
  };
  const close = (event: { stopPropagation(): void }) => {
    actions.closeTab(value);
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
  // Keep inactive tabs compact: the close affordance only appears on the
  // active or hovered tab (a common, tidy webpage pattern that also avoids
  // overflowing the strip when many tabs are open).
  const showClose = closable && (active || hovered);
  // The first 9 tabs get a dim index badge matching their Option+N shortcut.
  const hint = index < 9 ? String(index + 1) : undefined;

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={2}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Box
        alignItems="center"
        backgroundColor={rowBg}
        flexDirection="row"
        height={1}
        onClick={select}
        paddingLeft={1}
        paddingRight={showClose ? 0 : 1}
      >
        {hint ? (
          <Text color={active ? colors.accent : colors.dim}>{`${hint} `}</Text>
        ) : null}
        <Text color={labelColor}>{option.name}</Text>
        {showClose ? (
          <Button
            color={colors.text}
            focusable={false}
            label="x"
            onClick={close}
            onPress={() => actions.closeTab(value)}
          />
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
