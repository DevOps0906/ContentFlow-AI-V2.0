// Server-only: the Android APK offered on the dashboard. The files live outside git and the
// image, in MOBILE_APK_DIR (compose mounts ./mobile-dist read-only): `app.apk` + `app.json`.
// The file names are fixed; nothing from a request ever becomes part of a path.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

export type MobileAppInfo = {
  version: string;
  versionCode: number;
  channel: "dev" | "release";
  sha256: string;
  size: number;
  builtAt: string;
};
export type MobileApp =
  | { status: "none" }
  | { status: "invalid" } // app.json unreadable or the file does not match its sha256
  | { status: "ok"; info: MobileAppInfo; apkPath: string };

const hashCache = new Map<string, string>();

async function sha256Of(path: string, key: string): Promise<string> {
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const hex = hash.digest("hex");
  hashCache.set(key, hex);
  return hex;
}

function parseMeta(raw: unknown): Omit<MobileAppInfo, "size"> | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const { version, versionCode, channel, sha256, builtAt } = m;
  if (typeof version !== "string" || !version || version.length > 40) return null;
  if (typeof versionCode !== "number" || !Number.isInteger(versionCode) || versionCode < 1) return null;
  if (channel !== "dev" && channel !== "release") return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  if (typeof builtAt !== "string" || Number.isNaN(Date.parse(builtAt))) return null;
  return { version, versionCode, channel, sha256: sha256.toLowerCase(), builtAt };
}

export async function readMobileApp(env = process.env): Promise<MobileApp> {
  const dir = env.MOBILE_APK_DIR?.trim();
  if (!dir) return { status: "none" };
  const apkPath = join(dir, "app.apk");
  let st;
  let metaText: string;
  try {
    st = await stat(apkPath);
    if (!st.isFile()) return { status: "none" };
    metaText = await readFile(join(dir, "app.json"), "utf8");
  } catch {
    return { status: "none" };
  }
  let meta;
  try {
    meta = parseMeta(JSON.parse(metaText));
  } catch {
    meta = null;
  }
  if (!meta) return { status: "invalid" };
  const actual = await sha256Of(apkPath, `${apkPath}:${st.size}:${st.mtimeMs}`);
  if (actual !== meta.sha256) return { status: "invalid" };
  return { status: "ok", info: { ...meta, size: st.size }, apkPath };
}

/** Streams the verified file; the caller has already checked the hash. */
export function apkStream(path: string): ReadableStream {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
}
