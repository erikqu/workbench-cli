import { useSyncExternalStore } from "react";
import { Box, Text } from "silvery";
import type { TerminalPanel } from "../terminal/terminal-panel";
import { colors } from "../ui/theme";

// A scroll thumb painted over the pane's right-hand border column.
//
// Placement is deliberate: `right={-1}` overflows the frame's padding box onto
// the border itself. `right={0}` would land on the LAST PTY COLUMN, covering a
// real terminal cell and breaking the regression suite's frame comparisons.
// Being absolutely positioned keeps it out of the flex tree, so the measured
// rect that drives the PTY's cols/rows is untouched — a normal flex sibling
// would shrink every harness by a column and force a SIGWINCH reflow.
//
// Display-only by design. `pointerEvents="none"` removes it from pointer
// hit-testing and `userSelect="none"` removes it from selection hit-testing
// (which deliberately ignores pointerEvents), so the embedded terminal remains
// the sole owner of wheel and selection events. This is why silvery's own
// <Scrollbar> is not used here: it mounts a mouseCapture region that stays
// mounted even when its thumb is hidden.
export function PaneScrollIndicator({
  panel,
  top,
}: {
  panel: TerminalPanel;
  // Rows of pane chrome above the terminal grid (the frame's own border plus
  // the pane header), so the track lines up with the rows actually on screen.
  top: number;
}) {
  const revision = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot
  );
  // `revision` is read only to re-run this subscriber; the panel is the source
  // of truth for the geometry.
  void revision;
  const thumb = panel.scrollIndicator();
  if (!thumb) {
    return null;
  }
  const rows = Array.from({ length: thumb.height }, (_, index) => index);

  return (
    <Box
      bottom={0}
      flexDirection="column"
      pointerEvents="none"
      position="absolute"
      right={-1}
      top={top}
      userSelect="none"
      width={1}
    >
      {thumb.top > 0 ? <Box flexShrink={0} height={thumb.top} /> : null}
      <Box flexDirection="column" flexShrink={0} width={1}>
        {rows.map((row) => (
          <Text
            color={thumb.active ? colors.accent : colors.dim}
            key={thumb.top + row}
          >
            █
          </Text>
        ))}
      </Box>
    </Box>
  );
}
