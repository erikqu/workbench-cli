import { useEffect, useState } from "react";
import { Box, Text, useBoxRectDangerously } from "silvery";
import {
  buildSplashArt,
  SPLASH_VERSION,
  type SplashArt,
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
  const availCols = Math.max(1, Math.floor(rect.width) - 4);
  const availRows = Math.max(1, Math.floor(rect.height) - BANNER_ROWS - 2);
  const [art, setArt] = useState<SplashArt | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildSplashArt(availCols, availRows)
      .then((result) => {
        if (!cancelled) {
          setArt(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setArt(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [availCols, availRows]);

  if (!art) {
    return <Text color={colors.dim}>Loading...</Text>;
  }

  return (
    <Box alignItems="center" flexDirection="column" flexShrink={0}>
      {art.rows.map((row, y) => (
        <Box flexDirection="row" flexShrink={0} height={1} key={y}>
          {row.map((run, x) => (
            <Text bold={run.bold} color={run.color} key={x} wrap={false}>
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
