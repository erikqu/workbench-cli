import { existsSync } from "node:fs";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "silvery";
import { forgetImage } from "../../media/image";
import {
  probeVideo,
  startVideoExtraction,
  type VideoExtraction,
  type VideoMeta,
  videoAvailable,
} from "../../media/video";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { MeasuredImageContent } from "./ImageViewer";

export function VideoViewer({
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
  const extractionRef = useRef<VideoExtraction | null>(null);
  const metaRef = useRef<VideoMeta | null>(null);
  const prevFrameRef = useRef(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [ended, setEnded] = useState(false);
  const [frame, setFrame] = useState(1);

  // Probe + start frame extraction once per file. Frames stream into a temp dir
  // as ffmpeg writes them; the playback effect picks them up as they land.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    setPlaying(true);
    setEnded(false);
    setFrame(1);
    prevFrameRef.current = 0;

    if (!videoAvailable()) {
      setStatus("error");
      setError("Install ffmpeg to play videos (and ffprobe for the scrubber).");
      return;
    }

    probeVideo(tab.path)
      .then((meta) => {
        if (cancelled) {
          return;
        }
        metaRef.current = meta;
        extractionRef.current = startVideoExtraction(tab.path, meta);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Could not start video playback"
        );
      });

    return () => {
      cancelled = true;
      extractionRef.current?.stop();
      extractionRef.current = null;
    };
  }, [tab.path]);

  // Advance frames at the (capped) source rate. Only steps to frames ffmpeg has
  // already written; if extraction is lagging it holds, and when ffmpeg finishes
  // with no further frame the clip is marked ended.
  useEffect(() => {
    if (status !== "ready" || !playing) {
      return;
    }
    const ext = extractionRef.current;
    if (!ext) {
      return;
    }
    const interval = Math.max(1000 / ext.fps, 33);
    const id = setInterval(() => {
      setFrame((current) => {
        if (ext.totalFrames && current >= ext.totalFrames) {
          setPlaying(false);
          setEnded(true);
          return current;
        }
        const next = current + 1;
        if (existsSync(ext.framePath(next))) {
          return next;
        }
        if (ext.isDone()) {
          setPlaying(false);
          setEnded(true);
          return current;
        }
        return current;
      });
    }, interval);
    return () => clearInterval(id);
  }, [status, playing]);

  // Evict the just-departed frame from the image caches so playback doesn't leak
  // memory across thousands of unique frame paths.
  useEffect(() => {
    const ext = extractionRef.current;
    if (!ext) {
      return;
    }
    const prev = prevFrameRef.current;
    if (prev && prev !== frame) {
      forgetImage(ext.framePath(prev));
    }
    prevFrameRef.current = frame;
  }, [frame]);

  useInput((input, key) => {
    if (!focused) {
      return;
    }
    const ext = extractionRef.current;
    if (input === " ") {
      if (ended) {
        setFrame(1);
        setEnded(false);
        setPlaying(true);
      } else {
        setPlaying((value) => !value);
      }
      return;
    }
    if (!ext) {
      return;
    }
    const step = Math.max(1, Math.round(ext.fps * 5));
    if (key.leftArrow) {
      setEnded(false);
      setFrame((current) => Math.max(1, current - step));
    } else if (key.rightArrow) {
      setEnded(false);
      setFrame((current) => lastExistingAtOrBelow(ext, current + step));
    } else if (key.home) {
      setEnded(false);
      setFrame(1);
    }
  });

  const meta = metaRef.current;
  const ext = extractionRef.current;
  const framePath = ext ? ext.framePath(frame) : null;
  const haveFrame = !!framePath && existsSync(framePath);
  const elapsed = meta ? frame / meta.fps : 0;
  const stateLabel =
    status === "ready" ? (ended ? "END" : playing ? "PLAY" : "PAUSE") : "";
  const clock =
    meta && meta.durationSec > 0
      ? `${formatClock(elapsed)} / ${formatClock(meta.durationSec)}`
      : formatClock(elapsed);

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        // First click just focuses the pane; once focused, a click toggles
        // play/pause (ignored after the clip has ended — use Space to replay).
        if (focused && !ended) {
          setPlaying((value) => !value);
        }
        actions.focus("editor");
        event.stopPropagation();
      }}
      padding={1}
    >
      <Box
        flexDirection="row"
        flexShrink={0}
        height={1}
        justifyContent="space-between"
      >
        <Text color={colors.dim}>{rel}</Text>
        <Text color={colors.dim}>
          {status === "ready"
            ? `${clock}  ${stateLabel}  Space play/pause  </> 5s  Home restart`
            : ""}
        </Text>
      </Box>
      <Box
        backgroundColor={colors.panelAlt}
        flexGrow={1}
        minWidth={1}
        overflow="hidden"
      >
        {status === "error" ? (
          <Text color={colors.accentAlt}>
            {error ?? "Could not play video"}
          </Text>
        ) : status === "loading" ? (
          <Text color={colors.dim}>Loading video...</Text>
        ) : haveFrame && framePath ? (
          <MeasuredImageContent path={framePath} />
        ) : (
          <Text color={colors.dim}>Buffering video...</Text>
        )}
      </Box>
    </Box>
  );
}

// Walk back from `target` to the highest frame index that has been extracted so
// a forward seek never points the renderer at a frame ffmpeg hasn't written yet.
function lastExistingAtOrBelow(ext: VideoExtraction, target: number): number {
  let i = Math.max(1, target);
  while (i > 1 && !existsSync(ext.framePath(i))) {
    i--;
  }
  return i;
}

function formatClock(totalSeconds: number): string {
  const safe =
    Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
