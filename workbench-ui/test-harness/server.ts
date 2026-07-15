import { join, normalize } from "node:path";

const root = join(import.meta.dir, "..");
const port = Number(Bun.env.WORKBENCH_SCREENSHOT_PORT ?? "4177");
const cols = Number(Bun.env.WORKBENCH_SCREENSHOT_COLS ?? "180");
const rows = Number(Bun.env.WORKBENCH_SCREENSHOT_ROWS ?? "40");
const command = Bun.env.WORKBENCH_SCREENSHOT_CMD ?? "bun start";

const processes = new Map<unknown, ReturnType<typeof Bun.spawn>>();

const server = Bun.serve({
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/pty") {
      if (server.upgrade(request)) {
        return;
      }
      return new Response("upgrade failed", { status: 400 });
    }

    const path =
      url.pathname === "/" ? "/test-harness/index.html" : url.pathname;
    const filePath = normalize(join(root, path));
    if (!filePath.startsWith(root)) {
      return new Response("not found", { status: 404 });
    }

    const file = Bun.file(filePath);
    return new Response(file);
  },
  websocket: {
    open(socket) {
      const shellCommand = `stty cols ${cols} rows ${rows}; ${command}`;
      const childEnv = {
        ...Bun.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        COLUMNS: String(cols),
        LINES: String(rows),
        WORKBENCH_LOG_FILTER: "off",
        WORKBENCH_UI_SCREENSHOT: "1",
      };
      delete childEnv.NO_COLOR;
      const child = Bun.spawn(["script", "-qefc", shellCommand, "/dev/null"], {
        cwd: root,
        env: childEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      processes.set(socket, child);
      streamToSocket(child.stdout as ReadableStream<Uint8Array>, socket);
      streamToSocket(child.stderr as ReadableStream<Uint8Array>, socket);
      child.exited.finally(() => processes.delete(socket));
    },
    message(socket, data) {
      const child = processes.get(socket);
      const stdin = child?.stdin as
        | { write(data: string | Uint8Array): unknown; flush(): unknown }
        | undefined;
      if (!stdin) {
        return;
      }
      stdin.write(
        typeof data === "string"
          ? data
          : new Uint8Array(data as ArrayBufferLike)
      );
      stdin.flush();
    },
    close(socket) {
      const child = processes.get(socket);
      processes.delete(socket);
      try {
        child?.kill();
      } catch {
        // Ignore shutdown races.
      }
    },
  },
});

console.log(`READY http://127.0.0.1:${server.port}`);

async function streamToSocket(
  stream: ReadableStream<Uint8Array>,
  socket: ServerWebSocket<unknown>
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    socket.send(decoder.decode(value, { stream: true }));
  }
}
