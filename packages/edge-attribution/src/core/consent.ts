// Consent gating. The policy is injectable; the default reads a CMP cookie, the visitor's country
// (Cloudflare request.cf), Sec-GPC and US "do not sell or share" opt-out cookies. See README
// "Consent" for how a CMP maps onto oa_consent.
//
// Regions come from packages/contracts (CONSENT_REQUIRED_REGIONS, consentCountry): the one list
// every package gates on. Only that side-effect-free module is imported, so the Worker bundle and
// dist/edge-sim.js inline two constants and a function, not the contracts package.
import { CONSENT_REQUIRED_REGIONS, consentCountry } from "../../../contracts/src/consent-regions.js";
import { COOKIE } from "./constants.js";
import type { ConsentDecision, ConsentMode, ConsentRegion, ConsentSignals, ConsentSnapshot, ConsentValue } from "./model.js";

export interface ConsentContext {
  /** ISO 3166-1 alpha-2 from request.cf.country (upper case), or null. */
  country: string | null;
  /** request.cf.isEUCountry === "1" */
  isEUCountry: boolean;
  cookies: ReadonlyMap<string, string>;
  headers: Headers;
  /** Sec-GPC: 1 */
  gpc: boolean;
}

export type ConsentPolicy = (ctx: ConsentContext) => ConsentDecision | Promise<ConsentDecision>;

/**
 * packages/contracts CONSENT_REQUIRED_REGIONS: Google's EU user consent policy scope, the EEA
 * (EU27 + IS, LI, NO), the UK and Switzerland (08 §1.7), plus the EU territories geolocation
 * reports under their own codes (RE, GF, GP, MQ, YT, MF, AX, the Canary Islands IC, Ceuta and
 * Melilla EA). Kept under this name for compatibility.
 */
export const REGULATED_COUNTRIES: ReadonlySet<string> = CONSENT_REQUIRED_REGIONS;

/** IAB CCPA US Privacy string cookie (`1YYN`: version, notice, opted out of sale, LSPA). */
export const US_PRIVACY_COOKIE = "usprivacy";

export interface DefaultConsentPolicyOptions {
  /** CMP cookie to read. Default "oa_consent" (see parseConsentModeCookie). */
  cmpCookie?: string;
  /** Maps the raw CMP cookie to Consent Mode signals. Default parseConsentModeCookie. */
  parseCmpCookie?: (raw: string) => ConsentSignals | null;
  /** Countries where ad_storage must be granted before advertising cookies are set. */
  regulatedCountries?: Iterable<string>;
  /** Unknown geo (no cf, "XX", Tor "T1"): treated as regulated by default (fail closed). */
  unknownCountry?: "regulated" | "unregulated";
  /** "deny-ads" (default) treats Sec-GPC: 1 as an ad-storage opt-out; "flag" only records it. */
  gpc?: "flag" | "deny-ads";
  /**
   * A US "do not sell or share" opt-out (see readOptOutSaleSharing). "deny-ads" (default): an ad
   * opt-out and an explicit choice (it purges the advertising cookies), which also wins over an
   * ad_storage grant because US CMPs often grant by default. "flag" only records it.
   */
  optOutSaleSharing?: "flag" | "deny-ads";
  /** Reads the opt-out from the request cookies. Default readOptOutSaleSharing. */
  readOptOut?: (cookies: ReadonlyMap<string, string>) => boolean;
  /** What to keep without ad consent: non-identifying utm fields (default) or nothing. */
  withoutAdConsent?: "utm-only" | "none";
}

export function consentRegion(ctx: Pick<ConsentContext, "country" | "isEUCountry">, regulated: ReadonlySet<string>): ConsentRegion {
  if (ctx.isEUCountry) return "regulated";
  // contracts consentCountry: upper-cases, drops subdivisions, maps UK -> GB, and returns null
  // for missing or unusable geo (XX no data, T1 Tor, ZZ, malformed).
  const c = consentCountry(ctx.country);
  if (c === null) return "unknown";
  return regulated.has(c) ? "regulated" : "unregulated";
}

/** true = opted out of sale, false = not opted out, null = no usable string (`-`, wrong version, garbage). */
export function parseUsPrivacyString(raw: string | null | undefined): boolean | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  if (!/^1[YN-]{3}$/.test(s)) return null;
  const flag = s.charAt(2);
  return flag === "Y" ? true : flag === "N" ? false : null;
}

/**
 * US "do not sell or share my personal information" opt-out, from the mechanisms that leave it in
 * a first-party cookie: the `oa_consent` contract with `opt_out_sale_sharing: true` (what a CMP's
 * or OpenArt's own "Do Not Sell or Share" link writes), and the IAB CCPA US Privacy string
 * (`usprivacy`, opt-out-of-sale flag `Y`). GPC arrives separately as Sec-GPC. Other mechanisms
 * (a GPP string, a CMP's own category) map through `readOptOut` or by writing the oa_consent field.
 */
