// Scroll-position geometry for harness/terminal panes.
//
// Panes never own their own scroll offset: an alternate-screen CLI that grabs
// the mouse scrolls itself, tmux copy-mode scrolls persistent panes, and Codex's
// transcript pager only publishes a percentage. These helpers normalize whatever
// a pane can report into a thumb the renderer can draw, and stay pure so the
// arithmetic is unit-testable without a PTY.

export interface PaneScrollPosition {
  // True when the offset came from a coarse source (Codex's footer percentage)
  // rather than an exact row count.
  approximate: boolean;
  // Rows scrolled down from the top of the available history.
  offsetRows: number;
  // Total rows of history above the live viewport.
  scrollableRows: number;
  source: "transcript" | "tmux" | "xterm";
}

export interface ScrollThumb {
  approximate: boolean;
  height: number;
  top: number;
  trackHeight: number;
}

// Codex's transcript footer renders the position as a percentage, e.g.
// "──────── 100% ─", " 94% ", or a bare "83%". Conversation text above the
// footer can contain its own percentage, so the LAST match wins: the footer is
// always the bottom-most percentage in the viewport.
const PERCENT_PATTERN = /(?:^|\s)(\d{1,3})%(?:\s|$)/g;

export function parseTranscriptPercent(
  rows: readonly string[]
): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    const matches = [...row.matchAll(PERCENT_PATTERN)];
    const last = matches.at(-1);
    if (!last?.[1]) {
      continue;
    }
    const percent = Number(last[1]);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      return percent;
    }
  }
  return;
}

// Silvery's Scrollbar geometry, so a pane thumb matches the viewers' bars:
// thumbHeight = trackHeight^2 / (scrollableRows + trackHeight). Returns
// undefined whenever there is nothing meaningful to draw — content fits, the
// viewport is pinned to the bottom, or the thumb would fill the whole track
// (silvery hides its own bar in that case too).
export function scrollThumb(
  trackHeight: number,
  position: PaneScrollPosition | undefined
): ScrollThumb | undefined {
  if (!position) {
    return;
  }
  const track = Math.floor(trackHeight);
  const scrollableRows = Math.floor(position.scrollableRows);
  if (track <= 0 || scrollableRows <= 0) {
    return;
  }
  const offsetRows = Math.min(
    scrollableRows,
    Math.max(0, Math.floor(position.offsetRows))
  );
  // At the live edge there is no scrollback to indicate.
  if (offsetRows >= scrollableRows) {
    return;
  }
  const height = Math.max(
    1,
    Math.floor((track * track) / (scrollableRows + track))
  );
  if (height >= track) {
    return;
  }
  const top = Math.round((offsetRows / scrollableRows) * (track - height));
  return {
    approximate: position.approximate,
    height,
    top: Math.min(track - height, Math.max(0, top)),
    trackHeight: track,
  };
}

// Thumb equality for change detection. Comparing the quantized thumb rather
// than the raw offset means sub-row scrolling never triggers a repaint.
export function sameScrollThumb(
  a: ScrollThumb | undefined,
  b: ScrollThumb | undefined
): boolean {
  if (!(a || b)) {
    return true;
  }
  if (!(a && b)) {
    return false;
  }
  return (
    a.top === b.top &&
    a.height === b.height &&
    a.trackHeight === b.trackHeight &&
    a.approximate === b.approximate
  );
}
