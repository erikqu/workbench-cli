import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AgentSession, EditorTab, EditorTabKind } from "../state/types";

const maxPreviewBytes = 64 * 1024;

const imageExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".pjpeg",
  ".pjp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".ico",
  ".svg",
]);
const markdownExtensions = new Set([".md", ".markdown", ".mdx"]);
const pdfExtensions = new Set([".pdf"]);
const videoExtensions = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".gifv",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
]);

export function editorTabKind(path: string): EditorTabKind {
  const ext = extname(path).toLowerCase();
  if (imageExtensions.has(ext)) {
    return "image";
  }
  if (videoExtensions.has(ext)) {
    return "video";
  }
  if (pdfExtensions.has(ext)) {
    return "pdf";
  }
  if (markdownExtensions.has(ext)) {
    return "markdown";
  }
  return "text";
}

export function openEditorTab(path: string): EditorTab | undefined {
  const kind = editorTabKind(path);

  // Images, PDFs, and videos are decoded lazily by the viewer; only confirm
  // the file exists and is readable here.
  if (kind === "image" || kind === "pdf" || kind === "video") {
    try {
      statSync(path);
      return {
        path,
        name: basename(path),
        content: "",
        kind,
        dirty: false,
        binary: true,
        truncated: false,
      };
    } catch (error) {
      return readError(path, error);
    }
  }

  try {
    const bytes = readFileSync(path);
    const sample = bytes.subarray(0, Math.min(bytes.length, maxPreviewBytes));
    const binary = sample.includes(0);
    return {
      path,
      name: basename(path),
      content: binary ? "(binary file)" : sample.toString("utf8"),
      kind: binary ? "text" : kind,
      dirty: false,
      binary,
      truncated: bytes.length > sample.length,
    };
  } catch (error) {
    return readError(path, error);
  }
}

function readError(path: string, error: unknown): EditorTab {
  return {
    path,
    name: basename(path),
    content: `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
    kind: "text",
    dirty: false,
    binary: false,
    truncated: false,
  };
}

export function openTab(session: AgentSession, path: string) {
  const existing = session.openTabs.find((tab) => tab.path === path);
  if (existing) {
    session.activeTabPath = existing.path;
    return;
  }

  const tab = openEditorTab(path);
  if (!tab) {
    return;
  }
  session.openTabs.push(tab);
  session.activeTabPath = tab.path;
}

export function closeActiveTab(session: AgentSession) {
  if (!session.activeTabPath) {
    return;
  }
  const index = session.openTabs.findIndex(
    (tab) => tab.path === session.activeTabPath
  );
  if (index === -1) {
    return;
  }
  session.openTabs.splice(index, 1);
  session.activeTabPath = session.openTabs[Math.max(0, index - 1)]?.path;
}

export function activeTab(session: AgentSession) {
  return session.openTabs.find((tab) => tab.path === session.activeTabPath);
}
