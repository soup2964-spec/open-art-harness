// Shared, runtime-agnostic test helpers (used by the workerd and Node projects).

/** 2026-09-29T17:02:00Z: inside the teardown's run window (01_live_teardown.md header). */
export const T0 = Date.UTC(2026, 8, 29, 17, 2, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** User agents: desktop Chrome 154 as in the teardown harness, plus the T11 in-app strings verbatim. */
export const UA = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  // crawl/teardown2/run.cjs line 40 (IG_UA) and line 41 (TT_UA)
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.28.85 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 745863112)",
  tiktok:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_39.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US ByteFullLocale/en-US isDarkMode/1 WKWebView/1 RevealType/Dialog BytedanceWebview/d8a21c6",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.40.109;]",
  // A real phone brand whose model name ends in "BOT": must NOT be treated as a crawler.
  cubotPhone:
    "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
} as const;

/** Headers a modern browser sends on a top-level navigation. */
export function navHeaders(extra: Record<string, string> = {}, ua: string = UA.chrome): Record<string, string> {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "sec-fetch-user": "?1",
    "user-agent": ua,
    ...extra,
  };
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
}

/** Strict-enough Set-Cookie parser for assertions (attribute names lower-cased). */
export function parseSetCookie(line: string): ParsedSetCookie {
  const parts = line.split(";").map((p) => p.trim());
  const first = parts.shift() ?? "";
  const eq = first.indexOf("=");
  const attrs: Record<string, string | true> = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) attrs[p.toLowerCase()] = true;
    else attrs[p.slice(0, i).toLowerCase()] = p.slice(i + 1);
  }
  return { name: first.slice(0, eq), value: first.slice(eq + 1), attrs };
}

export function cookiesByName(setCookies: readonly string[]): Map<string, ParsedSetCookie> {
  const m = new Map<string, ParsedSetCookie>();
  for (const line of setCookies) {
    const c = parseSetCookie(line);
    m.set(c.name, c);
  }
  return m;
}

/**
 * Minimal browser cookie jar: applies Set-Cookie lines (Max-Age<=0 deletes) to a Cookie
 * header string. Enough to chain multi-hop journeys in tests.
 */
export function applyToJar(cookieHeader: string, setCookies: readonly string[]): string {
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i > 0 && !jar.has(p.slice(0, i))) jar.set(p.slice(0, i), p.slice(i + 1));
  }
  for (const line of setCookies) {
    const c = parseSetCookie(line);
    const maxAge = c.attrs["max-age"];
    if (typeof maxAge === "string" && Number(maxAge) <= 0) jar.delete(c.name);
    else jar.set(c.name, c.value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * The OpenArt Suite reader for `oa_ad_clids`, transcribed from the shipped bundle
 * (raw/bundles/js/openart.ai__suite___next__static__chunks__91db8069961c7577.js, module
 * 162070, functions `s` and `a`). Used to prove the server-set cookie stays readable by
 * the existing client code and yields the same /api/user/ad-click-ids payload.
 */
export const SUITE_KEYS = ["gclid", "fbclid", "msclkid", "ttclid"] as const;
const SUITE_VALUE_RE = /^[A-Za-z0-9._-]{1,512}$/;
export function suiteReadAdClickIds(cookieValue: string): Record<string, { v: string; ts: number }> {
  let e: string;
  try {
    e = decodeURIComponent(cookieValue);
  } catch {
    return {};
  }
  if (!e) return {};
  try {
    const t = JSON.parse(e) as Record<string, unknown>;
    if (!t || typeof t !== "object") return {};
    const r: Record<string, { v: string; ts: number }> = {};
    for (const key of SUITE_KEYS) {
      const n = t[key] as { v?: unknown; ts?: unknown } | undefined;
      if (!n || typeof n !== "object") continue;
      const { v: s, ts: a } = n;
      if (typeof s === "string" && SUITE_VALUE_RE.test(s) && typeof a === "number") r[key] = { v: s, ts: a };
    }
    return r;
  } catch {
    return {};
  }
}
export function suiteBuildMigrationPayload(ids: Record<string, { v: string; ts: number }>): {
  keys: string[];
  payload: Record<string, string | number>;
} {
  const keys: string[] = [];
  const payload: Record<string, string | number> = {};
  for (const i of SUITE_KEYS) {
    const n = ids[i];
    if (n) {
      keys.push(i);
      payload[i] = n.v;
      payload[`${i}_created_at`] = n.ts;
    }
  }
  return { keys, payload };
}

/**
 * The Astro inline shim's merge (raw/bundles/page_.html, "OpenArt Click ID Shim"): parses the
 * existing cookie, overwrites only its own keys, and keeps every other key.
 */
export function astroShimMerge(existingCookieValue: string, incoming: Record<string, { v: string; ts: number }>): string {
  let oaExisting: Record<string, unknown> = {};
  try {
    oaExisting = (JSON.parse(decodeURIComponent(existingCookieValue)) as Record<string, unknown>) || {};
  } catch {
    /* shim swallows */
  }
  for (const key of ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"]) {
    if (incoming[key]) oaExisting[key] = incoming[key];
  }
  return encodeURIComponent(JSON.stringify(oaExisting));
}

/**
 * Meta pixel `_fbc` unpack + maybeUpdatePayload, transcribed from fbevents
 * (crawl/teardown2/bodies/a169ba40a402b831674f823e6cd5bc8d3e1208e4.js, module
 * SignalsFBEventsPixelCookie): 4 or 5 dot-separated parts, "fb" prefix, `__DOT__` escape.
 */
export function metaUnpackFbc(raw: string): { subdomainIndex: number; creationTime: number; payload: string } | null {
  const r = raw.split(".");
  if (r.length !== 4 && r.length !== 5) return null;
  const [ver, idx, ct, payload, appendix] = r as [string, string, string, string, string | undefined];
  if (appendix != null && appendix.length !== 2 && appendix.length !== 8) return null;
  if (ver !== "fb") return null;
  const subdomainIndex = parseInt(idx, 10);
  const creationTime = parseInt(ct, 10);
  if (Number.isNaN(subdomainIndex) || Number.isNaN(creationTime) || !payload) return null;
  return { subdomainIndex, creationTime, payload: payload.replace(/__DOT__/g, ".") };
}

/**
 * TikTok pixel `ttclid` cookie parse (`eq`) and keep-or-mint rule (`eB`), transcribed from
 * analytics.tiktok.com main.MWU2MzIzODM0MQ.js (crawl/teardown2/bodies/854097695c4c…js).
 */
export function tiktokParse(t: string): { clickId: string; observedAt?: number } {
  const e = t.lastIndexOf(".");
  const r = t.slice(e + 1);
  return e <= 0 || !/^\d{13}$/.test(r) ? { clickId: t } : { clickId: t.slice(0, e), observedAt: Number(r) };
}
export function tiktokKeepOrMint(urlClickId: string, cookieValue: string | undefined, now: number): string {
  return cookieValue && tiktokParse(cookieValue).clickId === urlClickId ? cookieValue : `${urlClickId}.${now}`;
}
