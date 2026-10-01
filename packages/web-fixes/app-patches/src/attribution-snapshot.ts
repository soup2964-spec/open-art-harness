/**
 * Read-side view of first-party attribution, used by the in-app-browser handoff and the
 * HubSpot form fill.
 *
 * Priority per value: OpenArt's own stores first (`oa_ad_clids`, `oa_utm`, both written by the
 * click-ID shim and the edge-attribution Worker), then vendor first-party cookies that already
 * exist on openart.ai today (crawl/teardown2/T1a, T2a/b, T3a/b), then Amplitude's campaign
 * cookie `AMP_MKTG_<key>` for visitors who landed before the new shim shipped.
 */
import {
  AD_CLICK_ID_KEYS,
  CLICK_ID_VALUE_PATTERN,
  fbclidFromFbc,
  isValidFbc,
  readAdClickIds,
  readCookie,
  type ClickIdKey,
  type ClickIdStore,
} from './click-id-keys';

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type UtmSet = Partial<Record<UtmKey, string>>;

export const OA_UTM_KEY = 'oa_utm';
/** Amplitude campaign cookie: AMP_MKTG_<first 10 chars of the prod API key 3e2fda7a5cbcc867099904a028486db4>. */
export const AMPLITUDE_MKTG_COOKIE = 'AMP_MKTG_3e2fda7a5c';

export interface AttributionEnv {
  cookie: string;
  localStorage?: Pick<Storage, 'getItem'> | null;
}

export interface AttributionSnapshot {
  clickIds: Partial<Record<ClickIdKey, string>>;
  /** Where each click id came from (for debugging / telemetry). */
  clickIdSources: Partial<Record<ClickIdKey, 'oa_ad_clids' | 'vendor_cookie' | 'amplitude'>>;
  utm: UtmSet;
  utmSource: 'oa_utm' | 'amplitude' | 'none';
  /** Meta `_fbc` cookie when well-formed. */
  fbc?: string;
}

function safeGetItem(storage: AttributionEnv['localStorage'], key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** A UTM value as every web fix stores it: control characters stripped, trimmed, at most 256 characters. */
export function cleanUtm(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return v && v.length <= 256 ? v : undefined;
}

function utmFromObject(obj: unknown): UtmSet {
  const out: UtmSet = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of UTM_KEYS) {
    const v = cleanUtm((obj as Record<string, unknown>)[key]);
    if (v) out[key] = v;
  }
  return out;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Amplitude Browser SDK stores campaign params as base64(encodeURIComponent(JSON)). */
export function decodeAmplitudeCampaignCookie(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    // keep raw only
  }
  for (const candidate of candidates) {
    try {
      const decoded = decodeURIComponent(atob(candidate));
      const parsed: unknown = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try next form
    }
  }
  return undefined;
}

/** oa_utm (cookie, then localStorage), else Amplitude's campaign cookie. */
export function readUtm(env: AttributionEnv): { utm: UtmSet; source: AttributionSnapshot['utmSource'] } {
  for (const raw of [readCookie(env.cookie, OA_UTM_KEY), safeGetItem(env.localStorage, OA_UTM_KEY)]) {
    const utm = utmFromObject(parseJson(raw));
    if (Object.keys(utm).length) return { utm, source: 'oa_utm' };
  }
  const amp = utmFromObject(decodeAmplitudeCampaignCookie(readCookie(env.cookie, AMPLITUDE_MKTG_COOKIE)));
  if (Object.keys(amp).length) return { utm: amp, source: 'amplitude' };
  return { utm: {}, source: 'none' };
}

const valid = (v: string | undefined): string | undefined => (v && CLICK_ID_VALUE_PATTERN.test(v) ? v : undefined);

/** Best-effort parsers for vendor first-party cookies observed on openart.ai. */
export const VENDOR_COOKIE_READERS: ReadonlyArray<{ key: ClickIdKey; cookie: string; parse: (raw: string) => string | undefined }> = [
  // Google conversion linker: _gcl_aw = GCL.<ts>.<gclid>, _gcl_gb = GCL.<ts>.<wbraid> (T1a, T2b)
  { key: 'gclid', cookie: '_gcl_aw', parse: (raw) => valid(raw.split('.').slice(2).join('.')) },
  { key: 'wbraid', cookie: '_gcl_gb', parse: (raw) => valid(raw.split('.').slice(2).join('.')) },
  // Meta _fbc = fb.1.<ms>.<fbclid>
  { key: 'fbclid', cookie: '_fbc', parse: (raw) => valid(fbclidFromFbc(raw)) },
  // Microsoft UET: _uetmsclkid = _uet<msclkid> (T3)
  { key: 'msclkid', cookie: '_uetmsclkid', parse: (raw) => valid(raw.replace(/^_uet/, '')) },
  // TikTok pixel / edge Worker: ttclid = <ttclid>.<ms>
  { key: 'ttclid', cookie: 'ttclid', parse: (raw) => valid(raw.replace(/\.\d{10,13}$/, '')) },
  // Reddit pixel: _rdt_cid (T3)
  { key: 'rdt_cid', cookie: '_rdt_cid', parse: (raw) => valid(raw) },
  // LinkedIn Insight Tag: li_fat_id (T3, 30 days)
  { key: 'li_fat_id', cookie: 'li_fat_id', parse: (raw) => valid(raw) },
  // X pixel: _twclid JSON (T3) — field name inferred, parsed defensively
  {
    key: 'twclid',
    cookie: '_twclid',
    parse: (raw) => {
      const parsed = parseJson(raw);
      if (parsed && typeof parsed === 'object') return valid((parsed as { twclid?: string }).twclid);
      return valid(raw);
    },
  },
  // OpenAI Ads SDK: __oppref (T3b)
  { key: 'oppref', cookie: '__oppref', parse: (raw) => valid(raw) },
];

export function readAttributionSnapshot(env: AttributionEnv): AttributionSnapshot {
  const store: ClickIdStore = readAdClickIds(env);
  const clickIds: AttributionSnapshot['clickIds'] = {};
  const clickIdSources: AttributionSnapshot['clickIdSources'] = {};
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = store[key];
    if (entry) {
      clickIds[key] = entry.v;
      clickIdSources[key] = 'oa_ad_clids';
    }
  }
  for (const reader of VENDOR_COOKIE_READERS) {
    if (clickIds[reader.key]) continue;
    const raw = readCookie(env.cookie, reader.cookie);
    const value = raw ? reader.parse(raw) : undefined;
    if (value) {
      clickIds[reader.key] = value;
      clickIdSources[reader.key] = 'vendor_cookie';
    }
  }
  const amp = decodeAmplitudeCampaignCookie(readCookie(env.cookie, AMPLITUDE_MKTG_COOKIE));
  if (amp) {
    for (const key of AD_CLICK_ID_KEYS) {
      if (clickIds[key]) continue;
      const value = valid(typeof amp[key] === 'string' ? (amp[key] as string) : undefined);
      if (value) {
        clickIds[key] = value;
        clickIdSources[key] = 'amplitude';
      }
    }
  }
  const { utm, source } = readUtm(env);
  const fbcRaw = readCookie(env.cookie, '_fbc');
  const snapshot: AttributionSnapshot = { clickIds, clickIdSources, utm, utmSource: source };
  if (fbcRaw && isValidFbc(fbcRaw)) snapshot.fbc = fbcRaw;
  return snapshot;
}
