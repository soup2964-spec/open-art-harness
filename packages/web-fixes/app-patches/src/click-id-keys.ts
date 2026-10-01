/**
 * Canonical ad click-ID contract for all three OpenArt front-ends.
 *
 * Replaces the 4-key list in Suite module 162070
 * (openart.ai/suite/_next/static/chunks/91db8069961c7577.js):
 *   let n=["gclid","fbclid","msclkid","ttclid"],r="oa_ad_clids",i=/^[A-Za-z0-9._-]{1,512}$/
 * That list is used by readAdClickIds / buildMigrationPayload / captureAdClickIds /
 * readGclid, so gbraid, wbraid, rdt_cid, twclid, li_fat_id and oppref never reach
 * POST /api/user/ad-click-ids, and an app-side rewrite of `oa_ad_clids` deletes a
 * gbraid stored by the Astro shim (live proof: crawl/teardown2/T2c_gbraid_then_app_fbclid.json).
 *
 * Storage format is unchanged: cookie + localStorage `oa_ad_clids` =
 * JSON {<key>: {v: string, ts: epochMs}} (cookie value URI-encoded, 90 days,
 * Domain=.openart.ai). Existing readers keep working; they just ignore new keys.
 */

export const AD_CLICK_ID_KEYS = [
  'gclid', // Google Ads (web)
  'gbraid', // Google Ads (iOS app -> web)
  'wbraid', // Google Ads (web -> app / iOS)
  'fbclid', // Meta
  'msclkid', // Microsoft Ads
  'ttclid', // TikTok
  'rdt_cid', // Reddit
  'twclid', // X
  'li_fat_id', // LinkedIn (enhanced conversion tracking)
  'oppref', // OpenAI (ChatGPT) Ads
] as const;

export type ClickIdKey = (typeof AD_CLICK_ID_KEYS)[number];

/** The key list shipped today in Suite module 162070 (kept for regression tests / docs). */
export const SUITE_V1_CLICK_ID_KEYS = ['gclid', 'fbclid', 'msclkid', 'ttclid'] as const satisfies readonly ClickIdKey[];

/** Same validation the Suite and the Astro shim apply today. */
export const CLICK_ID_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,512}$/;

export const OA_AD_CLIDS_KEY = 'oa_ad_clids';
/** 90 days, as today (Suite `Max-Age=7776000`, shim `max-age=7776000`). */
export const OA_AD_CLIDS_MAX_AGE_SECONDS = 7_776_000;
/** Window the Suite uses when it reports click ids in `conversion_reported` (12096e5 ms = 14 days). */
export const CONVERSION_REPORT_WINDOW_MS = 1_209_600_000;

export interface ClickIdEntry {
  v: string;
  ts: number;
}

export type ClickIdStore = Partial<Record<ClickIdKey, ClickIdEntry>>;

const KEY_SET: ReadonlySet<string> = new Set(AD_CLICK_ID_KEYS);

export function isClickIdKey(key: string): key is ClickIdKey {
  return KEY_SET.has(key);
}

export function isValidClickIdValue(value: unknown): value is string {
  return typeof value === 'string' && CLICK_ID_VALUE_PATTERN.test(value);
}

function isValidEntry(entry: unknown): entry is ClickIdEntry {
  if (!entry || typeof entry !== 'object') return false;
  const { v, ts } = entry as { v?: unknown; ts?: unknown };
  return isValidClickIdValue(v) && typeof ts === 'number' && Number.isFinite(ts);
}

/**
 * Parse a serialized `oa_ad_clids` value (already URI-decoded). Mirrors Suite `s()`:
 * invalid JSON or invalid entries are dropped, never thrown.
 */
