import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../workbench-ui/", import.meta.url));
const remote = fileURLToPath(new URL("../apps/remote/", import.meta.url));
const tasks = {
  setup: [
    ["bun", ["install", "--frozen-lockfile"], cli],
    ["npm", ["ci"], remote],
  ],
  "check:cli": [
    ["bun", ["run", "typecheck"], cli],
    ["bun", ["test"], cli],
    ["bun", ["run", "check"], cli],
  ],
  "check:remote": [
    ["npm", ["run", "check"], remote],
    ["npm", ["run", "build:services"], remote],
  ],
  "dev:cli": [["bun", ["run", "dev"], cli]],
  "dev:host": [["npm", ["run", "host", "--"], remote]],
  "dev:relay": [["npm", ["run", "relay", "--"], remote]],
  "build:host": [["npm", ["run", "package:host"], remote]],
};
tasks.check = [
  [process.execPath, ["scripts/version.mjs", "--check"], root],
  [process.execPath, ["--test", "tests/distribution.test.mjs"], root],
  ...tasks["check:cli"],
  ...tasks["check:remote"],
];

const [name, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(tasks, name)) {
  console.error(`Usage: node scripts/workspace.mjs ${Object.keys(tasks).join("|")}`);
  process.exit(2);
}
for (const [program, args, cwd] of tasks[name]) {
  console.log(`\n${program} ${[...args, ...extra].join(" ")} (${cwd})`);
  const child = spawn(program, [...args, ...extra], { cwd, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM"].map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return [signal, forward];
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  }).finally(() => {
    for (const [signal, forward] of signals) process.off(signal, forward);
  });
  if (code !== 0) process.exit(code);
}
