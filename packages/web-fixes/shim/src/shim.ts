/**
 * OpenArt Click ID Shim v2 — drop-in replacement for the inline Astro
 * "OpenArt Click ID Shim" (captured in raw/bundles/page_.html, chars 1152-4788).
 *
 * Kept exactly as before:
 *  - standalone 90-day cookies gclid, fbclid, msclkid, rdt_cid, gbraid, wbraid
 *    (`key=value; max-age=7776000; path=/; domain=.openart.ai; SameSite=Lax`), only on *.openart.ai
 *  - `oa_ad_clids` JSON {key: {v, ts}} in cookie + localStorage, merged with what is already stored
 *  - Impact: `im_ref` -> localStorage `impact_clickid` + POST /legacy/api/tracking/impact/store-clickid;
 *    `irpid` -> localStorage `impact_irpid`
 *  - Tolt script (`data-tolt`) on the production host only
 *  - never throws
 *
 * Changed / added:
 *  - `oa_ad_clids` now carries all ten canonical keys (adds rdt_cid, twclid, li_fat_id, oppref;
 *    gbraid/wbraid/fbclid/... as before) and also merges newer entries from localStorage
 *  - mints Meta `_fbc` = fb.1.<ms>.<fbclid> (Domain .openart.ai, 90 days) when `fbclid` is present,
 *    keeping an existing `_fbc` for the same fbclid (its creation time must not move)
 *  - writes `__oppref` (30 days) so the OpenAI Ads SDK's cookie fallback finds the ChatGPT click ref
 *    on app pages after a marketing-page landing
 *  - persists the last non-empty UTM set as `oa_utm` (cookie + localStorage, 90 days) for the
 *    HubSpot form fill and the in-app-browser handoff  [addition, see shim/README.md]
 *  - no console.log of values
 *  - adds `Secure` on https
 *  - every click-id value it stores or posts (the six standalone cookies, `oa_ad_clids`, `_fbc`,
 *    `__oppref`, Impact `im_ref`/`irpid` and the Impact POST) must pass CLICK_ID_VALUE_PATTERN
 *    (`^[A-Za-z0-9._-]{1,512}$`, the Suite's rule). The original shim stored raw URL values, so one
 *    crafted link could plant a 3.8 KB cookie on every openart.ai request for 90 days, or markup in
 *    localStorage and the backend.
 *  - skips no-op writes: a cookie that already holds the same value (for example one the
 *    edge-attribution Worker set server-side, which Safari does not cap at 7 days) is not
 *    rewritten from JavaScript, and a click id already stored keeps its first-seen `ts` (the same
 *    rule as captureAdClickIds and the edge Worker)
 *  - consent gate (inert unless a signal exists, see ../../consent/src/privacy-signals.ts):
 *      - explicit `ad_storage: denied` (`window.__oaConsent`, else the `oa_consent` cookie, the
 *        contract edge-attribution also reads): nothing is persisted or posted;
 *      - Global Privacy Control, or a US sale/sharing opt-out (`oa_consent.opt_out_sale_sharing`,
 *        IAB `usprivacy`): ad identifiers, Impact and Tolt are held back; the UTM store is kept;
 *      - `window.oaClickIdShim.grant()` (the CMP's grant callback) releases what was held, except
 *        that a recorded sale/sharing opt-out keeps holding the ad identifiers.
 *    With no signal present the shim behaves as it does today.
 */

import {
  AD_CLICK_ID_KEYS,
  OA_AD_CLIDS_KEY,
  OA_AD_CLIDS_MAX_AGE_SECONDS,
  buildFbc,
  clickIdsFromSearch,
  fbclidFromFbc,
  isClickIdKey,
  isValidClickIdValue,
  readCookie,
  withIncomingClickId,
  type ClickIdEntry,
  type ClickIdKey,
  type ClickIdStore,
} from '../../app-patches/src/click-id-keys';
import { OA_UTM_KEY, UTM_KEYS, type UtmKey } from '../../app-patches/src/attribution-snapshot';
import { CONSENT_COOKIE, adConsentDecision, readPrivacySignals, type AdConsentDecision } from '../../consent/src/privacy-signals';

export { CONSENT_COOKIE, OA_UTM_KEY, UTM_KEYS, type UtmKey };

export const SHIM_VERSION = '2.0.0';

/** Unchanged from the original shim. */
export const STANDALONE_COOKIE_KEYS = ['gclid', 'fbclid', 'msclkid', 'rdt_cid', 'gbraid', 'wbraid'] as const;
export const FBC_COOKIE = '_fbc';
export const FBC_MAX_AGE_SECONDS = 7_776_000;
/** The OpenAI Ads SDK (oaiq-web 0.1.41) reads/writes `__oppref` with max-age 720 h. */
export const OPPREF_COOKIE = '__oppref';
export const OPPREF_MAX_AGE_SECONDS = 2_592_000;
export const TOLT_SRC = 'https://cdn.tolt.io/tolt.js';
export const TOLT_ID = 'ae0f5a8f-ead8-4050-a9a4-f6b44ca09e95';
export const IMPACT_ENDPOINT = '/legacy/api/tracking/impact/store-clickid';

