// The click-id vault and the client-readable cookie formats derived from it.
import { utf8Length } from "./base64url.js";
import {
  CLICK_KEYS,
  CLICK_MAX_LEN,
  CLICK_MAX_LEN_DEFAULT,
  CLICK_VALUE_RE,
  COOKIE,
  AD_CLIDS_PAIR_BUDGET,
  MAX_PRESERVED_KEYS,
  META_FBCLID_RE,
  OA_AD_CLIDS_VALUE_RE,
  TTL,
} from "./constants.js";
import type { ClickKey } from "./constants.js";
import type { ClickIdEntry, ClickIds } from "./model.js";

/** Where a candidate value came from; on equal timestamps the higher rank is applied last (wins). */
export const RANK = { cookie: 1, vault: 2, referrer: 3, url: 4 } as const;

export interface ClickCandidate {
  key: ClickKey;
  v: string;
  ts: number;
  rank: number;
}

export function isValidClickValue(key: ClickKey, v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= (CLICK_MAX_LEN[key] ?? CLICK_MAX_LEN_DEFAULT) && CLICK_VALUE_RE.test(v);
}

/**
 * Resolves one entry per platform by replaying observations in time order with the rule the
 * platforms themselves use (Meta `maybeUpdatePayload`, TikTok `eB`): a value equal to the
 * current one keeps the current (original) timestamp; a different value replaces it. The
 * result is independent of input order. Entries older than `maxAgeMs` are dropped.
 */
export function resolveClickIds(candidates: readonly ClickCandidate[], now: number, maxAgeMs: number = TTL.adClidsMs): ClickIds {
  const byKey = new Map<ClickKey, ClickCandidate[]>();
  for (const c of candidates) {
    if (!isValidClickValue(c.key, c.v) || !Number.isFinite(c.ts)) continue;
    const ts = Math.min(Math.trunc(c.ts), now); // client clocks may run ahead
    if (now - ts >= maxAgeMs) continue; // expired observations are forgotten, not "original"
    const list = byKey.get(c.key) ?? [];
    list.push({ ...c, ts });
    byKey.set(c.key, list);
  }
  const out: ClickIds = {};
  for (const key of CLICK_KEYS) {
    const list = byKey.get(key);
    if (!list) continue;
    list.sort((a, b) => a.ts - b.ts || a.rank - b.rank || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
    let cur: ClickCandidate | undefined;
    for (const c of list) if (!cur || c.v !== cur.v) cur = c;
    if (cur) out[key] = { v: cur.v, ts: cur.ts };
  }
  return out;
}

export function clickIdsEqual(a: ClickIds, b: ClickIds): boolean {
  for (const key of CLICK_KEYS) {
    const x = a[key];
    const y = b[key];
    if (!x !== !y) return false;
    if (x && y && (x.v !== y.v || x.ts !== y.ts)) return false;
  }
  return true;
}

export function vaultCandidates(ids: ClickIds, rank: number): ClickCandidate[] {
  return CLICK_KEYS.filter((k) => ids[k]).map((k) => ({ key: k, v: ids[k]!.v, ts: ids[k]!.ts, rank }));
}

// ---- oa_ad_clids (OpenArt's existing client vault) ----------------------------------------

const SAFE_JSON_KEY = /^[A-Za-z0-9_]{1,64}$/;
/** Never carried over: they would re-parent the object instead of becoming a key. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isClickKey = (k: string): k is ClickKey => (CLICK_KEYS as readonly string[]).includes(k);

export interface ParsedAdClids {
  /** Entries for keys this package manages. */
  known: ClickIds;
  /** Entries for keys it does not manage, preserved verbatim when rewriting. */
  unknown: Array<[string, ClickIdEntry]>;
}

/** Parses the cookie exactly like OpenArt's readers do: decodeURIComponent, JSON, {v:string, ts:number}. */
export function parseAdClidsCookie(raw: string | undefined): ParsedAdClids | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const known: ClickIds = {};
  const unknown: Array<[string, ClickIdEntry]> = [];
  for (const [k, e] of Object.entries(obj as Record<string, unknown>)) {
    if (!e || typeof e !== "object") continue;
    const { v, ts } = e as { v?: unknown; ts?: unknown };
    if (typeof v !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (isClickKey(k)) {
      if (isValidClickValue(k, v)) known[k] = { v, ts };
    } else if (SAFE_JSON_KEY.test(k) && !FORBIDDEN_KEYS.has(k) && OA_AD_CLIDS_VALUE_RE.test(v)) {
      unknown.push([k, { v, ts }]);
    }
  }
  return { known, unknown };
}

/** Fill order when the cookie would exceed the size budget: the Suite's 4 keys, the Astro shim's 2, then the rest. */
const AD_CLIDS_PRIORITY: readonly ClickKey[] = [
  "gclid", "fbclid", "msclkid", "ttclid", "gbraid", "wbraid",
  ...CLICK_KEYS.filter((k) => !["gclid", "fbclid", "msclkid", "ttclid", "gbraid", "wbraid"].includes(k)),
];

export interface AdClidsCookie {
  /** encodeURIComponent(JSON) — the format both OpenArt writers use. */
  value: string;
  entries: Array<[string, ClickIdEntry]>;
  newestTs: number;
}

/**
 * Builds the server-set `oa_ad_clids`: every vault entry the client regex accepts, plus
 * preserved unknown keys, all younger than 90 days, within the cookie size budget.
 */
