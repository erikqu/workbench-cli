import { useEffect, useState, useSyncExternalStore } from "react";
import type { TerminalPanel } from "../terminal/terminal-panel";

// Keep rich terminal overlays aligned with a stationary viewport. A wheel
// gesture clears the old placements immediately; repeated gestures extend the
// timer, while unrelated PTY redraws do not.
export function useSettledTerminalBlocks<T>(
  panel: TerminalPanel,
  extract: (lines: readonly string[]) => T[],
  signature: (blocks: readonly T[]) => string
): T[] {
  const revision = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot
  );
  const [blocks, setBlocks] = useState<T[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scanWhenSettled = () => {
      if (cancelled) {
        return;
      }
      const delay = panel.viewportRenderDelay();
      if (delay > 0) {
        timer = setTimeout(scanWhenSettled, delay);
        timer.unref?.();
        return;
      }
      const next = extract(panel.captureViewportText());
      if (cancelled) {
        return;
      }
      setBlocks((current) =>
        signature(current) === signature(next) ? current : next
      );
    };

    const delay = panel.viewportRenderDelay();
    if (delay > 0) {
      setBlocks((current) => (current.length === 0 ? current : []));
      timer = setTimeout(scanWhenSettled, delay);
      timer.unref?.();
    } else {
      scanWhenSettled();
    }

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [revision, panel, extract, signature]);

  return blocks;
}