export function parseClickIdStore(raw: string | null | undefined): ClickIdStore {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ClickIdStore = {};
    for (const key of AD_CLICK_ID_KEYS) {
      const entry = (parsed as Record<string, unknown>)[key];
      if (isValidEntry(entry)) out[key] = { v: entry.v, ts: entry.ts };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * One entry per key under the first-seen rule shared by the click-ID shim, `captureAdClickIds`,
 * the edge-attribution Worker (`resolveClickIds`) and the platforms themselves (Meta
 * `maybeUpdatePayload`, TikTok `eB`): observations are replayed in time order, a value equal to
 * the current one keeps the current (first-seen) `ts`, and a different value replaces it. So an
 * equal value keeps its earliest `ts` and a changed value takes the newer entry, whatever the
 * order of the stores. On equal `ts` with different values, the earlier store wins.
 */
export function mergeClickIdStores(...stores: ClickIdStore[]): ClickIdStore {
  const out: ClickIdStore = {};
  for (const key of AD_CLICK_ID_KEYS) {
    const observed = stores
      .map((store, index) => ({ entry: store[key], index }))
      .filter((o): o is { entry: ClickIdEntry; index: number } => !!o.entry)
      .sort((a, b) => a.entry.ts - b.entry.ts || b.index - a.index);
    let current: ClickIdEntry | undefined;
    for (const { entry } of observed) if (!current || entry.v !== current.v) current = entry;
    if (current) out[key] = { v: current.v, ts: current.ts };
  }
  return out;
}

/**
 * Apply a fresh observation (a click id in the current URL) to what is stored: the same value
 * keeps its first-seen entry, a different value replaces it. `current` may be anything read from
 * storage; only a valid entry can be kept.
 */
export function withIncomingClickId(current: unknown, incoming: ClickIdEntry): ClickIdEntry {
  return isValidEntry(current) && current.v === incoming.v ? { v: current.v, ts: current.ts } : incoming;
}

/** Keep only entries observed within `maxAgeMs` of `now` (Suite `o(e)` with a window). */
export function filterByAge(store: ClickIdStore, maxAgeMs: number, now: number): ClickIdStore {
  const cutoff = now - maxAgeMs;
  const out: ClickIdStore = {};
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = store[key];
    if (entry && entry.ts >= cutoff) out[key] = entry;
  }
  return out;
}

/** Click ids present in a query string (`?gclid=…`), stamped with `now`. */
export function clickIdsFromSearch(search: string, now: number): ClickIdStore {
  const params = new URLSearchParams(search);
  const out: ClickIdStore = {};
  for (const key of AD_CLICK_ID_KEYS) {
    const value = params.get(key);
    if (isValidClickIdValue(value)) out[key] = { v: value, ts: now };
  }
  return out;
}

/** Serialize in canonical key order. */
export function serializeClickIdStore(store: ClickIdStore): string {
  const ordered: Record<string, ClickIdEntry> = {};
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = store[key];
    if (entry) ordered[key] = { v: entry.v, ts: entry.ts };
  }
  return JSON.stringify(ordered);
}

/** Read one cookie from a `document.cookie` string (value URI-decoded, never throws). */
export function readCookie(cookieString: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return undefined;
  const value = match[1] ?? '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface ClickIdEnvironment {
  cookie: string;
  localStorage?: Pick<Storage, 'getItem'> | null;
}

