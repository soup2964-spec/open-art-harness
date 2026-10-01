// Constants shared by the Worker and the edge-sim. Each vendor/client constant cites the
// evidence it was taken from (paths relative to openart_2026-09-29/).

/** Canonical click-id keys, in the order used for output and for touch `clickKeys`. */
export const CLICK_KEYS = [
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
  "li_fat_id",
  "rdt_cid",
  "oppref",
  "irclickid",
  "epik",
  "sccid",
] as const;
export type ClickKey = (typeof CLICK_KEYS)[number];

/**
 * URL parameter spellings per key; the first present wins. `im_ref` is the Impact parameter
 * OpenArt's Astro shim reads today (raw/bundles/page_.html); `irclickid` is Impact's own.
 * Snap documents `ScCid`; the lower-case form is accepted too.
 */
export const CLICK_PARAM_ALIASES: Readonly<Record<ClickKey, readonly string[]>> = {
  gclid: ["gclid"],
  gbraid: ["gbraid"],
  wbraid: ["wbraid"],
  dclid: ["dclid"],
  fbclid: ["fbclid"],
  msclkid: ["msclkid"],
  ttclid: ["ttclid"],
  twclid: ["twclid"],
  li_fat_id: ["li_fat_id"],
  rdt_cid: ["rdt_cid"],
  oppref: ["oppref"],
  irclickid: ["irclickid", "im_ref"],
  epik: ["epik"],
  sccid: ["ScCid", "sccid"],
};

/**
 * Accepted click-id characters: URL-safe plus the base64 alphabet (`+ / =`). All are
 * RFC 6265 cookie-octets, so any captured value can live in a cookie unescaped.
 */
export const CLICK_VALUE_RE = /^[A-Za-z0-9._~+/=-]+$/;

/** Default max length; the Astro shim and the Suite reader both cap values at 512. */
export const CLICK_MAX_LEN_DEFAULT = 512;
/**
 * Per-key overrides: Meta's pixel drops fbclid over 500 chars (fbevents `n.length>500`);
 * TikTok documents ttclid "up to 1,000 characters, so do not truncate it" (08 §B3 TikTok).
 */
export const CLICK_MAX_LEN: Readonly<Partial<Record<ClickKey, number>>> = { fbclid: 500, ttclid: 1000 };

/**
 * The value regex OpenArt's client applies to `oa_ad_clids` entries: Astro shim
 * `oaAdClidPattern` (raw/bundles/page_.html) and Suite module 162070 (…91db8069961c7577.js).
 * Entries failing it would be silently dropped by the client, so they are not written there.
 */
export const OA_AD_CLIDS_VALUE_RE = /^[A-Za-z0-9._-]{1,512}$/;

/** Meta's URL check for fbclid (fbevents `getURLParameterWithValidationCheck`: /^[\w.~-]+$/). */
export const META_FBCLID_RE = /^[\w.~-]{1,500}$/;

export const UTM_FIELDS = ["source", "medium", "campaign", "term", "content", "id"] as const;
export type UtmField = (typeof UTM_FIELDS)[number];
export const UTM_MAX_LEN = 200;
export const PATH_MAX_LEN = 200;
export const HOST_MAX_LEN = 253;
/** Referrer hosts kept in a record: DNS names, IPv4 and app package names (lower case). */
export const SAFE_HOST_RE = /^[a-z0-9._-]+$/;

export const COOKIE = {
  attr: "oa_attr",
  adClids: "oa_ad_clids",
  fbc: "_fbc",
  oppref: "__oppref",
  ttclid: "ttclid",
  deviceId: "oa_device_id",
  consent: "oa_consent",
} as const;

const DAY_MS = 86_400_000;
export const TTL = {
  /** oa_attr: 13 months (13 × 30 d = 390 d, always ≤ 13 calendar months), anchored to creation, never extended. */
  attrMs: 390 * DAY_MS,
  /** oa_ad_clids: Max-Age=7776000 in both OpenArt writers; also the retention of click ids in oa_attr. */
  adClidsMs: 90 * DAY_MS,
  /** _fbc: Meta NINETY_DAYS_IN_MS (fbevents `h=2160*60*60*1e3`). */
  fbcMs: 90 * DAY_MS,
  /** __oppref: the OpenAI SDK's own max-age of 720 h (td2/js_fetch/oaiq.min.js; T3b cookie). */
  opprefMs: 30 * DAY_MS,
  /** ttclid: TikTok asks for >= 28 days when self-stored (08 §B3); its pixel uses 1 day (T3). */
  ttclidMinMs: 28 * DAY_MS,
  /** Device-keyed KV record. */
  kvSeconds: 90 * 86_400,
  /** Re-write the KV record at most this often when nothing changed, to keep its TTL alive. */
  kvRefreshMs: 30 * DAY_MS,
  /** In-app-browser handoff token. */
  handoffSeconds: 30 * 60,
  /** Same-URL touches inside this window are one touch (reloads, back/forward). */
  touchDedupeMs: 30 * 60_000,
  /** Tolerated clock skew when validating stored timestamps. */
  skewMs: 5 * 60_000,
} as const;

/** Browsers cap a cookie's name + value at 4096 bytes; stay below with margin. */
export const MAX_COOKIE_PAIR_BYTES = 4000;
/** oa_attr name=value budget (a first landing with five click ids is about 900 bytes). */
export const ATTR_PAIR_BUDGET = 2048;
/** oa_ad_clids name=value budget. */
export const AD_CLIDS_PAIR_BUDGET = 1536;
/** All cookies this module manages, together: one crafted link must not bloat every later request. */
export const JAR_BUDGET_BYTES = 4096;
/** Unknown oa_ad_clids keys carried over from the client, at most. */
export const MAX_PRESERVED_KEYS = 20;

/** `oa_device_id` is a UUID today (T3b); accept any conservative token so the KV key stays safe. */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Secrets shorter than this are refused (fail closed). */
export const MIN_SECRET_LENGTH = 32;
