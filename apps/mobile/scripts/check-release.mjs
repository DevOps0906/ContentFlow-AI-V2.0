// Release gate: inspects the GENERATED Android files (after `cap sync`), not the source config.
// Usage: node scripts/check-release.mjs   (exit 1 on any violation)
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "android", "app", "src", "main");
const configPath = join(app, "assets", "capacitor.config.json");
const manifestPath = join(app, "AndroidManifest.xml");

export function checkConfig(config) {
  const problems = [];
  const server = config.server ?? {};
  if (server.url) problems.push(`server.url must be absent in a release (found ${server.url})`);
  if (server.cleartext === true) problems.push("server.cleartext must not be true");
  if (server.androidScheme !== "https") problems.push(`server.androidScheme must be "https" (found ${server.androidScheme})`);
  const android = config.android ?? {};
  if (android.webContentsDebuggingEnabled === true) problems.push("android.webContentsDebuggingEnabled must not be true");
  if (android.allowMixedContent === true) problems.push("android.allowMixedContent must not be true");
  return problems;
}

export function checkApiBase(apiBase) {
  if (typeof apiBase !== "string" || !/^https:\/\//i.test(apiBase)) return [`bundle API address must be https (found ${JSON.stringify(apiBase)})`];
  if (apiBase.includes("example.invalid")) return ["bundle API address is the placeholder: set VITE_API_BASE and rebuild"];
  return [];
}

export function checkManifest(xml) {
  const problems = [];
  if (/android:usesCleartextTraffic\s*=\s*"true"/.test(xml)) problems.push("Manifest: usesCleartextTraffic must not be true");
  if (!/android:allowBackup\s*=\s*"false"/.test(xml)) {
    problems.push('Manifest: android:allowBackup must be "false" (encrypted tokens must not be restored from a backup)');
  }
  return problems;
}

function main() {
  const problems = [];
  for (const [label, p] of [["capacitor.config.json", configPath], ["AndroidManifest.xml", manifestPath]]) {
    if (!existsSync(p)) problems.push(`${label} not found: run "npm run build" then "npm run cap:sync"`);
  }
  if (problems.length === 0) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    problems.push(...checkConfig(config));
    problems.push(...checkManifest(readFileSync(manifestPath, "utf8")));
    const infoPath = join(app, "assets", "public", "build-info.json");
    if (!existsSync(infoPath)) problems.push("assets/public/build-info.json not found: rebuild (npm run build) and sync");
    else problems.push(...checkApiBase(JSON.parse(readFileSync(infoPath, "utf8")).apiBase));
    if (String(config.appId ?? "").endsWith(".dev")) problems.push("appId ends with .dev: that is a dev-channel build");
  }
  if (problems.length) {
    console.error("check-release FAILED:\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log("check-release OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
