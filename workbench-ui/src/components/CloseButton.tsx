import { useState } from "react";
import { Box, Text } from "silvery";
import { colors } from "../ui/theme";

export function CloseButton({
  color = colors.text,
  height = 1,
  onClose,
}: {
  color?: string;
  height?: number;
  onClose(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      alignItems="center"
      backgroundColor={hovered ? colors.error : undefined}
      focusable={false}
      height={height}
      justifyContent="center"
      mouseCursor="pointer"
      onClick={(event) => {
        if (event.button !== 0) {
          return;
        }
        onClose();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      width={3}
    >
      <Text bold color={hovered ? colors.onError : color}>
        ×
      </Text>
    </Box>
  );
}
