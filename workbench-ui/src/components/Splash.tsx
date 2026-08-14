import { useEffect, useState } from "react";
import { Box, Text, useWindowSize } from "silvery";
import {
  buildBinarySplashArt,
  SPLASH_MAX_COLS,
  SPLASH_VERSION,
} from "../media/splash";
import { colors } from "../ui/theme";
import type { WorkbenchActions } from "./types";

// Rows reserved below the art for the version/hint banner.
const BANNER_ROWS = 4;

// How long the splash lingers before it dismisses itself.
const SPLASH_DURATION_MS = 2000;
export function Splash({ actions }: { actions: WorkbenchActions }) {
  // Auto-dismiss after a short delay; a key/click still dismisses it early.
  useEffect(() => {
    // Read this inside the effect: --splash is parsed by index.ts after static
    // imports have evaluated, but before React mounts the component.
    if (
      Bun.env.WORKBENCH_UI_SPLASH_PREVIEW === "1" ||
      Bun.env.WORKBENCH_CAPTURE_SPLASH === "1"
    ) {
      return;
    }
    const timer = setTimeout(() => actions.dismissSplash(), SPLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [actions]);

  return (
    <Box
      alignItems="center"
      backgroundColor={colors.bg}
      flexDirection="column"
      height="100%"
      justifyContent="center"
      left={0}
      onMouseDown={(event) => {
        actions.dismissSplash();
        event.stopPropagation();
      }}
      position="absolute"
      top={0}
      width="100%"
    >
      <SplashArtwork />
      <Box height={1} />
      <Text
        bold
        color={colors.accentAlt}
      >{`Workbench  v${SPLASH_VERSION}`}</Text>
      <Text color={colors.dim}>Starting up...</Text>
    </Box>
  );
}

function SplashArtwork() {
  // The artwork used to measure its own empty, shrink-wrapped Box. Silvery's
  // first measurement is necessarily 0x0, which made that Box settle at 1x1
  // and left the real image effectively invisible. The splash owns the full
  // viewport, so size the source image directly against the terminal window.
  const windowSize = useWindowSize();
  const availCols = Math.max(
    1,
    Math.min(SPLASH_MAX_COLS, Math.floor(windowSize.columns) - 4)
  );
  const availRows = Math.max(1, Math.floor(windowSize.rows) - BANNER_ROWS - 2);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    buildBinarySplashArt(availCols, availRows).then((art) => {
      if (!cancelled) {
        setLines(art);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [availCols, availRows]);

  return (
    <Box alignItems="center" flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Text key={index} wrap={false}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
