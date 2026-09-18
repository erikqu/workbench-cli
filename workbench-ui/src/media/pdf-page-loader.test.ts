import { describe, expect, test } from "bun:test";
import type { PdfPreview } from "./pdf";
import { PdfPageLoader, pdfPrefetchPages } from "./pdf-page-loader";

const preview = (page: number, pageCount = 100): PdfPreview => ({
  page,
  pageCount,
  imagePath: `/cached/${page}.png`,
});
const range = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => start + i);

async function settle() {
  await Bun.sleep(40);
}

describe("PDF tranche loading", () => {
  test("publishes the visible page before beginning background preparation", async () => {
    const events: string[] = [];
    const loader = new PdfPageLoader(async (page) => {
      events.push(`prepare ${page}`);
      return preview(page, 10);
    });
    try {
      await loader.load(1);
      events.push("display 1");
      expect(events).toEqual(["prepare 1", "display 1"]);
    } finally {
      loader.dispose();
    }
  });

  test("yields to input between background pages with cached rasters", async () => {
    const events: string[] = [];
    let input: ReturnType<typeof setTimeout> | undefined;
    const loader = new PdfPageLoader(async (page) => {
      events.push(`prepare ${page}`);
      if (page === 2) {
        input = setTimeout(() => events.push("input"), 0);
      }
      return preview(page, 10);
    });
    try {
      await loader.load(1);
      await Bun.sleep(100);
      expect(events.indexOf("input")).toBeLessThan(events.indexOf("prepare 3"));
    } finally {
      clearTimeout(input);
      loader.dispose();
    }
  });

  test("foreground jumps do not wait for obsolete decoders", async () => {
    let finishOld: (() => void) | undefined;
    const started: number[] = [];
    const loader = new PdfPageLoader(async (page) => {
      started.push(page);
      if (page === 2) {
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
      }
      return preview(page, 3);
    });
    await loader.load(1);
    await Bun.sleep(20);
    let displayed: number | undefined;
    const jump = loader.load(3).then((result) => {
      displayed = result.page;
    });
    try {
      await Bun.sleep(20);
      expect(started).toContain(3);
      expect(displayed).toBe(3);
    } finally {
      finishOld?.();
      await jump;
      loader.dispose();
    }
  });

  test("warms ten pages and starts the next tranche at page four", async () => {
    const rendered = new Set<number>();
    const loader = new PdfPageLoader(async (page) => {
      rendered.add(page);
      return preview(page);
    });
    try {
      await loader.load(1);
      await settle();
      expect([...rendered].sort((a, b) => a - b)).toEqual(range(1, 10));
      await loader.load(3);
      await settle();
      expect(rendered.size).toBe(10);
      await loader.load(4);
      await settle();
      expect([...rendered].sort((a, b) => a - b)).toEqual(range(1, 20));
      await loader.load(13);
      await settle();
      expect(rendered.size).toBe(20);
      await loader.load(14);
      await settle();
      expect([...rendered].sort((a, b) => a - b)).toEqual(range(1, 30));
    } finally {
      loader.dispose();
    }
  });

  test("ready page turns reuse the prepared display without waiting for background work", async () => {
    const calls: number[] = [];
    let release: (() => void) | undefined;
    let backgroundSignal: AbortSignal | undefined;
    const loader = new PdfPageLoader(async (page, signal) => {
      calls.push(page);
      if (page === 3) {
        backgroundSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {
        ...preview(page, 3),
        placement: { text: `prepared page ${page}` },
      };
    });
    try {
      await loader.load(1);
      await settle();
      expect(calls).toEqual([1, 2, 3]);
      const ready = loader.peek(2);
      expect(ready?.placement.text).toBe("prepared page 2");
      expect(await loader.load(2)).toBe(ready!);
      expect(backgroundSignal?.aborted).toBe(false);
      expect(calls).toEqual([1, 2, 3]);
      release!();
      await settle();
      expect(calls).toEqual([1, 2, 3]);
    } finally {
      release?.();
      loader.dispose();
    }
  });

  test("bounds prepared page memory and discards it on close", async () => {
    const loader = new PdfPageLoader(async (page) => preview(page));
    for (const page of [1, 14, 24, 34]) {
      await loader.load(page);
      await settle();
    }
    expect(
      Array.from({ length: 100 }, (_, i) => loader.peek(i + 1)).filter(Boolean)
        .length
    ).toBeLessThanOrEqual(30);
    expect(loader.peek(1)).toBeUndefined();
    expect(loader.peek(50)?.page).toBe(50);
    loader.dispose();
    expect(loader.peek(50)).toBeUndefined();
  });

  test("bounds jumps, backward navigation, short documents, and unknown counts", () => {
    expect(pdfPrefetchPages(24, 26).sort((a, b) => a - b)).toEqual([
      21, 22, 23, 25, 26,
    ]);
    expect(pdfPrefetchPages(12, 100).sort((a, b) => a - b)).toEqual([
      11,
      ...range(13, 20),
    ]);
    expect(pdfPrefetchPages(1, 3)).toEqual([2, 3]);
    expect(pdfPrefetchPages(1, 1)).toEqual([]);
    expect(pdfPrefetchPages(4)).toEqual([]);
  });

  test("promotes the active prefetch and cancels unrelated work before a jump", async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    const complete = new Map<number, () => void>();
    let active = 0;
    let peak = 0;
    const loader = new PdfPageLoader((page, signal) => {
      started.push(page);
      peak = Math.max(peak, ++active);
      return new Promise<PdfPreview>((resolve, reject) => {
        const abort = () => {
          aborted.push(page);
          active -= 1;
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        complete.set(page, () => {
          signal.removeEventListener("abort", abort);
          active -= 1;
          resolve(preview(page));
        });
      });
    });
    try {
      const first = loader.load(1);
      await settle();
      complete.get(1)!();
      await first;
      await settle();
      expect(started).toEqual([1, 2]);
      const second = loader.load(2);
      await settle();
      expect(started).toEqual([1, 2]);
      expect(aborted).toEqual([]);
      complete.get(2)!();
      await second;
      await settle();
      expect(started).toEqual([1, 2, 3]);
      const jumped = loader.load(24);
      await settle();
      expect(aborted).toEqual([3]);
      expect(started).toEqual([1, 2, 3, 24]);
      complete.get(24)!();
      await jumped;
      await settle();
      expect(started.at(-1)).toBe(25);
      loader.dispose();
      await settle();
      expect(aborted).toEqual([3, 25]);
      expect(active).toBe(0);
      expect(peak).toBe(1);
    } finally {
      loader.dispose();
    }
  });

  test("background failures are quiet but foreground visits retry and report them", async () => {
    let attempts = 0;
    const loader = new PdfPageLoader(async (page) => {
      if (page === 2) {
        attempts += 1;
        throw new Error("bad page");
      }
      return preview(page, 3);
    });
    try {
      expect((await loader.load(1)).page).toBe(1);
      await settle();
      expect(attempts).toBe(1);
      await expect(loader.load(2)).rejects.toThrow("bad page");
      expect(attempts).toBe(2);
    } finally {
      loader.dispose();
    }
  });
});