const OPENART_HOST = /(^|\.)openart\.ai$/i;
const PRODUCTION_HOST = /^(www\.)?openart\.ai$/i;
const MAX_UTM_LENGTH = 256;
// Control characters are never valid in a UTM value we persist.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Keys of other writers (the edge Worker) that a rewrite of `oa_ad_clids` carries over, at most 20. */
const SAFE_EXTRA_KEY = /^[A-Za-z0-9_]{1,64}$/;
const MAX_EXTRA_KEYS = 20;
/** Never carried over: they would re-parent the object instead of becoming a key. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface ShimConsentSignal {
  ad_storage?: 'granted' | 'denied';
}

export interface ShimApi {
  version: string;
  /** Persist whatever was held back because consent was denied (idempotent). */
  grant: () => void;
  /** Number of held-back persistence actions (0 when nothing is pending). */
  pending: () => number;
}

export interface ShimDocument {
  cookie: string;
  readyState?: string;
  head?: { appendChild: (node: unknown) => unknown } | null;
  documentElement?: { appendChild: (node: unknown) => unknown } | null;
  getElementById: (id: string) => unknown;
  querySelector: (selector: string) => unknown;
  createElement: (tag: 'script') => {
    id: string;
    src: string;
    async: boolean;
    defer: boolean;
    setAttribute: (name: string, value: string) => void;
  };
  addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
}

export interface ShimWindow {
  location: { search: string; hostname: string; protocol: string };
  document: ShimDocument;
  navigator?: { globalPrivacyControl?: unknown } | null;
  localStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  fetch?: (input: string, init?: RequestInit) => Promise<unknown>;
  __oaConsent?: ShimConsentSignal;
  oaClickIdShim?: ShimApi;
}

export interface ShimResult {
  isOpenArtHost: boolean;
  isProductionHost: boolean;
  /** Click ids read from the URL that passed validation. */
  incoming: ClickIdStore;
  /** The consent state the writes were gated on (see ../../consent/src/privacy-signals.ts). */
  consent: AdConsentDecision;
  /** Something was held back (explicit denial, GPC or a sale/sharing opt-out) until grant(). */
  deferred: boolean;
  wrote: {
    standalone: string[];
    oaAdClids: boolean;
    fbc: boolean;
    oppref: boolean;
    utm: boolean;
    impactClickId: boolean;
    impactPartnerId: boolean;
  };
  impactPosted: boolean;
  toltRequested: boolean;
}

export interface ShimOptions {
  now?: () => number;
}

function sanitizeText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}

/** `window.__oaConsent` wins; else the `oa_consent` cookie; else no signal (undefined). */
export function readAdStorageSignal(win: Pick<ShimWindow, '__oaConsent' | 'document'>): 'granted' | 'denied' | undefined {
  return readPrivacySignals(win).adStorage;
}

function isValidEntry(value: unknown): value is ClickIdEntry {
  if (!value || typeof value !== 'object') return false;
  const { v, ts } = value as { v?: unknown; ts?: unknown };
  return isValidClickIdValue(v) && typeof ts === 'number' && Number.isFinite(ts);
}

/**
 * What a rewrite of `oa_ad_clids` keeps from the stored cookie: valid entries for the canonical
 * keys, plus at most 20 other writers' keys (edge-attribution adds dclid, irclickid, epik, sccid)
 * whose values pass the same pattern. Anything else is dropped, never re-stored.
 */
function sanitizeStoredClickIds(parsed: unknown): Record<string, ClickIdEntry> {
  const out: Record<string, ClickIdEntry> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  let extra = 0;
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidEntry(entry)) continue;
    if (isClickIdKey(key)) {
      out[key] = { v: entry.v, ts: entry.ts };
    } else if (SAFE_EXTRA_KEY.test(key) && !FORBIDDEN_KEYS.has(key) && extra < MAX_EXTRA_KEYS) {
      out[key] = { v: entry.v, ts: entry.ts };
      extra++;
    }
  }
  return out;
}

/** Two stored observations of one key: an equal value keeps the earlier `ts`, a changed value the newer entry. */
function pickStored(current: ClickIdEntry | undefined, other: ClickIdEntry): ClickIdEntry {
  if (!current) return other;
  if (other.v === current.v) return other.ts < current.ts ? other : current;
  return other.ts > current.ts ? other : current;
}

