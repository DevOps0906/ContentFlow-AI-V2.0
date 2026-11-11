import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildConfig } from "../capacitor.config.ts";
import { checkApiBase, checkConfig, checkManifest } from "../scripts/check-release.mjs";
import { resolveApiBase } from "../vite.config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("release config: no server.url, no cleartext, https scheme, debugging off", () => {
  for (const env of [{}, { CAP_ENV: "prod" }, { CAP_SERVER_URL: "http://10.0.2.2:5173" }]) {
    const config = buildConfig(env);
    assert.equal(config.server?.url, undefined);
    assert.equal(config.server?.cleartext, undefined);
    assert.equal(config.server?.androidScheme, "https");
    assert.equal(config.android?.webContentsDebuggingEnabled, false);
    assert.equal(config.android?.allowMixedContent, false);
    assert.deepEqual(checkConfig(JSON.parse(JSON.stringify(config))), []);
  }
});

test("dev config (CAP_ENV=dev) enables cleartext and optional server.url, and the gate rejects it", () => {
  const config = buildConfig({ CAP_ENV: "dev", CAP_SERVER_URL: "http://10.0.2.2:5173" });
  assert.equal(config.server?.cleartext, true);
  assert.equal(config.server?.url, "http://10.0.2.2:5173");
  assert.ok(checkConfig(JSON.parse(JSON.stringify(config))).length >= 2);
});

test("manifest gate: cleartext and allowBackup", () => {
  assert.deepEqual(checkManifest('<application android:allowBackup="false">'), []);
  assert.equal(checkManifest('<application android:allowBackup="true">').length, 1);
  assert.equal(checkManifest('<application android:allowBackup="false" android:usesCleartextTraffic="true">').length, 1);
});

test("API base: release needs https; http only with CAP_ENV=dev", () => {
  assert.equal(resolveApiBase("build", { VITE_API_BASE: "https://api.example.com/" }), "https://api.example.com");
  assert.throws(() => resolveApiBase("build", { VITE_API_BASE: "http://10.0.2.2:3410" }));
  assert.equal(resolveApiBase("build", { VITE_API_BASE: "http://10.0.2.2:3410" }, "dev"), "http://10.0.2.2:3410");
  assert.throws(() => resolveApiBase("build", { VITE_API_BASE: "not a url" }));
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("screen code never imports @capacitor/*", () => {
  const offenders = walk(join(root, "src"))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => readFileSync(f, "utf8").includes("@capacitor/"));
  assert.deepEqual(offenders, []);
});

test("build-apk: versionCode from package version", async () => {
  const { versionCodeFrom } = await import("../scripts/build-apk.mjs");
  assert.equal(versionCodeFrom("0.1.0"), 100);
  assert.equal(versionCodeFrom("1.2.3"), 10203);
  assert.throws(() => versionCodeFrom("x"));
});

test("dev channel: appId has .dev suffix and its own label; release does not", () => {
  const dev = buildConfig({ CAP_ENV: "dev" });
  assert.equal(dev.appId, "com.devops0906.contentflow.dev");
  assert.equal(dev.appName, "ContentFlow (개발)");
  const release = buildConfig({});
  assert.equal(release.appId, "com.devops0906.contentflow");
  assert.equal(release.appName, "ContentFlow");
});

test("bundle API address gate: https only, no placeholder", () => {
  assert.deepEqual(checkApiBase("https://app.example.com"), []);
  assert.equal(checkApiBase("http://10.0.2.2:3410").length, 1);
  assert.equal(checkApiBase("https://contentflow.example.invalid").length, 1);
  assert.equal(checkApiBase(undefined).length, 1);
  assert.equal(checkApiBase("").length, 1);
});
