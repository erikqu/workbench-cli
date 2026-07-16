import { useState } from "react";
import { Box, Text } from "silvery";
import { colors } from "../ui/theme";

export function CloseButton({ onClose }: { onClose(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      alignItems="center"
      backgroundColor={hovered ? colors.error : undefined}
      focusable={false}
      height={1}
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
      <Text bold color={hovered ? colors.onError : colors.text}>
        ×
      </Text>
    </Box>
  );
}