function safeGetItem(storage: ClickIdEnvironment['localStorage'], key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

/**
 * Drop-in replacement for Suite `readAdClickIds(maxAgeMs?)`: merges cookie and
 * localStorage (newest wins) for ALL canonical keys.
 */
export function readAdClickIds(env: ClickIdEnvironment, maxAgeMs?: number, now: number = Date.now()): ClickIdStore {
  const merged = mergeClickIdStores(
    parseClickIdStore(readCookie(env.cookie, OA_AD_CLIDS_KEY)),
    parseClickIdStore(safeGetItem(env.localStorage, OA_AD_CLIDS_KEY)),
  );
  return maxAgeMs === undefined ? merged : filterByAge(merged, maxAgeMs, now);
}

export interface CookieWriteOptions {
  /** `.openart.ai` in production; omit for host-only cookies (local dev). */
  domain?: string;
  secure: boolean;
  maxAgeSeconds: number;
}

/** `document.cookie` assignment string, same attribute set the Suite uses today. */
export function buildCookie(name: string, value: string, opts: CookieWriteOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${opts.maxAgeSeconds}`, 'Path=/'];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  parts.push('SameSite=Lax');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export interface CaptureTarget {
  location: Pick<Location, 'search'>;
  document: { cookie: string };
  localStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * Drop-in replacement for Suite `captureAdClickIds()`.
 *
 * Differences from the shipped version:
 *  - the rewrite merges ALL canonical keys, so landing on the app with `?fbclid=` no longer
 *    deletes a stored `gbraid` (T2c);
 *  - a click id already stored with the same value keeps its first-seen `ts` (same rule as the
 *    click-ID shim and the edge Worker); only a changed value gets `now`.
 * Returns the store that was written, or `null` when the URL carried no click id.
 */
export function captureAdClickIds(
  target: CaptureTarget,
  opts: { now?: number; domain?: string; secure?: boolean } = {},
): ClickIdStore | null {
  const now = opts.now ?? Date.now();
  const incoming = clickIdsFromSearch(target.location.search, now);
  if (Object.keys(incoming).length === 0) return null;
  const existing = readAdClickIds({ cookie: target.document.cookie, localStorage: target.localStorage ?? null });
  const next: ClickIdStore = { ...existing };
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = incoming[key];
    if (entry) next[key] = withIncomingClickId(existing[key], entry);
  }
  const serialized = serializeClickIdStore(next);
  try {
    target.localStorage?.setItem(OA_AD_CLIDS_KEY, serialized);
  } catch {
    // storage full / blocked: the cookie below still carries the ids
  }
  try {
    target.document.cookie = buildCookie(OA_AD_CLIDS_KEY, serialized, {
      domain: opts.domain ?? '.openart.ai',
      secure: opts.secure ?? true,
      maxAgeSeconds: OA_AD_CLIDS_MAX_AGE_SECONDS,
    });
  } catch {
    // cookies disabled
  }
  return next;
}

export interface MigrationPayload {
  keys: ClickIdKey[];
  /** `{gclid, gclid_created_at, gbraid, gbraid_created_at, …}` — same shape as today, more keys. */
  payload: Record<string, string | number>;
}

/**
 * Drop-in replacement for Suite `buildMigrationPayload()` (POST /api/user/ad-click-ids).
 * The backend handler must accept the six new `<key>` / `<key>_created_at` pairs
 * (see PATCHES.md: deploy the backend change first if it validates strictly).
 */
export function buildMigrationPayload(store: ClickIdStore): MigrationPayload {
  const keys: ClickIdKey[] = [];
  const payload: Record<string, string | number> = {};
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = store[key];
    if (!entry) continue;
    keys.push(key);
    payload[key] = entry.v;
    payload[`${key}_created_at`] = entry.ts;
  }
  return { keys, payload };
}

export interface HiddenInput {
  name: string;
  value: string;
}

/**
 * Hidden inputs for the Suite `SubscriptionForm` (POST /api/stripe/subscription).
 * Today the form posts only `gclid` (Suite module 107154 `GclidHiddenInput`).
 * Every key is always rendered (empty string when absent, like GclidHiddenInput),
 * plus `<key>_created_at` and the Meta `fbc` string (from the `_fbc` cookie) so the
 * server can attach them to the Stripe Checkout Session for server-side conversions.
 */
export function checkoutHiddenInputs(store: ClickIdStore, extras: { fbc?: string | undefined } = {}): HiddenInput[] {
  const inputs: HiddenInput[] = [];
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = store[key];
    inputs.push({ name: key, value: entry ? entry.v : '' });
    inputs.push({ name: `${key}_created_at`, value: entry ? String(entry.ts) : '' });
  }
  inputs.push({ name: 'fbc', value: extras.fbc && isValidFbc(extras.fbc) ? extras.fbc : '' });
  return inputs;
}

/** Backwards-compatible `readGclid()`. */
export function readGclid(store: ClickIdStore): string {
  return store.gclid?.v ?? '';
}

/** Meta click cookie format `fb.<subdomainIndex>.<creationTimeMs>.<fbclid>` (Meta docs: fbp-and-fbc). */
export const FBC_PATTERN = /^fb\.[0-9]\.[0-9]{10,16}\.[A-Za-z0-9._-]{1,512}$/;

export function isValidFbc(value: string): boolean {
  return FBC_PATTERN.test(value);
}

/** Build `_fbc` exactly as Meta documents it; subdomainIndex 1 = cookie set on `openart.ai`. */
export function buildFbc(fbclid: string, creationTimeMs: number): string {
  if (!isValidClickIdValue(fbclid)) throw new Error('invalid fbclid');
  if (!Number.isFinite(creationTimeMs) || creationTimeMs <= 0) throw new Error('invalid creation time');
  return `fb.1.${Math.floor(creationTimeMs)}.${fbclid}`;
}

/** The fbclid component of an `_fbc` value (case preserved: Meta click ids are case-sensitive). */
export function fbclidFromFbc(fbc: string | undefined): string | undefined {
  if (!fbc || !isValidFbc(fbc)) return undefined;
  const parts = fbc.split('.');
  return parts.slice(3).join('.');
}
