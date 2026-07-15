import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Terminal video playback: ffmpeg decodes the file into a stream of PNG frames
// written to a temp dir (fps-limited + downscaled so terminal redraw can keep
// up), and the player reads those frames through the normal image pipeline.
// Audio is not played — there is no portable way to do it from a TUI.

// Cap playback to this many frames/sec regardless of the source rate; the
// terminal can't usefully repaint faster and this keeps CPU sane.
const PLAYBACK_FPS_CAP = 15;
// Decode frames at this pixel width (height keeps aspect). The image pipeline
// downscales further to the pane, so this is an upper bound on quality, not the
// display size. 480px keeps each PNG small enough to write/read at frame rate.
const FRAME_WIDTH = 480;
const PREVIEW_MIN_WIDTH = 720;
const PREVIEW_MAX_WIDTH = 3072;
const PREVIEW_WIDTH_STEP = 128;
const FALLBACK_CELL_PIXEL_WIDTH = 10;

let ffmpegBin: string | null | undefined;
let ffprobeBin: string | null | undefined;

function ffmpeg(): string | null {
  if (ffmpegBin === undefined) {
    ffmpegBin = Bun.which("ffmpeg");
  }
  return ffmpegBin;
}

function ffprobe(): string | null {
  if (ffprobeBin === undefined) {
    ffprobeBin = Bun.which("ffprobe");
  }
  return ffprobeBin;
}

// Video playback needs ffmpeg to decode frames; ffprobe is optional (it only
// supplies duration/fps for the scrubber).
export function videoAvailable(): boolean {
  return ffmpeg() !== null;
}

export interface VideoMeta {
  durationSec: number;
  // Frames/sec we extract AND play at; reproduces real-time when both match.
  fps: number;
  // Total frames we expect to extract (0 when duration is unknown).
  frameCount: number;
  height: number;
  sourceFps: number;
  width: number;
}

export async function probeVideo(path: string): Promise<VideoMeta | null> {
  const bin = ffprobe();
  // Sensible defaults when ffprobe is missing: play at the cap with an unknown
  // length, and let the player detect the end when ffmpeg stops emitting frames.
  if (!bin) {
    return {
      durationSec: 0,
      fps: PLAYBACK_FPS_CAP,
      sourceFps: PLAYBACK_FPS_CAP,
      width: 0,
      height: 0,
      frameCount: 0,
    };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        bin,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" }
    );
  } catch {
    return null;
  }

  const text = await new Response(
    proc.stdout as ReadableStream<Uint8Array>
  ).text();
  const code = await proc.exited;
  if (code !== 0) {
    return null;
  }

  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(text) as ProbeJson;
  } catch {
    return null;
  }

  const stream = parsed.streams?.find((s) => s.codec_type === "video");
  if (!stream) {
    return null;
  }

  const sourceFps =
    parseFraction(stream.avg_frame_rate) ||
    parseFraction(stream.r_frame_rate) ||
    PLAYBACK_FPS_CAP;
  const fps = Math.max(1, Math.min(PLAYBACK_FPS_CAP, Math.round(sourceFps)));
  const durationSec =
    Number(stream.duration ?? parsed.format?.duration ?? 0) || 0;
  const width = Number(stream.width ?? 0) || 0;
  const height = Number(stream.height ?? 0) || 0;
  const frameCount =
    durationSec > 0 ? Math.max(1, Math.round(durationSec * fps)) : 0;

  return { durationSec, fps, sourceFps, width, height, frameCount };
}

export interface VideoExtraction {
  dir: string;
  fps: number;
  // Absolute path to the (1-based) frame file, whether or not it exists yet.
  framePath(index: number): string;
  // True once ffmpeg has finished writing every frame.
  isDone(): boolean;
  // Kill ffmpeg (if still running) and delete the temp frame directory.
  stop(): void;
  // Total frames expected (0 if unknown — see VideoMeta.frameCount).
  totalFrames: number;
}

export interface VideoExtractionOptions {
  previewWidth?: number;
}

// Match the PDF viewer's native-pixel policy, rounded to coarse steps so a
// one-column pane drag does not restart frame extraction.
export function gifPreviewWidth(
  maxCols: number,
  cellPixelWidth = FALLBACK_CELL_PIXEL_WIDTH
): number {
  const measured =
    Math.max(1, Math.floor(maxCols)) * Math.max(1, cellPixelWidth);
  const quantized =
    Math.ceil(measured / PREVIEW_WIDTH_STEP) * PREVIEW_WIDTH_STEP;
  return Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, quantized));
}

export function frameExtractionFilter(
  fps: number,
  previewWidth?: number
): string {
  if (previewWidth === undefined) {
    return `fps=${fps},scale=${FRAME_WIDTH}:-2:flags=fast_bilinear`;
  }
  const width = Math.min(
    PREVIEW_MAX_WIDTH,
    Math.max(PREVIEW_MIN_WIDTH, Math.round(previewWidth))
  );
  return `fps=${fps},scale=w='min(iw,${width})':h='min(ih,${PREVIEW_MAX_WIDTH})':force_original_aspect_ratio=decrease:flags=lanczos`;
}

// Start decoding `path` into PNG frames. Returns immediately; frames appear in
// `dir` sequentially as ffmpeg writes them, so the player can begin as soon as
// the first frame lands instead of waiting for the whole file.
export function startVideoExtraction(
  path: string,
  meta: VideoMeta | null,
  options: VideoExtractionOptions = {}
): VideoExtraction {
  const bin = ffmpeg();
  if (!bin) {
    throw new Error("ffmpeg is required for video playback");
  }

  const dir = mkdtempSync(join(tmpdir(), "workbench-ui-video-"));
  const fps = meta?.fps ?? PLAYBACK_FPS_CAP;
  const pattern = join(dir, "f%06d.png");

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let done = false;
  try {
    proc = Bun.spawn(
      [
        bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path,
        "-vf",
        frameExtractionFilter(fps, options.previewWidth),
        "-an",
        pattern,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    proc.exited.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      }
    );
  } catch {
    done = true;
  }

  return {
    dir,
    fps,
    totalFrames: meta?.frameCount ?? 0,
    framePath: (index: number) =>
      join(dir, `f${String(index).padStart(6, "0")}.png`),
    isDone: () => done,
    stop: () => {
      try {
        proc?.kill();
      } catch {
        // Ignore races if ffmpeg already exited.
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; temp dirs are reaped by the OS otherwise.
      }
    },
  };
}

interface ProbeJson {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    width?: number;
    height?: number;
  }>;
}

// ffprobe reports frame rates as fractions like "30000/1001"; turn that into a
// number, tolerating "0/0" and plain integers.
function parseFraction(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!(Number.isFinite(n) && Number.isFinite(d)) || d === 0) {
    return 0;
  }
  return n / d;
}
