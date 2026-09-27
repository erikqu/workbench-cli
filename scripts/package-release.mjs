import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, ["scripts/version.mjs", "--check"], { cwd: root, stdio: "inherit" });
// Never package local credentials, ignored build output, or an uncommitted
// mixture of product versions. Every source file must come from this commit.
execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: root });
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const distribution = JSON.parse(await readFile(path.join(root, "distribution.json"), "utf8"));
if (!/^[\w.-]+\/[\w.-]+$/.test(distribution.repository)) throw new Error("Invalid distribution repository");
if (distribution.iphoneInstallUrl && !/^https:\/\/(?:testflight\.apple\.com\/join\/[A-Za-z0-9]+|apps\.apple\.com\/[^\s]+)$/.test(distribution.iphoneInstallUrl)) {
  throw new Error("iphoneInstallUrl must be an official TestFlight or App Store install link");
}
const output = path.join(root, "release");
await mkdir(output, { recursive: true });
for (const [name, files] of [
  [`workbench-cli-v${version}.tar.gz`, ["bin", "workbench-ui", "install.sh", "README.md", "LICENSE", "AGENT.md"]],
  [`workbench-v${version}.tar.gz`, []],
]) {
  execFileSync("git", ["archive", "--format=tar.gz", `--output=${path.join(output, name)}`, "HEAD", ...files], { cwd: root, stdio: "inherit" });
  const digest = createHash("sha256").update(await readFile(path.join(output, name))).digest("hex");
  await writeFile(path.join(output, `${name}.sha256`), `${digest}  ${name}\n`);
}
await copyFile(path.join(root, "install.sh"), path.join(output, "install.sh"));
await copyFile(path.join(root, "install-host.sh"), path.join(output, "install-host.sh"));
await writeFile(path.join(output, "distribution.json"), JSON.stringify({ ...distribution, version }, null, 2) + "\n");
await rm(path.join(output, "iphone-install-url.txt"), { force: true });
if (distribution.iphoneInstallUrl) {
  await writeFile(path.join(output, "iphone-install-url.txt"), distribution.iphoneInstallUrl + "\n");
}
console.log(`Release files prepared in ${output}`);
