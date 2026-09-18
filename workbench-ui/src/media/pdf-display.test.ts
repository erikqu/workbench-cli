import { expect, test } from "bun:test";
import { join } from "node:path";

test("PDF display workers prepare each protocol, stay responsive, and abort cleanly", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { preparePdfDisplay } from ${JSON.stringify(join(import.meta.dir, "pdf-display.ts"))};
    const path = ${JSON.stringify(join(import.meta.dir, "../../test-harness/sample.png"))};
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    try {
      const placement = await preparePdfDisplay(path, 80, 40, new AbortController().signal);
      assert.equal(placement.protocol, process.env.EXPECTED_PROTOCOL);
      assert.ok(ticks > 0, "UI event loop must stay responsive during image preparation");
      if (placement.protocol === "graphics") assert.ok(Buffer.isBuffer(placement.src));
      if (placement.protocol === "kitty-tmux") assert.ok(placement.transmit.length > 0);
      if (placement.protocol === "halfblock") assert.ok(placement.fallback.includes("▀"));
      const cancelled = new AbortController();
      const pending = preparePdfDisplay(path, 80, 40, cancelled.signal);
      const rejected = assert.rejects(pending, {name: "AbortError"});
      cancelled.abort();
      await rejected;
      assert.throws(() => preparePdfDisplay(path, 80, 40, cancelled.signal), {name: "AbortError"});
      const retry = await preparePdfDisplay(path, 80, 40, new AbortController().signal);
      assert.equal(retry.protocol, placement.protocol);
      await assert.rejects(preparePdfDisplay(path + ".missing", 80, 40, new AbortController().signal));
    } finally { clearInterval(heartbeat); }
  `;
  for (const protocol of ["halfblock", "kitty-tmux", "graphics"]) {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...Bun.env,
        WORKBENCH_UI_IMAGE_PROTOCOL:
          protocol === "halfblock" ? "halfblock" : "kitty",
        TMUX: protocol === "kitty-tmux" ? "pdf-worker-test" : "",
        STY: "",
        EXPECTED_PROTOCOL: protocol,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(0);
  }
}, 15_000);
