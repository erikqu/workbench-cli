import type { PdfPreview } from "./pdf";

type RenderPage<T> = (page: number, signal: AbortSignal) => Promise<T>;
interface RenderJob<T> {
  controller: AbortController;
  page: number;
  promise: Promise<T>;
}

// Unknown page counts disable speculation: do not probe beyond the document.
export function pdfPrefetchPages(page: number, pageCount?: number): number[] {
  if (!pageCount || pageCount < 1) {
    return [];
  }
  const current = Math.min(pageCount, Math.max(1, Math.floor(page)));
  const start = Math.floor((current - 1) / 10) * 10 + 1;
  const end = Math.min(pageCount, start + (current - start >= 3 ? 19 : 9));
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  // Warm forward navigation first, then any earlier pages in the current group.
  return [
    ...pages.filter((p) => p > current),
    ...pages.filter((p) => p < current),
  ];
}

// One active preparation per viewer. Foreground requests adopt the matching
// prefetch or abort unrelated work without waiting for its asynchronous cleanup.
export class PdfPageLoader<T extends PdfPreview = PdfPreview> {
  private active?: RenderJob<T>;
  private readonly ready = new Map<number, T>();
  private queue: number[] = [];
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;

  constructor(private readonly renderPage: RenderPage<T>) {}

  peek(page: number): T | undefined {
    return this.ready.get(page);
  }

  async load(page: number): Promise<T> {
    if (this.disposed) {
      throw new DOMException("PDF viewer closed", "AbortError");
    }
    const generation = ++this.generation;
    this.queue = [];
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    const cached = this.peek(page);
    const result =
      cached ??
      (await (this.active?.page === page ? this.active : this.start(page))
        .promise);
    if (!this.disposed && generation === this.generation) {
      this.queue = pdfPrefetchPages(result.page, result.pageCount).filter(
        (p) => !this.ready.has(p)
      );
      this.pump();
    }
    return result;
  }

  dispose() {
    this.disposed = true;
    this.ready.clear();
    this.queue = [];
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.active?.controller.abort();
  }

  private start(page: number): RenderJob<T> {
    const previous = this.active;
    previous?.controller.abort();
    const controller = new AbortController();
    // A cancelled decoder may finish late; it must not hold up the new page.
    const promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return this.renderPage(page, controller.signal);
      })
      .then((result) => {
        controller.signal.throwIfAborted();
        this.ready.set(result.page, result);
        // Bound decoded/encoded page memory even for very long documents.
        while (this.ready.size > 30) {
          this.ready.delete(this.ready.keys().next().value!);
        }
        return result;
      })
      .finally(() => {
        if (this.active === job) {
          this.active = undefined;
          this.pump();
        }
      });
    const job: RenderJob<T> = { page, controller, promise };
    this.active = job;
    return job;
  }

  private pump() {
    if (this.disposed || this.active) {
      return;
    }
    while (this.queue.length && this.ready.has(this.queue[0]!)) {
      this.queue.shift();
    }
    if (this.backgroundTimer !== undefined || !this.queue.length) {
      return;
    }
    // Let the foreground result commit and service input between every page.
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      if (this.disposed || this.active) {
        return;
      }
      const page = this.queue.shift();
      if (page !== undefined) {
        this.start(page).promise.catch(() => undefined);
      }
    }, 0);
  }
}
