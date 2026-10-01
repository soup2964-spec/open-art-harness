// Per-journey, per-platform click-ID propagation: was the synthetic click ID carried in the
// platform's DEDICATED attribution field on its attempted hits (not merely inside a page-URL
// field), and was it stored first-party?
import type { CookieLite, DecodedHit, JourneyObservation, Platform, StepSnapshot } from '../types.js';
import { AD_PLATFORMS } from '../types.js';
import { CLICK_ID_FIELDS } from '../vendors/decode.js';

export const PLATFORM_CLICK_PARAMS: Record<string, string[]> = {
  google_ads: ['gclid', 'gbraid', 'wbraid'],
  meta: ['fbclid'],
  tiktok: ['ttclid'],
  reddit: ['rdt_cid'],
  linkedin: ['li_fat_id'],
  x: ['twclid'],
  microsoft_uet: ['msclkid'],
  openai_ads: ['oppref'],
};

/** Where each platform (or OpenArt's shim / oa_ad_clids) keeps the click ID first-party. */
export const PLATFORM_STORAGE: Record<string, { cookies: string[]; oaKeys: string[]; localStorage: string[] }> = {
  google_ads: { cookies: ['_gcl_aw', '_gcl_gb', '_gcl_ag', '_gcl_gs', '_gcl_dc', 'gclid', 'gbraid', 'wbraid'], oaKeys: ['gclid', 'gbraid', 'wbraid'], localStorage: ['_gcl_ls'] },
  meta: { cookies: ['_fbc', 'fbclid'], oaKeys: ['fbclid'], localStorage: [] },
  tiktok: { cookies: ['ttclid'], oaKeys: ['ttclid'], localStorage: [] },
  reddit: { cookies: ['_rdt_cid', 'rdt_cid'], oaKeys: ['rdt_cid'], localStorage: [] },
  linkedin: { cookies: ['li_fat_id'], oaKeys: ['li_fat_id'], localStorage: [] },
  x: { cookies: ['_twclid'], oaKeys: ['twclid'], localStorage: [] },
  microsoft_uet: { cookies: ['_uetmsclkid', 'msclkid'], oaKeys: ['msclkid'], localStorage: ['_uetmsclkid'] },
  openai_ads: { cookies: ['__oppref'], oaKeys: ['oppref'], localStorage: [] },
};

const COUNTED_KINDS = new Set(['page_view', 'conversion', 'auto_conversion', 'event', 'remarketing', 'conversion_user_data', 'sync', 'enrich']);

export interface StoredFirstParty {
  cookies: string[];
  oaAdClids: string[];
  localStorage: string[];
  any: boolean;
}

export interface PlatformClickIdResult {
  platform: Platform;
  params: Record<string, string>;
  relevant: boolean;
  finalSteps: string[];
  hitsOnFinal: number;
  hitsWithIdOnFinal: number;
  sentOnFinalPage: boolean;
  sentAnywhere: boolean;
  urlOnlyOnFinal: boolean;
  stored: StoredFirstParty;
  examples: string[];
}

export function parseOaAdClids(snapshot: StepSnapshot | undefined): Record<string, { v: string; ts?: number }> {
  if (!snapshot) return {};
  const candidates: string[] = [];
  const ls = snapshot.localStorage?.oa_ad_clids;
  if (ls) candidates.push(ls);
  const ck = snapshot.cookies.find((c) => c.name === 'oa_ad_clids' && /(^|\.)openart\.ai$/.test(String(c.domain).replace(/^\./, '')));
  if (ck) candidates.push(ck.value);
  for (const raw of candidates) {
    for (const attempt of [raw, safeDecode(raw)]) {
      try {
        const j = JSON.parse(attempt);
        if (j && typeof j === 'object') return j;
      } catch {
        /* next */
      }
    }
  }
  return {};
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function firstParty(cookies: CookieLite[]): CookieLite[] {
  return cookies.filter((c) => /(^|\.)openart\.ai$/.test(String(c.domain).replace(/^\./, '')));
}

export function storedFor(platform: string, values: string[], snap: StepSnapshot | undefined): StoredFirstParty {
  const spec = PLATFORM_STORAGE[platform] ?? { cookies: [], oaKeys: [], localStorage: [] };
  const has = (s: string | undefined) => !!s && values.some((v) => safeDecode(s).includes(v));
  const cookies = firstParty(snap?.cookies ?? []).filter((c) => spec.cookies.includes(c.name) && has(c.value)).map((c) => c.name);
  const oa = parseOaAdClids(snap);
  const oaAdClids = spec.oaKeys.filter((k) => has(oa[k]?.v));
  const localStorage = Object.entries(snap?.localStorage ?? {}).filter(([k, v]) => (spec.localStorage.includes(k) || k === 'oa_ad_clids') && has(v) && k !== 'oa_ad_clids').map(([k]) => k);
  return { cookies, oaAdClids, localStorage, any: cookies.length + oaAdClids.length + localStorage.length > 0 };
}

function hitCarries(h: DecodedHit, values: string[]): boolean {
  return Object.values(h.clickIds).some((v) => values.some((x) => v.includes(x)));
}

function hitUrlOnly(h: DecodedHit, values: string[]): boolean {
  return !!h.pageUrl && values.some((x) => safeDecode(h.pageUrl!).includes(x)) && !hitCarries(h, values);
}

/** Steps on an app page. No fallback: a journey that never reached the app has none (checks → ERROR). */
export function finalStepsOf(j: JourneyObservation): string[] {
  return j.appSteps;
}

export function clickIdPresence(j: JourneyObservation, platforms: Platform[] = AD_PLATFORMS): PlatformClickIdResult[] {
  const finalSteps = finalStepsOf(j);
  const lastSnap = [...j.snapshots].reverse().find((s) => finalSteps.includes(s.step)) ?? j.snapshots[j.snapshots.length - 1];
  return platforms.map((platform) => {
    const params: Record<string, string> = {};
    for (const p of PLATFORM_CLICK_PARAMS[platform] ?? []) if (j.clickIds[p]) params[p] = j.clickIds[p]!;
    const values = Object.values(params);
    const own = j.hits.filter((h) => h.platform === platform && COUNTED_KINDS.has(h.kind));
    const onFinal = own.filter((h) => finalSteps.includes(h.step));
    const withId = values.length ? onFinal.filter((h) => hitCarries(h, values)) : [];
    return {
      platform,
      params,
      relevant: values.length > 0,
      finalSteps,
      hitsOnFinal: onFinal.length,
      hitsWithIdOnFinal: withId.length,
      sentOnFinalPage: withId.length > 0,
      sentAnywhere: values.length > 0 && own.some((h) => hitCarries(h, values)),
      urlOnlyOnFinal: values.length > 0 && withId.length === 0 && onFinal.some((h) => hitUrlOnly(h, values)),
      stored: values.length ? storedFor(platform, values, lastSnap) : { cookies: [], oaAdClids: [], localStorage: [], any: false },
      examples: withId.slice(0, 3).map((h) => `${h.step} ${h.endpoint} ${h.eventName ?? h.kind} ${Object.entries(h.clickIds).map(([k, v]) => `${k}=${v}`).join(' ')}`),
    };
  });
}

export { CLICK_ID_FIELDS };