/** Run the shim once. Safe to call at document start (no DOM needed until Tolt is appended). */
export function runClickIdShim(win: ShimWindow, opts: ShimOptions = {}): ShimResult {
  const doc = win.document;
  const params = new URLSearchParams(win.location.search);
  const hostname = win.location.hostname;
  const isOpenArtHost = OPENART_HOST.test(hostname);
  const isProductionHost = PRODUCTION_HOST.test(hostname);
  const secure = win.location.protocol === 'https:';
  const now = opts.now ? opts.now() : Date.now();

  const result: ShimResult = {
    isOpenArtHost,
    isProductionHost,
    incoming: {},
    consent: 'none',
    deferred: false,
    wrote: {
      standalone: [],
      oaAdClids: false,
      fbc: false,
      oppref: false,
      utm: false,
      impactClickId: false,
      impactPartnerId: false,
    },
    impactPosted: false,
    toltRequested: false,
  };

  function safeLocalStorageSet(key: string, value: string): boolean {
    try {
      if (!win.localStorage) return false;
      win.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function safeLocalStorageGet(key: string): string | null {
    try {
      return win.localStorage ? win.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  /** Same attribute string as the original shim, plus `Secure` on https. */
  function setOpenArtCookie(key: string, value: string, maxAgeSeconds: number): boolean {
    if (!isOpenArtHost) return false;
    try {
      doc.cookie =
        key +
        '=' +
        encodeURIComponent(value) +
        '; max-age=' +
        maxAgeSeconds +
        '; path=/; domain=.openart.ai; SameSite=Lax' +
        (secure ? '; Secure' : '');
      return true;
    } catch {
      return false;
    }
  }

  function postImpactClickId(clickId: string): void {
    if (!isOpenArtHost || typeof win.fetch !== 'function' || !isValidClickIdValue(clickId)) return;
    try {
      const pending = win.fetch(IMPACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ clickId }),
      });
      result.impactPosted = true;
      if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
        (pending as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // network stack unavailable
    }
  }

  function whenDomReady(cb: () => void): void {
    if (doc.head || doc.documentElement) {
      cb();
      return;
    }
    doc.addEventListener?.('DOMContentLoaded', cb, { once: true });
  }

  function loadTolt(): void {
    if (doc.getElementById('tolt-referral')) return;
    if (doc.querySelector('script[src="' + TOLT_SRC + '"]')) return;
    result.toltRequested = true;
    whenDomReady(() => {
      try {
        if (doc.getElementById('tolt-referral')) return;
        const script = doc.createElement('script');
        script.id = 'tolt-referral';
        script.src = TOLT_SRC;
        script.async = true;
        script.defer = true;
        script.setAttribute('data-tolt', TOLT_ID);
        const parent = doc.head || doc.documentElement;
        parent?.appendChild(script);
      } catch {
        // never break the page
      }
    });
  }

  /**
   * `ad` actions store or send an advertising identifier (click-id cookies, `oa_ad_clids`, `_fbc`,
   * `__oppref`, Impact, Tolt); the UTM store is not one.
   */
  const actions: Array<{ ad: boolean; run: () => void }> = [];
  const ad = (run: () => void): void => {
    actions.push({ ad: true, run });
  };

  // 1. Standalone click-id cookies (unchanged key set and attributes; values must pass the click-id pattern).
  for (const key of STANDALONE_COOKIE_KEYS) {
    const value = params.get(key);
    if (isValidClickIdValue(value)) {
      ad(() => {
        if (readCookie(doc.cookie, key) === value) return; // already stored (possibly server-set): keep it
        if (setOpenArtCookie(key, value, OA_AD_CLIDS_MAX_AGE_SECONDS)) result.wrote.standalone.push(key);
      });
    }
  }

  // 2. oa_ad_clids for all canonical keys.
  const incoming = clickIdsFromSearch(win.location.search, now);
  result.incoming = incoming;
  const incomingKeys = Object.keys(incoming) as ClickIdKey[];
  if (incomingKeys.length > 0) {
    ad(() => {
      const cookieRaw = readCookie(doc.cookie, OA_AD_CLIDS_KEY);
      let parsed: unknown = null;
      try {
        parsed = cookieRaw ? JSON.parse(cookieRaw) : null;
      } catch {
        parsed = null;
      }
      const existing = sanitizeStoredClickIds(parsed);
      // Entries that only survived in localStorage are kept too (same first-seen rule).
      let stored: unknown = null;
      try {
        stored = JSON.parse(safeLocalStorageGet(OA_AD_CLIDS_KEY) ?? 'null');
      } catch {
        stored = null;
      }
      const fromStorage = sanitizeStoredClickIds(stored);
      for (const key of AD_CLICK_ID_KEYS) {
        const entry = fromStorage[key];
        if (entry) existing[key] = pickStored(existing[key], entry);
      }
      // Same click id already stored: it is the same click, keep its first-seen timestamp.
      for (const key of incomingKeys) existing[key] = withIncomingClickId(existing[key], incoming[key]!);
      const json = JSON.stringify(existing);
      const cookieOk = json === cookieRaw ? false : setOpenArtCookie(OA_AD_CLIDS_KEY, json, OA_AD_CLIDS_MAX_AGE_SECONDS);
      const storageOk = safeLocalStorageGet(OA_AD_CLIDS_KEY) === json ? false : safeLocalStorageSet(OA_AD_CLIDS_KEY, json);
      result.wrote.oaAdClids = cookieOk || storageOk;
    });
  }

  // 3. Meta _fbc from fbclid (Meta docs: fb.<subdomainIndex>.<creationTimeMs>.<fbclid>).
  const fbclid = incoming.fbclid?.v;
  if (fbclid) {
    ad(() => {
      const existingFbc = readCookie(doc.cookie, FBC_COOKIE);
      if (fbclidFromFbc(existingFbc) === fbclid) return; // same click: keep the original creation time
      if (setOpenArtCookie(FBC_COOKIE, buildFbc(fbclid, now), FBC_MAX_AGE_SECONDS)) result.wrote.fbc = true;
    });
  }

  // 4. __oppref for the OpenAI Ads SDK cookie fallback (the same validated value as oa_ad_clids).
  const oppref = incoming.oppref?.v;
  if (oppref) {
    ad(() => {
      if (readCookie(doc.cookie, OPPREF_COOKIE) === oppref) return;
      if (setOpenArtCookie(OPPREF_COOKIE, oppref, OPPREF_MAX_AGE_SECONDS)) result.wrote.oppref = true;
    });
  }

  // 5. Last non-empty UTM set (non-identifying: kept under GPC or a sale/sharing opt-out).
  const utm: Partial<Record<UtmKey, string>> = {};
  for (const key of UTM_KEYS) {
    const value = sanitizeText(params.get(key), MAX_UTM_LENGTH);
    if (value) utm[key] = value;
  }
  if (Object.keys(utm).length > 0) {
    actions.push({
      ad: false,
      run: () => {
        try {
          const current: unknown = JSON.parse(readCookie(doc.cookie, OA_UTM_KEY) ?? 'null');
          if (current && typeof current === 'object') {
            const { ts: _ts, ...rest } = current as Record<string, unknown>;
            if (JSON.stringify(rest) === JSON.stringify(utm)) return; // same campaign: keep first-seen ts
          }
        } catch {
          // unreadable: overwrite
        }
        const json = JSON.stringify({ ...utm, ts: now });
        const cookieOk = setOpenArtCookie(OA_UTM_KEY, json, OA_AD_CLIDS_MAX_AGE_SECONDS);
        const storageOk = safeLocalStorageSet(OA_UTM_KEY, json);
        result.wrote.utm = cookieOk || storageOk;
      },
    });
  }

  // 6. Impact: same keys and endpoint as before, but only values that pass the click-id pattern.
  const impactClickId = params.get('im_ref');
  if (isValidClickIdValue(impactClickId)) {
    ad(() => {
      result.wrote.impactClickId = safeLocalStorageSet('impact_clickid', impactClickId);
      postImpactClickId(impactClickId);
    });
  }
  const impactPartnerId = params.get('irpid');
  if (isValidClickIdValue(impactPartnerId)) {
    ad(() => {
      result.wrote.impactPartnerId = safeLocalStorageSet('impact_irpid', impactPartnerId);
    });
  }

  // 7. Tolt (unchanged: production host only). A third-party referral tracker, so gated like the ids.
  if (isProductionHost) ad(loadTolt);

  const runAll = (list: ReadonlyArray<{ run: () => void }>): void => {
    for (const action of list) {
      try {
        action.run();
      } catch {
        // one failing write must not block the others
      }
    }
  };

  const decision = adConsentDecision(readPrivacySignals(win));
  result.consent = decision;
  const held = (a: { ad: boolean }): boolean => decision === 'denied' || (decision === 'opt_out' && a.ad);
  let pending = actions.filter(held);
  result.deferred = pending.length > 0;
  runAll(actions.filter((a) => !held(a)));

  win.oaClickIdShim = {
    version: SHIM_VERSION,
    // The CMP's grant callback. It overrides a denial and GPC (the visitor opted in), but a
    // recorded "do not sell or share" opt-out keeps holding the ad identifiers.
    grant: () => {
      const keepAdsHeld = readPrivacySignals(win).optOutSaleSharing;
      const toRun = pending.filter((a) => !(keepAdsHeld && a.ad));
      pending = pending.filter((a) => keepAdsHeld && a.ad);
      runAll(toRun);
    },
    pending: () => pending.length,
  };

  return result;
}
