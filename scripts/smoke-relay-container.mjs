import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/smoke-relay-container.mjs <built-image>");
const prefix = `workbench-relay-check-${randomUUID()}`;
const network = `${prefix}-net`;
const database = `${prefix}-db`;
const relay = `${prefix}-app`;
const docker = (args, stdio = "pipe") => execFileSync("docker", args, { stdio, timeout: 120_000, encoding: "utf8" });
try {
  docker(["network", "create", network]);
  docker(["run", "--detach", "--name", database, "--network", network,
    "--network-alias", "database", "-e", "POSTGRES_PASSWORD=test-only",
    "-e", "POSTGRES_DB=workbench", "postgres:17-alpine"]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker(["exec", database, "pg_isready", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error("Isolated container database did not start");
  docker(["run", "--detach", "--name", relay, "--network", network,
    "-e", "DATABASE_URL=postgres://postgres:test-only@database:5432/workbench",
    "-e", "APPLE_AUDIENCE=dev.workbench.remote", image]);
  docker(["exec", relay, "node", "--input-type=module", "-e", `
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch('http://127.0.0.1:8080/health');
        if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!healthy) throw new Error('Packaged relay did not become healthy');
    const installer = await fetch('http://127.0.0.1:8080/install.sh');
    if (!installer.ok || !(await installer.text()).includes('WORKBENCH_HOST_HOME')) {
      throw new Error('Packaged relay did not serve the shared host installer');
    }
    console.log('Packaged relay connects to PostgreSQL and serves health and installer endpoints.');
  `], "inherit");
} catch (error) {
  try { console.error(docker(["logs", relay])); } catch {}
  throw error;
} finally {
  for (const name of [relay, database]) {
    try { docker(["rm", "-f", name]); } catch {}
  }
  try { docker(["network", "rm", network]); } catch {}
}
