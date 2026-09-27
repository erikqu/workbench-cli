import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const files = ["package.json", "workbench-ui/package.json", "apps/remote/package.json", "apps/remote/package-lock.json"];
const input = process.argv[2];
const check = input === "--check";
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const version = check ? manifest.version : input;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/version.mjs <major.minor.patch>|--check");
}
const tag = process.env.RELEASE_TAG;
if (check && tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${version}`);
}
for (const file of files) {
  const url = new URL(file, root);
  const value = JSON.parse(await readFile(url, "utf8"));
  if (check) {
    if (value.version !== version || (value.packages && value.packages[""].version !== version)) {
      throw new Error(`Version mismatch in ${file}; run npm run version:set -- ${version}`);
    }
  } else {
    value.version = version;
    if (value.packages) value.packages[""].version = version;
    await writeFile(url, JSON.stringify(value, null, 2) + "\n");
  }
}
const project = new URL("apps/remote/apple/project.yml", root);
const yaml = await readFile(project, "utf8");
if (check) {
  if (!yaml.includes(`MARKETING_VERSION: "${version}"`)) throw new Error("iPhone marketing version does not match the monorepo");
} else {
  await writeFile(project, yaml.replace(/MARKETING_VERSION: "[^"]+"/, `MARKETING_VERSION: "${version}"`));
}
console.log(`${check ? "Verified" : "Set"} Workbench ${version} in ${fileURLToPath(root)}`);
