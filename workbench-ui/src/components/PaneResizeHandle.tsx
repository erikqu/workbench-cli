import { useRef, useState } from "react";
import { Box, useMouseCursor } from "silvery";
import { clampPaneWidth } from "../ui/pane-layout";
import { colors } from "../ui/theme";

export function PaneResizeHandle({
  width,
  minWidth,
  maxWidth,
  onResize,
  onDragStart,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize(width: number): void;
  onDragStart?(): void;
}) {
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  useMouseCursor(hovered || dragging ? "move" : null);

  const resizeFromPointer = (x: number) => {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    onResize(clampPaneWidth(start.width + x - start.x, minWidth, maxWidth));
  };

  return (
    <Box
      borderBottom={false}
      borderColor={hovered || dragging ? colors.borderFocus : colors.border}
      borderRight={false}
      borderStyle="single"
      borderTop={false}
      bottom={1}
      mouseCapture
      onMouseDown={(event) => {
        dragStart.current = { x: event.x, width };
        setDragging(true);
        onDragStart?.();
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={(event) => {
        if (!dragStart.current) {
          return;
        }
        resizeFromPointer(event.x);
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseUp={(event) => {
        resizeFromPointer(event.x);
        dragStart.current = null;
        setDragging(false);
        event.preventDefault();
        event.stopPropagation();
      }}
      position="absolute"
      right={0}
      top={1}
      userSelect="none"
      width={1}
    />
  );
}
