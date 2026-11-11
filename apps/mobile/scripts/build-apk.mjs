// Builds the sideload APK: vite build -> cap sync -> (release) check-release -> gradle assembleRelease
// -> <repo>/mobile-dist/app.apk + app.json.
// Usage: CAP_ENV=release|dev [VITE_API_BASE=...] [CF_VERSION_CODE=n] node scripts/build-apk.mjs
// Release signing (env only, values are never printed):
//   ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(mobile, "..", "..");
const isWin = process.platform === "win32";

function fail(message) {
  console.error(`build-apk: ${message}`);
  process.exit(1);
}

/** "1.2.3" -> 10203 (major*10000 + minor*100 + patch). */
export function versionCodeFrom(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`cannot derive versionCode from version "${version}"`);
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { cwd: mobile, stdio: "inherit", shell: isWin && !command.endsWith(".bat"), ...options });
  if (res.status !== 0) fail(`"${command} ${args.join(" ")}" failed (exit ${res.status ?? "signal"})`);
}

function hasCommand(cmd, args = ["-version"]) {
  return spawnSync(cmd, args, { stdio: "ignore", shell: isWin }).status === 0;
}

function main() {
  const channel = process.env.CAP_ENV === "dev" ? "dev" : process.env.CAP_ENV === "release" ? "release" : null;
  if (!channel) fail('set CAP_ENV=release or CAP_ENV=dev (e.g. CAP_ENV=release VITE_API_BASE=https://app.example.com).');

  const apiBase = (process.env.VITE_API_BASE ?? "").trim();
  if (channel === "release") {
    if (!/^https:\/\//i.test(apiBase)) fail("release needs VITE_API_BASE=https://... (an https server address).");
  } else if (!apiBase) {
    fail("a dev build needs VITE_API_BASE (for example http://<PC LAN IP>:3410).");
  }

  // Both channels are signed (an unsigned APK cannot be installed). dev may use its own key
  // (ANDROID_DEV_*); otherwise the release key is used. The dev appId differs, so it can never overwrite the release app.
  const prefix = channel === "dev" && process.env.ANDROID_DEV_KEYSTORE_PATH ? "ANDROID_DEV_" : "ANDROID_";
  const signing = {};
  for (const name of ["KEYSTORE_PATH", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"]) {
    const value = process.env[prefix + name];
    if (!value) fail(`signing needs env ${prefix}${name} (see apps/mobile/README.md, "APK 서명 키").`);
    signing["ANDROID_" + name] = value;
  }
  if (!existsSync(signing.ANDROID_KEYSTORE_PATH)) fail(`${prefix}KEYSTORE_PATH does not point to an existing file.`);

  // Tooling check first so the failure is clear and early.
  const javaOk = hasCommand("java");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!javaOk || !sdk || !existsSync(sdk)) {
    fail(
      "JDK 21 and the Android SDK are required to build an APK.\n" +
        `  java: ${javaOk ? "found" : "NOT found (install JDK 21 and put it on PATH / JAVA_HOME)"}\n` +
        `  Android SDK: ${sdk && existsSync(sdk) ? "found" : "NOT found (install Android Studio, then set ANDROID_HOME)"}`,
    );
  }

  const pkg = JSON.parse(readFileSync(join(mobile, "package.json"), "utf8"));
  const versionCode = process.env.CF_VERSION_CODE ? Number(process.env.CF_VERSION_CODE) : versionCodeFrom(pkg.version);
  if (!Number.isInteger(versionCode) || versionCode < 1) fail("CF_VERSION_CODE must be a positive integer.");
  const env = { ...process.env, ...signing, CF_VERSION_CODE: String(versionCode), CF_VERSION_NAME: pkg.version };

  if (!existsSync(join(mobile, "android"))) run("npx", ["cap", "add", "android"], { env });
  run("npm", ["run", "build"], { env });
  run("npm", ["run", "cap:sync"], { env });
  if (channel === "release") run("node", ["scripts/check-release.mjs"], { env });

  // The synced config is the source of truth for the application id (dev has the .dev suffix).
  const appId = JSON.parse(readFileSync(join(mobile, "android", "app", "src", "main", "assets", "capacitor.config.json"), "utf8")).appId;
  if (channel === "dev" ? !appId.endsWith(".dev") : appId.endsWith(".dev")) fail(`appId "${appId}" does not match channel ${channel}.`);
  env.CF_APPLICATION_ID = appId;

  const gradle = join(mobile, "android", isWin ? "gradlew.bat" : "gradlew");
  run(gradle, ["assembleRelease"], { cwd: join(mobile, "android"), env, shell: isWin });

  const outDir = join(mobile, "android", "app", "build", "outputs", "apk", "release");
  const apks = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".apk")) : [];
  const signed = apks.find((f) => !f.includes("unsigned")) ?? null;
  if (!signed) fail(`no signed APK found in ${outDir} (signing config not applied?).`);

  const dist = join(repo, "mobile-dist");
  mkdirSync(dist, { recursive: true });
  const target = join(dist, "app.apk");
  copyFileSync(join(outDir, signed), target);
  const bytes = readFileSync(target);
  const info = {
    appId,
    version: pkg.version,
    versionCode,
    channel,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: statSync(target).size,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dist, "app.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`build-apk OK: ${target} (${info.channel}, v${info.version}, code ${info.versionCode}, sha256 ${info.sha256.slice(0, 12)}...)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
