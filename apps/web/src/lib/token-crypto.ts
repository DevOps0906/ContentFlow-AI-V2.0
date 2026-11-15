// AES-256-GCM for the Google refresh tokens (ANALYTICS_SYNC.md D2). Server-only.
// Keys come from ANALYTICS_TOKEN_KEYS = "<version>:<base64 32 bytes>,<version>:<base64>": the highest
// version encrypts, every listed version decrypts (rotation). The database only ever sees the envelope.
// AAD binds a ciphertext to its grant: [grant_id, workspace_id, google_sub, key_version].
// Envelope: "v1." + base64url(iv(12) | tag(16) | ciphertext). grant_id, workspace_id, google_sub and key_version
// come from the database row (read_credential / read_grant_credential) and are checked through the AAD.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type KeyRing = { latest: number; keys: Map<number, Buffer> };
export type TokenAad = { grantId: string; workspaceId: string; googleSub: string };

export class TokenCryptoError extends Error {}

export function parseKeyRing(raw: string | undefined): KeyRing | null {
  if (!raw?.trim()) return null;
  const keys = new Map<number, Buffer>();
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,9})\s*:\s*([A-Za-z0-9+/_-]+={0,2})\s*$/.exec(part);
    if (!m) return null;
    const version = Number(m[1]);
    const key = Buffer.from(m[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (version < 1 || key.length !== 32 || keys.has(version)) return null;
    keys.set(version, key);
  }
  return keys.size ? { latest: Math.max(...keys.keys()), keys } : null;
}

const aadOf = (a: TokenAad, version: number) => Buffer.from(JSON.stringify([a.grantId, a.workspaceId, a.googleSub, version]));
const b64u = (b: Buffer) => b.toString("base64url");

function seal(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < 29) throw new TokenCryptoError("invalid ciphertext");
  try {
    const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
    d.setAAD(aad);
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  } catch {
    throw new TokenCryptoError("invalid ciphertext");
  }
}

export function encryptToken(ring: KeyRing, token: string, aad: TokenAad, version = ring.latest): { ciphertext: string; keyVersion: number } {
  const key = ring.keys.get(version);
  if (!key) throw new TokenCryptoError("unknown key version");
  const blob = seal(key, Buffer.from(token, "utf8"), aadOf(aad, version));
  return { ciphertext: `v1.${b64u(blob)}`, keyVersion: version };
}

export function decryptToken(ring: KeyRing, ciphertext: string, keyVersion: number, aad: TokenAad): { token: string } {
  const key = ring.keys.get(keyVersion);
  const m = /^v1\.([A-Za-z0-9_-]+)$/.exec(ciphertext);
  if (!key || !m) throw new TokenCryptoError("invalid ciphertext");
  return { token: open(key, Buffer.from(m[1], "base64url"), aadOf(aad, keyVersion)).toString("utf8") };
}

/** Re-encrypts with the newest key. Returns null when it already uses it. */
export function reencryptToken(ring: KeyRing, ciphertext: string, keyVersion: number, aad: TokenAad) {
  if (keyVersion === ring.latest) return null;
  return encryptToken(ring, decryptToken(ring, ciphertext, keyVersion, aad).token, aad);
}

// Short-lived sealed values (the OAuth state cookie). The key is derived from the newest token key.
const sealKey = (ring: KeyRing) => Buffer.from(hkdfSync("sha256", ring.keys.get(ring.latest)!, Buffer.alloc(0), "cf-oauth-cookie", 32));
export function sealValue(ring: KeyRing, value: unknown): string {
  return b64u(seal(sealKey(ring), Buffer.from(JSON.stringify(value)), Buffer.from("cf-oauth-cookie")));
}
export function openValue(ring: KeyRing, sealed: string): unknown {
  try {
    return JSON.parse(open(sealKey(ring), Buffer.from(sealed, "base64url"), Buffer.from("cf-oauth-cookie")).toString("utf8"));
  } catch {
    throw new TokenCryptoError("invalid sealed value");
  }
}
