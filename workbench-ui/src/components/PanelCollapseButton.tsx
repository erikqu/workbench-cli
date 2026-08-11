import { useState } from "react";
import { Box, Text } from "silvery";
import { colors } from "../ui/theme";

export function PanelCollapseButton({
  label = "<",
  onCollapse,
}: {
  label?: "<" | ">";
  onCollapse(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      alignItems="center"
      backgroundColor={hovered ? colors.selectedMuted : undefined}
      focusable={false}
      height={1}
      justifyContent="center"
      mouseCursor="pointer"
      onClick={(event) => {
        if (event.button !== 0) {
          return;
        }
        onCollapse();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      width={3}
    >
      <Text bold={hovered} color={hovered ? colors.accent : colors.accentAlt}>
        {label}
      </Text>
    </Box>
  );
}
