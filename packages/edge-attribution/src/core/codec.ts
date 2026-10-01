// Compact, versioned encoding of AttributionState for the signed `oa_attr` cookie:
//   oa_attr = "1." + base64url(JSON) + "." + base64url(HMAC-SHA256(secret, "oa_attr.1." + payload))
// JSON keys are shortened (see CState). Decoding validates every field, so a correctly
// signed but malformed payload is still rejected.
import { base64urlToBytes, bytesToBase64url, fromUtf8, utf8 } from "./base64url.js";
import {
  CLICK_KEYS,
  CLICK_MAX_LEN,
  CLICK_MAX_LEN_DEFAULT,
  CLICK_VALUE_RE,
  DEVICE_ID_RE,
  HOST_MAX_LEN,
  PATH_MAX_LEN,
  SAFE_HOST_RE,
  TTL,
  UTM_FIELDS,
  UTM_MAX_LEN,
} from "./constants.js";
import type { ClickKey, UtmField } from "./constants.js";
import type { AttributionState, ClickIds, Touch, TouchType, Utm } from "./model.js";

export const ATTR_FORMAT_VERSION = "1";
export const MAX_ATTR_VALUE_LENGTH = 4096;

const TYPE_TO_CODE: Record<TouchType, "p" | "c" | "r" | "d"> = { paid: "p", campaign: "c", referral: "r", direct: "d" };
const CODE_TO_TYPE: Record<string, TouchType> = { p: "paid", c: "campaign", r: "referral", d: "direct" };
const UTM_TO_CODE: Record<UtmField, string> = { source: "s", medium: "m", campaign: "c", term: "t", content: "n", id: "i" };
const CODE_TO_UTM: Record<string, UtmField> = { s: "source", m: "medium", c: "campaign", t: "term", n: "content", i: "id" };

interface CTouch {
  a: number;
  t: "p" | "c" | "r" | "d";
  u?: Record<string, string>;
  k?: ClickKey[];
  r?: string;
  p: string;
  b?: string;
  sb?: 1;
  rv?: 1;
}

interface CState {
  v: 1;
  c: number;
  f: CTouch;
  /** Last touch, or "f" when it is identical to the first touch (the common first-landing case). */
  l?: CTouch | "f";
  k?: Record<string, [string, number]>;
  m: "f" | "u";
  pa?: number;
  hf?: string;
  /** bound device (full consent only) */
  bd?: string;
  /** consent fingerprint */
  ck?: string;
}

function compactTouch(t: Touch): CTouch {
  const o: CTouch = { a: t.at, t: TYPE_TO_CODE[t.type], p: t.landingPath };
  if (t.utm) {
    const u: Record<string, string> = {};
    for (const f of UTM_FIELDS) if (t.utm[f] !== undefined) u[UTM_TO_CODE[f]] = t.utm[f]!;
    o.u = u;
  }
  if (t.clickKeys.length) o.k = [...t.clickKeys];
  if (t.referrerHost) o.r = t.referrerHost;
  if (t.inAppBrowser) o.b = t.inAppBrowser;
  if (t.seenBefore) o.sb = 1;
  if (t.recovered) o.rv = 1;
  return o;
}

function compactState(s: AttributionState): CState {
  const o: CState = { v: 1, c: s.createdAt, f: compactTouch(s.firstTouch), m: s.consentMode === "full" ? "f" : "u" };
  if (s.lastTouch) {
    const l = compactTouch(s.lastTouch);
    o.l = JSON.stringify(l) === JSON.stringify(o.f) ? "f" : l;
  }
  // Canonical keys first, then anything else verbatim so the decoder (not the encoder) rejects it.
  const ids = s.clickIds as Record<string, { v: string; ts: number } | undefined>;
  const keys = [...CLICK_KEYS.filter((k) => ids[k]), ...Object.keys(ids).filter((k) => ids[k] && !isClickKey(k))];
  if (keys.length) {
    const k: Record<string, [string, number]> = {};
    for (const key of keys) k[key] = [ids[key]!.v, ids[key]!.ts];
    o.k = k;
  }
  if (s.persistedAt !== null) o.pa = s.persistedAt;
  if (s.handoffFrom) o.hf = s.handoffFrom;
  if (s.boundDevice) o.bd = s.boundDevice;
  if (s.consentKey) o.ck = s.consentKey;
  return o;
}

export function encodeStatePayload(state: AttributionState): string {
  return bytesToBase64url(utf8(JSON.stringify(compactState(state))));
}

export function attrSigningInput(payload: string): string {
  return `oa_attr.${ATTR_FORMAT_VERSION}.${payload}`;
}

export function formatAttrCookieValue(payload: string, tag: string): string {
  return `${ATTR_FORMAT_VERSION}.${payload}.${tag}`;
}

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function splitAttrCookieValue(value: string | null | undefined): { payload: string; tag: string } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ATTR_VALUE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== ATTR_FORMAT_VERSION) return null;
  const [, payload, tag] = parts as [string, string, string];
  if (!SEGMENT_RE.test(payload) || !SEGMENT_RE.test(tag)) return null;
  return { payload, tag };
}

// ---- validation ------------------------------------------------------------------------

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
/** Own-property lookup: "constructor", "__proto__" or "toString" must never resolve to an inherited member. */
const own = <T>(table: Record<string, T>, key: unknown): T | undefined =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
/** consentFingerprint(): region, explicit, GPC, four signals, then "o" when a sale/sharing opt-out is recorded. */
export const CONSENT_KEY_RE = /^[rux][01][01][gd-]{4}o?$/;
const PLAUSIBLE_MS = 1_500_000_000_000; // 2017-07; anything earlier is not a real timestamp here
const HOST_RE = SAFE_HOST_RE;
const PATH_RE = /^\/[\x21-\x7E]*$/;
const IAB_RE = /^[a-z-]{1,32}$/;
// Mirrors parse.ts cleanText output: no controls, <= UTM_MAX_LEN code points.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

