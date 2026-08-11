import { useEffect } from "react";
import { Box, Text, useBoxRectDangerously } from "silvery";
import {
  SPLASH_IMAGE_PATH,
  SPLASH_MAX_COLS,
  SPLASH_VERSION,
} from "../media/splash";
import { colors } from "../ui/theme";
import type { WorkbenchActions } from "./types";
import { MeasuredImageContent } from "./viewers/ImageViewer";

// Rows reserved below the art for the version/hint banner.
const BANNER_ROWS = 4;

// How long the splash lingers before it dismisses itself.
const SPLASH_DURATION_MS =
  Bun.env.WORKBENCH_CAPTURE_SPLASH === "1" ? 10_000 : 2000;

export function Splash({ actions }: { actions: WorkbenchActions }) {
  // Auto-dismiss after a short delay; a key/click still dismisses it early.
  useEffect(() => {
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
  const rect = useBoxRectDangerously();
  const availCols = Math.max(
    1,
    Math.min(SPLASH_MAX_COLS, Math.floor(rect.width) - 4)
  );
  const availRows = Math.max(1, Math.floor(rect.height) - BANNER_ROWS - 2);

  return (
    <Box
      alignItems="center"
      flexShrink={0}
      height={availRows}
      justifyContent="center"
      width={availCols}
    >
      <MeasuredImageContent
        path={SPLASH_IMAGE_PATH}
        renderWhenSuppressed
        zIndex={100}
      />
    </Box>
  );
}
