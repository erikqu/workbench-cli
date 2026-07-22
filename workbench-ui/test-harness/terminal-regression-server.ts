import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const fixtureRoot = join(import.meta.dir, "..");
const appRoot = Bun.env.WORKBENCH_E2E_APP_ROOT ?? fixtureRoot;
const workspace = Bun.env.WORKBENCH_E2E_WORKSPACE ?? appRoot;
const port = Number(Bun.env.WORKBENCH_E2E_PORT ?? "4187");
const initialCols = Number(Bun.env.WORKBENCH_E2E_COLS ?? "120");
const initialRows = Number(Bun.env.WORKBENCH_E2E_ROWS ?? "40");
const tracePath = Bun.env.WORKBENCH_E2E_TRACE;
const chunkSeed = parseOptionalInteger(Bun.env.WORKBENCH_E2E_CHUNK_SEED);
const chunkPrefix = "\0WORKBENCH_CHUNK_OUTPUT";
const resizePrefix = "\0WORKBENCH_RESIZE ";
let randomState = chunkSeed ?? 0;
let chunkOutput = false;

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
            sendOutput(socket, text);
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
      if (bytes === chunkPrefix) {
        chunkOutput = true;
        appendTrace({ event: "chunk-output", seed: chunkSeed });
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

function sendOutput(socket: ServerWebSocket<unknown>, output: string) {
  if (chunkSeed === undefined || !chunkOutput) {
    socket.send(output);
    return;
  }
  // PTYs, SSH, and terminal emulators may split writes anywhere, including in
  // the middle of a CSI sequence. Seeded short WebSocket messages preserve the
  // bytes and ordering while making that transport behavior deterministic.
  let offset = 0;
  while (offset < output.length) {
    const length = 1 + Math.floor(nextRandom() * 12);
    let end = Math.min(output.length, offset + length);
    const finalCodeUnit = output.charCodeAt(end - 1);
    if (finalCodeUnit >= 0xd8_00 && finalCodeUnit <= 0xdb_ff) {
      end += 1;
    }
    socket.send(output.slice(offset, end));
    offset = end;
  }
}

function nextRandom() {
  randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return randomState / 4_294_967_296;
}

function parseOptionalInteger(value: string | undefined) {
  if (!value) {
    return;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
