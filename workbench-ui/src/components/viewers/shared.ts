import { createContext } from "react";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchViewModel } from "../types";

// Graphics-protocol images (Kitty/sixel) are painted directly to the terminal
// by the emulator's compositor, so they draw OVER silvery's text cells — including
// any overlay like the splash. While this is true, image/PDF/mermaid previews
// suppress their actual pixels so they don't bleed through the splash.
export const SuppressImagesContext = createContext(false);

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function activeFileTab(view: WorkbenchViewModel): EditorTab | undefined {
  return view.session.openTabs.find(
    (tab) => tab.path === view.session.activeMainTab
  );
}

export function tokenColor(group: string | undefined) {
  switch (group) {
    case "comment":
      return colors.syntaxComment;
    case "string":
      return colors.syntaxString;
    case "number":
    case "boolean":
      return colors.syntaxNumber;
    case "keyword":
      return colors.syntaxKeyword;
    case "type":
      return colors.syntaxType;
    case "property":
      return colors.syntaxProperty;
    default:
      return colors.text;
  }
}
