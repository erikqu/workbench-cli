import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const fixtureRoot = join(import.meta.dir, "..");
const appRoot = Bun.env.WORKBENCH_E2E_APP_ROOT ?? fixtureRoot;
const workspace = Bun.env.WORKBENCH_E2E_WORKSPACE ?? appRoot;
const port = Number(Bun.env.WORKBENCH_E2E_PORT ?? "4187");
const initialCols = Number(Bun.env.WORKBENCH_E2E_COLS ?? "120");
const initialRows = Number(Bun.env.WORKBENCH_E2E_ROWS ?? "40");
const tracePath = Bun.env.WORKBENCH_E2E_TRACE;
const resizePrefix = "\0WORKBENCH_RESIZE ";

interface ClientProcess {
  child: ReturnType<typeof Bun.spawn>;
  cols: number;
  decoder: TextDecoder;
  pty: Bun.Terminal;
  rows: number;
}

const processes = new Map<ServerWebSocket<unknown>, ClientProcess>();

if (tracePath) {
  mkdirSync(dirname(tracePath), { recursive: true });
  appendTrace({ event: "server-start", initialCols, initialRows });
}

const server = Bun.serve({
  port,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/pty") {
      if (bunServer.upgrade(request)) {
        return;
      }
      return new Response("upgrade failed", { status: 400 });
    }

    const path =
      url.pathname === "/" ? "/test-harness/index.html" : url.pathname;
    const filePath = normalize(join(fixtureRoot, path));
    if (!filePath.startsWith(fixtureRoot)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Bun.file(filePath));
  },
  websocket: {
    open(socket) {
      let client: ClientProcess;
      const pty = new Bun.Terminal({
        cols: initialCols,
        rows: initialRows,
        name: "xterm-256color",
        data: (_terminal, bytes) => {
          appendTrace({
            bytes: Buffer.from(bytes).toString("base64"),
            cols: client.cols,
            event: "output",
            rows: client.rows,
          });
          const text = client.decoder.decode(bytes, { stream: true });
          if (text) {
            socket.send(text);
          }
        },
      });
      const bun = Bun.which("bun") ?? process.execPath;
      const entry = join(appRoot, "src", "index.ts");
      const childEnv = {
        ...Bun.env,
        COLUMNS: String(initialCols),
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        LINES: String(initialRows),
        PATH: `${join(fixtureRoot, "test-harness")}:${Bun.env.PATH ?? ""}`,
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
        WORKBENCH_E2E_FIXTURE_ROOT: fixtureRoot,
        WORKBENCH_LOG_FILTER: "off",
        WORKBENCH_UI_CWD: workspace,
        WORKBENCH_UI_E2E: "1",
        WORKBENCH_UI_HARNESS_ID: "cursor",
        WORKBENCH_UI_IMAGE_PROTOCOL: "halfblock",
      };
      delete childEnv.NO_COLOR;
      const argv = Bun.which("setsid")
        ? ["setsid", "-c", bun, entry, workspace]
        : [bun, entry, workspace];
      const child = Bun.spawn(argv, {
        cwd: appRoot,
        env: childEnv,
        terminal: pty,
      });
      client = {
        child,
        cols: initialCols,
        decoder: new TextDecoder(),
        pty,
        rows: initialRows,
      };
      processes.set(socket, client);
      appendTrace({ event: "app-start", pid: child.pid });
      child.exited.then((exitCode) => {
        appendTrace({ event: "app-exit", exitCode });
        processes.delete(socket);
        try {
          socket.close();
        } catch {
          // Ignore a browser-close race.
        }
      });
    },
    message(socket, data) {
      const client = processes.get(socket);
      if (!client) {
        return;
      }
      const bytes =
        typeof data === "string"
          ? data
          : new TextDecoder().decode(new Uint8Array(data as ArrayBufferLike));
      if (bytes.startsWith(resizePrefix)) {
        const match = /^(\d+) (\d+)$/.exec(bytes.slice(resizePrefix.length));
        if (!match) {
          return;
        }
        const cols = Math.max(20, Number(match[1]));
        const rows = Math.max(8, Number(match[2]));
        client.cols = cols;
        client.rows = rows;
        appendTrace({ cols, event: "resize", rows });
        client.pty.resize(cols, rows);
        return;
      }
      appendTrace({
        bytes: Buffer.from(bytes).toString("base64"),
        event: "input",
      });
      client.pty.write(bytes);
    },
    close(socket) {
      closeClient(socket);
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const socket of processes.keys()) {
      closeClient(socket);
    }
    server.stop(true);
    process.exit(0);
  });
}

console.log(`READY http://127.0.0.1:${server.port}`);

function closeClient(socket: ServerWebSocket<unknown>) {
  const client = processes.get(socket);
  processes.delete(socket);
  if (!client) {
    return;
  }
  try {
    client.child.kill();
  } catch {
    // Ignore shutdown races.
  }
  try {
    client.pty.close();
  } catch {
    // Ignore shutdown races.
  }
}

function appendTrace(entry: Record<string, unknown>) {
  if (!tracePath) {
    return;
  }
  appendFileSync(
    tracePath,
    `${JSON.stringify({ at: performance.now(), ...entry })}\n`
  );
}