export function readOptOutSaleSharing(cookies: ReadonlyMap<string, string>): boolean {
  const raw = cookies.get(COOKIE.consent);
  if (raw && parseConsentCookieObject(raw)?.opt_out_sale_sharing === true) return true;
  return parseUsPrivacyString(cookies.get(US_PRIVACY_COOKIE)) === true;
}

export function createDefaultConsentPolicy(options: DefaultConsentPolicyOptions = {}): (ctx: ConsentContext) => ConsentDecision {
  const cmpCookie = options.cmpCookie ?? COOKIE.consent;
  const parse = options.parseCmpCookie ?? parseConsentModeCookie;
  const regulated = options.regulatedCountries ? new Set([...options.regulatedCountries].map((c) => c.toUpperCase())) : REGULATED_COUNTRIES;
  const unknownIsRegulated = (options.unknownCountry ?? "regulated") === "regulated";
  const gpcDenies = (options.gpc ?? "deny-ads") === "deny-ads";
  const optOutDenies = (options.optOutSaleSharing ?? "deny-ads") === "deny-ads";
  const readOptOut = options.readOptOut ?? readOptOutSaleSharing;
  const withoutAds = options.withoutAdConsent ?? "utm-only";

  return (ctx) => {
    const raw = ctx.cookies.get(cmpCookie);
    let signals: ConsentSignals = {};
    if (raw) {
      try {
        signals = parse(raw) ?? {};
      } catch {
        signals = {};
      }
    }
    let optOutSaleSharing = false;
    try {
      optOutSaleSharing = readOptOut(ctx.cookies) === true;
    } catch {
      optOutSaleSharing = false;
    }
    const optOutApplies = optOutSaleSharing && optOutDenies;
    const explicit = signals.ad_storage !== undefined || signals.analytics_storage !== undefined || optOutApplies;
    const region = consentRegion(ctx, regulated);
    const isRegulated = region === "regulated" || (region === "unknown" && unknownIsRegulated);
    const noAds: ConsentMode = signals.analytics_storage === "denied" ? "none" : withoutAds;

    let mode: ConsentMode;
    let reason: string;
    if (optOutApplies) {
      mode = noAds;
      reason = "opt-out:sale-sharing";
    } else if (signals.ad_storage === "granted") {
      mode = "full";
      reason = "cmp:ad_storage=granted";
    } else if (signals.ad_storage === "denied") {
      mode = noAds;
      reason = "cmp:ad_storage=denied";
    } else if (isRegulated) {
      mode = noAds;
      reason = `region:${region}`;
    } else if (ctx.gpc && gpcDenies) {
      mode = noAds;
      reason = "gpc";
    } else {
      mode = "full";
      reason = `region:${region}`;
    }
    return { mode, region, explicit, gpc: ctx.gpc, optOutSaleSharing, signals, reason };
  };
}

export function consentSnapshot(d: ConsentDecision): ConsentSnapshot {
  return { mode: d.mode, region: d.region, explicit: d.explicit, gpc: d.gpc, optOutSaleSharing: d.optOutSaleSharing === true, signals: { ...d.signals } };
}

const SIGNAL_KEYS = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"] as const;
const asValue = (v: unknown): ConsentValue | undefined => (v === "granted" || v === "denied" ? v : undefined);

/**
 * The `oa_consent` contract: the CMP's consent callback writes the same object it passes to
 * `gtag('consent', 'update', …)`, as `encodeURIComponent(JSON.stringify(obj))`:
 *   {"ad_storage":"granted","analytics_storage":"granted","ad_user_data":"granted","ad_personalization":"denied"}
 * Unencoded JSON is tolerated. Unknown keys and values are ignored.
 */
export function parseConsentModeCookie(raw: string): ConsentSignals | null {
  const obj = parseConsentCookieObject(raw);
  if (!obj) return null;
  const out: ConsentSignals = {};
  for (const k of SIGNAL_KEYS) {
    const v = asValue(obj[k]);
    if (v) out[k] = v;
  }
  return out;
}

/** The oa_consent JSON object (URL-encoded or not), or null. */
function parseConsentCookieObject(raw: string): Record<string, unknown> | null {
  let text = raw;
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      text = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
}

function adSignals(granted: boolean): ConsentSignals {
  const v: ConsentValue = granted ? "granted" : "denied";
  return { ad_storage: v, ad_user_data: v, ad_personalization: v };
}

