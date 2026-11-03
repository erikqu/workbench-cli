import { unwatchFile, watchFile } from "node:fs";
import { extname } from "node:path";
import { useEffect, useState } from "react";
import { Box, Button, Text, useBoxRectDangerously, useInput } from "silvery";
import { forgetImage } from "../../media/image";
import {
  DEFAULT_MODEL_CAMERA,
  type ModelCamera,
  modelPreviewSize,
  normalizeModelCamera,
  prepareModelPreview,
} from "../../media/model";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { MeasuredImageContent } from "./ImageViewer";

export function ModelViewer({
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
  const focused = view.state.focus === "editor";
  const isBlend = extname(tab.path).toLowerCase() === ".blend";
  const [camera, setCamera] = useState<ModelCamera>(DEFAULT_MODEL_CAMERA);
  const [revision, setRevision] = useState(0);
  const [refresh, setRefresh] = useState("");
  const change = (patch: Partial<ModelCamera>) => {
    setCamera((current) => normalizeModelCamera({ ...current, ...patch }));
  };
  const orbit = (azimuth: number, elevation: number) => {
    setCamera((current) =>
      normalizeModelCamera({
        ...current,
        source: "orbit",
        azimuth: current.azimuth + azimuth,
        elevation: current.elevation + elevation,
      })
    );
  };
  const zoom = (factor: number) => {
    setCamera((current) =>
      normalizeModelCamera({
        ...current,
        source: "orbit",
        zoom: current.zoom * factor,
      })
    );
  };
  const reset = () => {
    setCamera(DEFAULT_MODEL_CAMERA);
  };
  const reload = () => {
    setRefresh(crypto.randomUUID());
  };

  // Only the active model tab watches its source. Edits produce a fresh cache
  // key, while ordinary Workbench/agent repaints never restart the renderer.
  useEffect(() => {
    const changed = () => {
      setRevision((value) => value + 1);
    };
    watchFile(tab.path, { interval: 1000, persistent: false }, changed);
    return () => {
      unwatchFile(tab.path, changed);
    };
  }, [tab.path]);

  useInput((input, key) => {
    if (!focused || key.ctrl || key.meta || key.super) {
      return;
    }
    if (key.leftArrow) {
      orbit(-15, 0);
    } else if (key.rightArrow) {
      orbit(15, 0);
    } else if (key.upArrow) {
      orbit(0, 10);
    } else if (key.downArrow) {
      orbit(0, -10);
    } else if (input === "+" || input === "=") {
      zoom(1.2);
    } else if (input === "-") {
      zoom(1 / 1.2);
    } else if (input === "r") {
      reset();
    } else if (input === "f") {
      reload();
    } else if (input === "c" && isBlend) {
      change({ source: camera.source === "scene" ? "orbit" : "scene" });
    }
  });

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minHeight={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      onWheel={(event) => {
        zoom(1.1 ** Math.max(-8, Math.min(8, -event.deltaY)));
        event.preventDefault();
        event.stopPropagation();
      }}
      padding={1}
    >
      <Text color={colors.dim} wrap={false}>
        {rel}
      </Text>
      <Box flexDirection="row" flexShrink={0} height={1}>
        <ModelButton
          active={camera.source === "orbit"}
          label="Orbit"
          onPress={() => change({ source: "orbit" })}
        />
        {isBlend ? (
          <ModelButton
            active={camera.source === "scene"}
            label="Scene camera"
            onPress={() => change({ source: "scene" })}
          />
        ) : null}
        <ModelButton label="-" onPress={() => zoom(1 / 1.2)} />
        <ModelButton label="+" onPress={() => zoom(1.2)} />
        <ModelButton label="Reset" onPress={reset} />
        <ModelButton label="Refresh" onPress={reload} />
      </Box>
      <Box
        backgroundColor={colors.panelAlt}
        flexGrow={1}
        minHeight={1}
        minWidth={1}
        overflow="hidden"
      >
        <ModelPreviewContent
          camera={camera}
          path={tab.path}
          refresh={refresh}
          revision={revision}
        />
      </Box>
      <Text color={colors.dim} wrap={false}>
        Arrows orbit/tilt Wheel +/- zoom R reset F refresh
      </Text>
    </Box>
  );
}

function ModelButton({
  label,
  active = false,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress(): void;
}) {
  return (
    <Box backgroundColor={active ? colors.selected : undefined} paddingX={1}>
      <Button
        color={active ? colors.onSelected : colors.accentAlt}
        focusable={false}
        label={label}
        onClick={(event) => {
          if (event.button === 0) {
            onPress();
            event.stopPropagation();
          }
        }}
        onPress={onPress}
      />
    </Box>
  );
}

function ModelPreviewContent({
  path,
  camera,
  revision,
  refresh,
}: {
  path: string;
  camera: ModelCamera;
  revision: number;
  refresh: string;
}) {
  const rect = useBoxRectDangerously();
  const { width, height } = modelPreviewSize(rect.width, rect.height - 1);
  const [preview, setPreview] = useState<{ imagePath: string } | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRendering(true);
    setError(null);
    prepareModelPreview(
      path,
      camera,
      { width, height },
      controller.signal,
      refresh
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setPreview(result);
          setRendering(false);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Could not render 3D preview."
          );
          setRendering(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [path, camera, width, height, revision, refresh]);

  useEffect(
    () => () => {
      if (preview) {
        forgetImage(preview.imagePath);
      }
    },
    [preview]
  );

  if (error) {
    return <Text color={colors.accentAlt}>{error}</Text>;
  }
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={1} minWidth={1}>
      <Text color={colors.dim} wrap={false}>
        {rendering ? "Rendering 3D preview..." : "3D preview"}
      </Text>
      {preview ? (
        <Box flexGrow={1} minHeight={1} minWidth={1}>
          <MeasuredImageContent
            key={preview.imagePath}
            path={preview.imagePath}
          />
        </Box>
      ) : null}
    </Box>
  );
}
