// Idempotent post-step for the generated Android project: turn off app backup so the
// Keystore-encrypted tokens are never restored onto another device. Run after `cap add` / `cap sync`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "android", "app", "src", "main", "AndroidManifest.xml");
if (!existsSync(manifest)) {
  console.error("AndroidManifest.xml not found: run `npx cap add android` first.");
  process.exit(1);
}
let xml = readFileSync(manifest, "utf8");
if (/android:allowBackup\s*=/.test(xml)) {
  xml = xml.replace(/android:allowBackup\s*=\s*"[^"]*"/, 'android:allowBackup="false"');
} else {
  xml = xml.replace("<application", '<application\n        android:allowBackup="false"');
}
writeFileSync(manifest, xml);
console.log("AndroidManifest.xml: allowBackup=false");

// App label follows the channel (CAP_ENV=dev -> "ContentFlow (개발)").
const strings = join(dirname(manifest), "res", "values", "strings.xml");
if (existsSync(strings)) {
  const name = process.env.CAP_ENV === "dev" ? "ContentFlow (개발)" : "ContentFlow";
  let xml2 = readFileSync(strings, "utf8");
  xml2 = xml2
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${name}$2`)
    .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${name}$2`);
  writeFileSync(strings, xml2);
  console.log(`strings.xml: app_name=${name}`);
}