export function buildAdClidsCookie(ids: ClickIds, preserved: ReadonlyArray<[string, ClickIdEntry]>, now: number): AdClidsCookie | null {
  const fresh = (e: ClickIdEntry) => now - e.ts < TTL.adClidsMs;
  const pool = new Map<string, ClickIdEntry>();
  for (const k of AD_CLIDS_PRIORITY) {
    const e = ids[k];
    if (e && fresh(e) && OA_AD_CLIDS_VALUE_RE.test(e.v)) pool.set(k, e);
  }
  let kept = 0;
  for (const [k, e] of preserved) {
    if (pool.has(k) || kept >= MAX_PRESERVED_KEYS) continue;
    const clamped = { v: e.v, ts: Math.min(e.ts, now) }; // never let a client timestamp drive Max-Age
    if (!fresh(clamped)) continue;
    pool.set(k, clamped);
    kept++;
  }

  const chosen = new Map<string, ClickIdEntry>();
  for (const [k, e] of pool) {
    chosen.set(k, e);
    if (utf8Length(`${COOKIE.adClids}=${encodeAdClids(ordered(chosen))}`) > AD_CLIDS_PAIR_BUDGET) chosen.delete(k);
  }
  if (chosen.size === 0) return null;
  const entries = ordered(chosen);
  return { value: encodeAdClids(entries), entries, newestTs: Math.max(...entries.map(([, e]) => e.ts)) };
}

function ordered(m: Map<string, ClickIdEntry>): Array<[string, ClickIdEntry]> {
  const known = CLICK_KEYS.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as [string, ClickIdEntry]);
  const rest = [...m].filter(([k]) => !isClickKey(k));
  return [...known, ...rest];
}

function encodeAdClids(entries: ReadonlyArray<[string, ClickIdEntry]>): string {
  const obj: Record<string, ClickIdEntry> = Object.create(null) as Record<string, ClickIdEntry>;
  for (const [k, e] of entries) obj[k] = { v: e.v, ts: e.ts };
  return encodeURIComponent(JSON.stringify(obj));
}

/** Same entries (as a set) as what the browser already holds? */
export function sameAdClids(entries: ReadonlyArray<[string, ClickIdEntry]>, current: ParsedAdClids | null): boolean {
  if (!current) return false;
  const have = new Map<string, ClickIdEntry>([...CLICK_KEYS.filter((k) => current.known[k]).map((k) => [k, current.known[k]!] as [string, ClickIdEntry]), ...current.unknown]);
  if (have.size !== entries.length) return false;
  return entries.every(([k, e]) => {
    const h = have.get(k);
    return !!h && h.v === e.v && h.ts === e.ts;
  });
}

// ---- _fbc (Meta) --------------------------------------------------------------------------

export interface Fbc {
  subdomainIndex: number;
  creationTime: number;
  payload: string;
  appendix: string | null;
}

const FBC_APPENDIX = new Set(["AQ", "Ag", "Aw", "BA", "BQ", "Bg"]);

/** `fb.1.<ms>.<fbclid>` with dots escaped as `__DOT__`, as the pixel packs it (subdomain index 1 = .openart.ai). */
export function packFbc(fbclid: string, ts: number): string {
  return `fb.1.${ts}.${fbclid.replace(/\./g, "__DOT__")}`;
}

/** Meta's unpack: 4 or 5 dot-separated parts, "fb" prefix, integer index and time, optional appendix. */
export function unpackFbc(raw: string | undefined): Fbc | null {
  if (!raw) return null;
  let s = raw;
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  const parts = s.split(".");
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [ver, idx, ct, payload, appendix] = parts as [string, string, string, string, string | undefined];
  if (ver !== "fb" || !/^\d+$/.test(idx) || !/^\d+$/.test(ct) || !payload) return null;
  if (appendix !== undefined && !(/^[A-Za-z0-9_-]{8}$/.test(appendix) || FBC_APPENDIX.has(appendix))) return null;
  const fbclid = payload.replace(/__DOT__/g, ".");
  if (!META_FBCLID_RE.test(fbclid)) return null;
  return { subdomainIndex: Number(idx), creationTime: Number(ct), payload: fbclid, appendix: appendix ?? null };
}

/** Re-serializes a parsed _fbc from its validated parts. */
export function formatFbc(f: Fbc): string {
  return `fb.${f.subdomainIndex}.${f.creationTime}.${f.payload.replace(/\./g, "__DOT__")}${f.appendix ? `.${f.appendix}` : ""}`;
}

export function isMetaFbclid(v: string): boolean {
  return META_FBCLID_RE.test(v);
}

// ---- ttclid (TikTok) ----------------------------------------------------------------------

/** TikTok pixel `eq`: `<clickId>.<13-digit ms>`; without a valid suffix the whole value is the click id. */
export function parseTtclidCookie(raw: string): { clickId: string; observedAt: number | null } {
  const e = raw.lastIndexOf(".");
  const suffix = raw.slice(e + 1);
  return e <= 0 || !/^\d{13}$/.test(suffix) ? { clickId: raw, observedAt: null } : { clickId: raw.slice(0, e), observedAt: Number(suffix) };
}

export function formatTtclidCookie(clickId: string, ts: number): string | null {
  const t = String(ts);
  return /^\d{13}$/.test(t) ? `${clickId}.${t}` : null;
}
