import { useContext, useEffect, useState } from "react";
import {
  Box,
  Image as SilveryImage,
  Text,
  useBoxRectDangerously,
} from "silvery";
import {
  prepareSilveryImage,
  type SilveryImagePlacement,
} from "../../media/image";
import {
  buildKittyDelete,
  wrapForMultiplexer,
  writeRawStdout,
} from "../../media/image-protocol";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { SuppressImagesContext } from "./shared";

export function ImageViewer({
  tab,
  rel,
  view,
  actions,
}: {
  tab: EditorTab;
  rel: string;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={
        view.state.focus === "editor" ? colors.borderFocus : colors.border
      }
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      padding={1}
    >
      <Text color={colors.dim}>{rel}</Text>
      <Box
        backgroundColor={colors.panelAlt}
        flexGrow={1}
        minWidth={1}
        overflow="hidden"
      >
        <MeasuredImageContent path={tab.path} />
      </Box>
    </Box>
  );
}

export function MeasuredImageContent({ path }: { path: string }) {
  const rect = useBoxRectDangerously();
  const cols = Math.max(1, Math.floor(rect.width));
  const rows = Math.max(1, Math.floor(rect.height));
  const suppressed = useContext(SuppressImagesContext);
  const [placement, setPlacement] = useState<SilveryImagePlacement | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    prepareSilveryImage(path, cols, rows)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result) {
          setError("Could not decode image");
          setPlacement(null);
          return;
        }
        setError(null);
        setPlacement(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not decode image"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, cols, rows]);

  // Hold off transmitting graphics while suppressed (e.g. under the splash) so
  // the emulator's image compositor doesn't paint over the overlay.
  if (suppressed) {
    return <Text color={colors.dim}> </Text>;
  }
  if (!placement) {
    return <Text color={colors.dim}>{error ?? "Loading image..."}</Text>;
  }
  if (placement.protocol === "halfblock") {
    return <Text wrap={false}>{placement.fallback}</Text>;
  }
  if (placement.protocol === "kitty-tmux") {
    return <KittyTmuxImage placement={placement} />;
  }
  return (
    <SilveryImage
      fallback="[image preview unavailable]"
      height={placement.rows}
      protocol="auto"
      src={placement.src}
      width={placement.cols}
      zIndex={10}
    />
  );
}

// Kitty graphics inside a multiplexer: transmit the image out-of-band (already
// wrapped for tmux passthrough) and draw placeholder cells colored with the
// image id; the terminal composites the real pixels over those cells.
function KittyTmuxImage({
  placement,
}: {
  placement: Extract<SilveryImagePlacement, { protocol: "kitty-tmux" }>;
}) {
  useEffect(() => {
    writeRawStdout(placement.transmit);
    return () => {
      writeRawStdout(wrapForMultiplexer(buildKittyDelete(placement.id)));
    };
  }, [placement.transmit, placement.id]);
  return (
    <Text color={`ansi256(${placement.id})`} wrap={false}>
      {placement.placeholder}
    </Text>
  );
}
