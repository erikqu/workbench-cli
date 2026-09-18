import type { PdfPreview } from "./pdf";

type RenderPage = (page: number, signal: AbortSignal) => Promise<PdfPreview>;
interface RenderJob {
  controller: AbortController;
  page: number;
  promise: Promise<PdfPreview>;
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

// One rasterizer at a time per viewer. Foreground requests can adopt an active
// prefetch of the same page, or cancel unrelated work before starting their own.
export class PdfPageLoader {
  private active?: RenderJob;
  private queue: number[] = [];
  private generation = 0;
  private disposed = false;

  constructor(private readonly renderPage: RenderPage) {}

  async load(page: number): Promise<PdfPreview> {
    if (this.disposed) {
      throw new DOMException("PDF viewer closed", "AbortError");
    }
    const generation = ++this.generation;
    this.queue = [];
    const job = this.active?.page === page ? this.active : this.start(page);
    const result = await job.promise;
    if (!this.disposed && generation === this.generation) {
      this.queue = pdfPrefetchPages(result.page, result.pageCount);
      this.pump();
    }
    return result;
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.active?.controller.abort();
  }

  private start(page: number): RenderJob {
    const previous = this.active;
    previous?.controller.abort();
    const controller = new AbortController();
    // Await cancellation cleanup so fast navigation cannot pile up processes.
    const promise = (
      previous ? previous.promise.catch(() => undefined) : Promise.resolve()
    )
      .then(() => {
        controller.signal.throwIfAborted();
        return this.renderPage(page, controller.signal);
      })
      .finally(() => {
        if (this.active === job) {
          this.active = undefined;
          this.pump();
        }
      });
    const job: RenderJob = { page, controller, promise };
    this.active = job;
    return job;
  }

  private pump() {
    if (this.disposed || this.active) {
      return;
    }
    const page = this.queue.shift();
    if (page !== undefined) {
      // Failed speculative pages must not replace the visible page with an
      // error. A foreground visit retries them through the normal error path.
      this.start(page).promise.catch(() => undefined);
    }
  }
}
