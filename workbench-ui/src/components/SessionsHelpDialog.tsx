import { Box, ModalDialog, Text, useWindowSize } from "silvery";
import { colors } from "../ui/theme";

const NAVIGATION_SHORTCUTS = [
  ["⌥⇧1-9", "Select session"],
  ["⌥1-9", "Select tab"],
  ["⌥Space", "Next session"],
  ["Up/Down", "Move session"],
  ["Enter", "Open selected"],
  ["Ctrl+B", "Sessions pane"],
  ["Wheel", "Scroll pane"],
  ["Right click", "Close options"],
] as const;

const ACTION_SHORTCUTS = [
  ["Ctrl+?", "Help"],
  ["Ctrl+N", "New workspace"],
  ["Ctrl+H", "New harness"],
  ["Ctrl+T", "New terminal"],
  ["⌥W", "Close tab"],
  ["Ctrl+S", "Save file"],
  ["⌥Tab", "Cycle theme"],
  ["Ctrl+Q", "Quit"],
] as const;

export function SessionsHelpDialog({ onClose }: { onClose(): void }) {
  const { columns } = useWindowSize();
  return (
    <Box
      alignItems="center"
      height="100%"
      justifyContent="center"
      left={0}
      onMouseDown={onClose}
      position="absolute"
      top={0}
      width="100%"
    >
      <Box onMouseDown={(event) => event.stopPropagation()}>
        <ModalDialog
          borderColor={colors.borderFocus}
          footer="Ctrl+? or Esc close"
          onClose={onClose}
          title="Workbench help"
          titleColor={colors.accentAlt}
          width={Math.max(44, Math.min(64, columns - 4))}
        >
          <Box flexDirection="row" gap={2}>
            <ShortcutColumn rows={NAVIGATION_SHORTCUTS} title="Navigation" />
            <ShortcutColumn rows={ACTION_SHORTCUTS} title="Actions" />
          </Box>
        </ModalDialog>
      </Box>
    </Box>
  );
}

function ShortcutColumn({
  rows,
  title,
}: {
  rows: ReadonlyArray<readonly [string, string]>;
  title: string;
}) {
  return (
    <Box flexBasis={0} flexDirection="column" flexGrow={1} minWidth={1}>
      <Text bold color={colors.text}>
        {title}
      </Text>
      {rows.map(([keys, label]) => (
        <Box flexDirection="row" height={1} key={keys} minWidth={1}>
          <Box flexShrink={0} width={12}>
            <Text color={colors.accentAlt} wrap={false}>
              {keys}
            </Text>
          </Box>
          <Text color={colors.dim} flexShrink={1} minWidth={1} wrap={false}>
            {label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