function validClickValue(key: ClickKey, v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= (CLICK_MAX_LEN[key] ?? CLICK_MAX_LEN_DEFAULT) && CLICK_VALUE_RE.test(v);
}

function isClickKey(k: string): k is ClickKey {
  return (CLICK_KEYS as readonly string[]).includes(k);
}

function decodeUtm(u: unknown): Utm | null | undefined {
  if (u === undefined) return null;
  if (!u || typeof u !== "object" || Array.isArray(u)) return undefined;
  const out: Utm = {};
  let any = false;
  for (const [code, v] of Object.entries(u as Record<string, unknown>)) {
    const field = own(CODE_TO_UTM, code);
    if (!field || typeof v !== "string" || !v || CONTROL_RE.test(v) || Array.from(v).length > UTM_MAX_LEN) return undefined;
    out[field] = v;
    any = true;
  }
  return any ? out : undefined;
}

function decodeTouch(raw: unknown, lo: number, hi: number): Touch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Partial<CTouch> & Record<string, unknown>;
  if (!isInt(t.a) || t.a < lo || t.a > hi) return null;
  const type = own(CODE_TO_TYPE, t.t);
  if (!type) return null;
  const utm = decodeUtm(t.u);
  if (utm === undefined) return null;
  let clickKeys: ClickKey[] = [];
  if (t.k !== undefined) {
    if (!Array.isArray(t.k) || t.k.length === 0 || new Set(t.k).size !== t.k.length) return null;
    if (!t.k.every((k) => typeof k === "string" && isClickKey(k))) return null;
    clickKeys = CLICK_KEYS.filter((k) => (t.k as string[]).includes(k));
  }
  if (t.r !== undefined && (typeof t.r !== "string" || t.r.length > HOST_MAX_LEN || !HOST_RE.test(t.r))) return null;
  if (typeof t.p !== "string" || t.p.length > PATH_MAX_LEN || !PATH_RE.test(t.p)) return null;
  if (t.b !== undefined && (typeof t.b !== "string" || !IAB_RE.test(t.b))) return null;
  if (t.sb !== undefined && t.sb !== 1) return null;
  if (t.rv !== undefined && t.rv !== 1) return null;
  if (type === "paid" && clickKeys.length === 0) return null;
  return {
    at: t.a,
    type,
    utm,
    clickKeys,
    referrerHost: t.r ?? null,
    landingPath: t.p,
    inAppBrowser: t.b ?? null,
    seenBefore: t.sb === 1,
    recovered: t.rv === 1,
  };
}

/**
 * Decodes and validates a payload. Returns null when malformed, when created in the future,
 * or when older than the 13-month lifetime.
 */
export function decodeStatePayload(payload: string, now: number): AttributionState | null {
  if (payload.length > MAX_ATTR_VALUE_LENGTH) return null;
  const bytes = base64urlToBytes(payload);
  if (!bytes) return null;
  const text = fromUtf8(bytes);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Partial<CState> & Record<string, unknown>;
  if (s.v !== 1) return null;
  if (!isInt(s.c) || s.c < PLAUSIBLE_MS || s.c > now + TTL.skewMs || now - s.c > TTL.attrMs) return null;
  const lo = s.c - TTL.skewMs;
  const hi = now + TTL.skewMs;
  const firstTouch = decodeTouch(s.f, lo, hi);
  if (!firstTouch) return null;
  let lastTouch: Touch | null = null;
  if (s.l !== undefined) {
    lastTouch = s.l === "f" ? { ...firstTouch, utm: firstTouch.utm ? { ...firstTouch.utm } : null, clickKeys: [...firstTouch.clickKeys] } : decodeTouch(s.l, lo, hi);
    if (!lastTouch || lastTouch.type === "direct") return null;
  }
  if (s.m !== "f" && s.m !== "u") return null;
  const clickIds: ClickIds = {};
  if (s.k !== undefined) {
    if (!s.k || typeof s.k !== "object" || Array.isArray(s.k)) return null;
    for (const [key, entry] of Object.entries(s.k)) {
      if (!isClickKey(key) || !Array.isArray(entry) || entry.length !== 2) return null;
      const [v, ts] = entry as [unknown, unknown];
      if (!validClickValue(key, v) || !isInt(ts) || ts < PLAUSIBLE_MS || ts > hi) return null;
      clickIds[key] = { v, ts };
    }
    if (Object.keys(clickIds).length === 0) return null;
    if (s.m === "u") return null; // utm-only records never carry identifiers
  }
  if (s.pa !== undefined && (!isInt(s.pa) || s.pa < PLAUSIBLE_MS || s.pa > hi)) return null;
  if (s.hf !== undefined && (typeof s.hf !== "string" || !DEVICE_ID_RE.test(s.hf))) return null;
  if (s.bd !== undefined && (typeof s.bd !== "string" || !DEVICE_ID_RE.test(s.bd) || s.m !== "f")) return null;
  if (s.ck !== undefined && (typeof s.ck !== "string" || !CONSENT_KEY_RE.test(s.ck))) return null;
  const extra: Pick<AttributionState, "boundDevice" | "consentKey"> = {};
  if (s.bd !== undefined) extra.boundDevice = s.bd;
  if (s.ck !== undefined) extra.consentKey = s.ck;
  return {
    ...extra,
    createdAt: s.c,
    firstTouch,
    lastTouch,
    clickIds,
    consentMode: s.m === "f" ? "full" : "utm-only",
    persistedAt: s.pa ?? null,
    handoffFrom: s.hf ?? null,
  };
}