/**
 * Cookiebot `CookieConsent` (a URL-encoded JS-object literal such as
 * `{stamp:'…',necessary:true,preferences:true,statistics:false,marketing:true,…}`):
 * marketing -> ad_storage/ad_user_data/ad_personalization, statistics -> analytics_storage.
 * `-1` (visitor outside a consent region) carries no decision.
 */
export function parseCookiebotCookie(raw: string): ConsentSignals | null {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (text.trim() === "-1") return null;
  const flag = (name: string) => new RegExp(`(?:^|[{,])\\s*${name}\\s*:\\s*(true|false)`).exec(text)?.[1];
  const marketing = flag("marketing");
  const statistics = flag("statistics");
  if (marketing === undefined && statistics === undefined) return null;
  const out: ConsentSignals = marketing === undefined ? {} : adSignals(marketing === "true");
  if (statistics !== undefined) out.analytics_storage = statistics === "true" ? "granted" : "denied";
  return out;
}

/**
 * OneTrust `OptanonConsent` (a URL-encoded query string with `groups=C0001:1,C0002:1,...`).
 * Category ids are tenant configuration; the defaults are OneTrust's standard ones:
 * C0004 Targeting -> ad signals, C0002 Performance -> analytics_storage.
 */
export function parseOneTrustCookie(raw: string, groups: { ads?: string; analytics?: string } = {}): ConsentSignals | null {
  const adsId = groups.ads ?? "C0004";
  const analyticsId = groups.analytics ?? "C0002";
  let g: string | null;
  try {
    g = new URLSearchParams(raw).get("groups");
  } catch {
    return null;
  }
  if (!g) return null;
  const states = new Map<string, string>();
  for (const pair of g.split(",")) {
    const [id, state] = pair.split(":");
    if (id && state !== undefined) states.set(id.trim(), state.trim());
  }
  const out: ConsentSignals = {};
  const ads = states.get(adsId);
  if (ads === "1" || ads === "0") Object.assign(out, adSignals(ads === "1"));
  const analytics = states.get(analyticsId);
  if (analytics === "1" || analytics === "0") out.analytics_storage = analytics === "1" ? "granted" : "denied";
  return Object.keys(out).length > 0 ? out : null;
}

const MODE_RANK: Record<ConsentMode, number> = { none: 0, "utm-only": 1, full: 2 };
const REGIONS = new Set(["regulated", "unregulated", "unknown"]);

/**
 * Validates a policy's output. Anything unexpected (unknown mode, malformed fields) fails
 * closed to "none"; the returned error is for onError.
 */
export function normalizeDecision(d: unknown): { decision: ConsentDecision; error: Error | null } {
  const o = (d ?? {}) as Partial<ConsentDecision>;
  const ok =
    (o.mode === "full" || o.mode === "utm-only" || o.mode === "none") &&
    typeof o.region === "string" &&
    REGIONS.has(o.region) &&
    typeof o.explicit === "boolean" &&
    typeof o.gpc === "boolean" &&
    (o.optOutSaleSharing === undefined || typeof o.optOutSaleSharing === "boolean") &&
    !!o.signals &&
    typeof o.signals === "object";
  // Policies written before optOutSaleSharing existed stay valid: absent means false.
  if (ok) return { decision: { ...(o as ConsentDecision), optOutSaleSharing: o.optOutSaleSharing === true }, error: null };
  return {
    decision: { mode: "none", region: "unknown", explicit: false, gpc: false, optOutSaleSharing: false, signals: {}, reason: "invalid-policy-output" },
    error: new Error(`consent policy returned an invalid decision (mode: ${String(o.mode)}); failing closed`),
  };
}

/**
 * Compact fingerprint of what the stored data was collected under: region, explicit, GPC, the four
 * signals, and "o" when a sale/sharing opt-out is recorded (appended only then, so fingerprints
 * already stored in oa_attr stay valid and unchanged).
 */
export function consentFingerprint(d: Pick<ConsentDecision, "region" | "explicit" | "gpc" | "signals" | "optOutSaleSharing">): string {
  const sig = (v: ConsentValue | undefined) => (v === "granted" ? "g" : v === "denied" ? "d" : "-");
  const region = d.region === "regulated" ? "r" : d.region === "unregulated" ? "u" : "x";
  const s = d.signals;
  return `${region}${d.explicit ? 1 : 0}${d.gpc ? 1 : 0}${sig(s.ad_storage)}${sig(s.analytics_storage)}${sig(s.ad_user_data)}${sig(s.ad_personalization)}${d.optOutSaleSharing ? "o" : ""}`;
}

/** The more restrictive of two modes. */
export function minMode<M extends ConsentMode>(a: M, b: M): M {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}
