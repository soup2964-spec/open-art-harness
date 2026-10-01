// HMAC-SHA256 over Web Crypto (workerd, browsers, Node >= 18). The edge-sim uses node:crypto
// for the same construction; test/node/edge-sim.test.ts proves the outputs are identical.
import { base64urlToBytes, bytesToBase64url, utf8 } from "./core/base64url.js";
import { attrSigningInput, decodeStatePayload, encodeStatePayload, formatAttrCookieValue, splitAttrCookieValue } from "./core/codec.js";
import { isUsableSecret } from "./core/secrets.js";

export { isUsableSecret } from "./core/secrets.js";
import type { AttributionState } from "./core/model.js";
import type { VerifiedAttr } from "./core/plan.js";

export interface AttributionSecrets {
  current: string;
  /** Accepted for verification only, during rotation. */
  previous?: string;
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keys = new Map<string, Promise<HmacKey>>();

function hmacKey(secret: string): Promise<HmacKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, key);
    // Never cache a failure for the isolate's lifetime.
    key.catch(() => keys.delete(secret));
  }
  return key;
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(data));
  return bytesToBase64url(new Uint8Array(sig));
}

/** Constant-time verification (crypto.subtle.verify). */
export async function hmacVerify(secret: string, data: string, tag: string): Promise<boolean> {
  const bytes = base64urlToBytes(tag);
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, utf8(data));
}

export async function signAttrState(state: AttributionState, secret: string): Promise<string> {
  const payload = encodeStatePayload(state);
  return formatAttrCookieValue(payload, await hmacSign(secret, attrSigningInput(payload)));
}

/** Verifies and decodes an `oa_attr` value. Null for anything forged, tampered, malformed or expired. */
export async function verifyAttrCookie(value: string | null | undefined, secrets: AttributionSecrets, now: number): Promise<VerifiedAttr | null> {
  const parts = splitAttrCookieValue(value);
  if (!parts) return null;
  const input = attrSigningInput(parts.payload);
  let needsResign = false;
  if (!(await hmacVerify(secrets.current, input, parts.tag))) {
    if (!secrets.previous || !(await hmacVerify(secrets.previous, input, parts.tag))) return null;
    needsResign = true;
  }
  const state = decodeStatePayload(parts.payload, now);
  return state ? { state, needsResign } : null;
}

/** Reads ATTRIBUTION_SECRET(_PREVIOUS) from the Worker env; null when missing or unusable (fail closed). */
export function readSecrets(env: { ATTRIBUTION_SECRET?: unknown; ATTRIBUTION_SECRET_PREVIOUS?: unknown }): AttributionSecrets | null {
  const current = env.ATTRIBUTION_SECRET;
  if (!isUsableSecret(current)) return null;
  const previous = env.ATTRIBUTION_SECRET_PREVIOUS;
  return isUsableSecret(previous) ? { current, previous } : { current };
}
