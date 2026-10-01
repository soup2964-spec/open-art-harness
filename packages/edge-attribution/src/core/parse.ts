// Turns a request into plain facts: click ids, utm, referrer, landing path, cookies, geo.
import {
  CLICK_KEYS,
  CLICK_MAX_LEN,
  CLICK_MAX_LEN_DEFAULT,
  CLICK_PARAM_ALIASES,
  CLICK_VALUE_RE,
  DEVICE_ID_RE,
  HOST_MAX_LEN,
  PATH_MAX_LEN,
  SAFE_HOST_RE,
  UTM_FIELDS,
  UTM_MAX_LEN,
} from "./constants.js";
import type { ClickKey } from "./constants.js";
import { parseCookieHeader } from "./cookies.js";
import type { Utm } from "./model.js";
import { hostInDomain } from "./options.js";
import type { ResolvedCoreOptions } from "./options.js";

/** The subset of Cloudflare's `request.cf` this package reads. */
export interface CfLike {
  country?: string | null;
  isEUCountry?: string | null;
  botManagement?: { verifiedBot?: boolean | null; score?: number | null } | null;
}

/** Anything request-shaped: a Workers `Request`, a Node `Request`, or a plain object (edge-sim). */
export interface RequestLike {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly cf?: unknown;
}

export type ClickValues = Partial<Record<ClickKey, string>>;

export type ReferrerInfo =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "internal"; host: string; url: URL }
  | { kind: "excluded"; host: string }
  | { kind: "external"; host: string };

export interface RecoveredAttribution {
  clicks: ClickValues;
  utm: Utm | null;
  path: string;
}

export interface RequestFacts {
  now: number;
  url: URL;
  host: string;
  path: string;
  clicks: ClickValues;
  utm: Utm | null;
  referrer: ReferrerInfo;
  /** Attribution params found on a same-site Referer when the URL itself has none. */
  recovered: RecoveredAttribution | null;
  cookies: Map<string, string>;
  deviceId: string | null;
  country: string | null;
  isEUCountry: boolean;
  gpc: boolean;
  userAgent: string;
  inAppBrowser: string | null;
  headers: Headers;
}

export function readCf(request: RequestLike): CfLike | null {
  const cf = request.cf;
  return cf && typeof cf === "object" ? (cf as CfLike) : null;
}

function validClick(key: ClickKey, raw: string | null): string | null {
  if (raw === null) return null;
  const v = raw.trim();
  if (!v || v.length > (CLICK_MAX_LEN[key] ?? CLICK_MAX_LEN_DEFAULT)) return null;
  return CLICK_VALUE_RE.test(v) ? v : null;
}

export function parseClickIds(params: URLSearchParams): ClickValues {
  const out: ClickValues = {};
  for (const key of CLICK_KEYS) {
    for (const alias of CLICK_PARAM_ALIASES[key]) {
      const v = validClick(key, params.get(alias));
      if (v !== null) {
        out[key] = v;
        break;
      }
    }
  }
  return out;
}

// C0 and C1 controls, DEL, and Unicode line/paragraph separators.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

function cleanText(raw: string, max: number): string {
  const cleaned = raw.replace(CONTROL_RE, " ").trim();
  const points = Array.from(cleaned);
  return points.length > max ? points.slice(0, max).join("") : cleaned;
}

export function parseUtm(params: URLSearchParams): Utm | null {
  const out: Utm = {};
  let any = false;
  for (const field of UTM_FIELDS) {
    const raw = params.get(`utm_${field}`);
    if (raw === null) continue;
    const v = cleanText(raw, UTM_MAX_LEN);
    if (!v || EMAIL_RE.test(v)) continue; // PII has no business in campaign fields
    out[field] = v;
    any = true;
  }
  return any ? out : null;
}

/**
 * The attribution params of a query string and nothing else, validated like a landing and in
 * canonical order: each click key under the alias it arrived with (the first alias holding a valid
 * value, so `im_ref` stays `im_ref`), then the utm_* fields (cleaned; email-like values dropped).
 * Every other param (magic-link codes, reset tokens, emails, app state) is dropped.
 */
export function attributionParams(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of CLICK_KEYS) {
    for (const alias of CLICK_PARAM_ALIASES[key]) {
      const v = validClick(key, params.get(alias));
      if (v !== null) {
        out.set(alias, v);
        break;
      }
    }
  }
  const utm = parseUtm(params);
  if (utm) {
    for (const field of UTM_FIELDS) {
      const v = utm[field];
      if (v) out.set(`utm_${field}`, v);
    }
  }
  return out;
}

function matchesExcluded(host: string, patterns: ReadonlyArray<string | RegExp>): boolean {
  return patterns.some((p) => (typeof p === "string" ? hostInDomain(host, p.toLowerCase()) : p.test(host)));
}

export function parseReferrer(raw: string | null, requestUrl: URL, opts: ResolvedCoreOptions): ReferrerInfo {
  if (!raw) return { kind: "none" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (!["http:", "https:", "android-app:"].includes(u.protocol) || !u.hostname) return { kind: "invalid" };
  const host = u.hostname.toLowerCase();
  if (host.length > HOST_MAX_LEN || !SAFE_HOST_RE.test(host)) return { kind: "invalid" };
  if (host === requestUrl.hostname.toLowerCase() || hostInDomain(host, opts.cookieDomainRoot)) {
    return { kind: "internal", host, url: u };
  }
  if (matchesExcluded(host, opts.excludedReferrers)) return { kind: "excluded", host };
  return { kind: "external", host };
}

/** Routes whose remaining segments are credentials (magic links, resets, invites): keep only the prefix. */
const SENSITIVE_PREFIX_RE =
  /^\/(auth|oauth|login|signin|sign-in|signup|sign-up|register|reset-password|password-reset|forgot-password|magic-link|magic|verify|verify-email|email-verification|confirm|confirm-email|invite|invitation|invitations|unsubscribe|token)(?=\/|$)/i;

/** UUIDs, JWTs, long hex and long mixed-case random strings: the shapes capability tokens take. */
export function isTokenSegment(segment: string): boolean {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    /* keep raw */
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  // Random ids mix case and digits; slugs are lower-case words joined by dashes.
  return s.length >= 20 && /^[A-Za-z0-9_-]+$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.match(/-/g)?.length ?? 0) <= 2;
}

/**
 * True when a pathname carries a credential by landingPath()'s rules: a segment after a sensitive
 * route prefix (a trailing slash alone does not count), or a token-shaped segment anywhere.
 */
export function pathCarriesCredential(pathname: string): boolean {
  const raw = pathname || "/";
  const m = SENSITIVE_PREFIX_RE.exec(raw);
  if (m) return raw.slice(m[0].length).replace(/\/+$/, "").length > 0;
  return raw.split("/").some((seg) => seg !== "" && isTokenSegment(seg));
}

/** Landing pathname with credentials removed (never the query string). */
export function landingPath(url: URL): string {
  const raw = url.pathname || "/";
  const m = SENSITIVE_PREFIX_RE.exec(raw);
  const path = m
    ? raw.length > m[0].length + 1
      ? `${m[0]}/:redacted`
      : m[0]
    : raw
        .split("/")
        .map((seg) => (seg && isTokenSegment(seg) ? ":token" : seg))
        .join("/");
  return path.slice(0, PATH_MAX_LEN) || "/";
}

/**
 * In-app browsers, following the detector OpenArt already ships (01 §T11, bodies/64d5a539…js),
 * narrowed to apps that open links in their own webview.
 */
const IN_APP: ReadonlyArray<readonly [string, RegExp]> = [
  ["instagram", /\binstagram\b/i],
  ["facebook", /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\bFBDV\//i],
  ["tiktok", /musical_ly|bytedancewebview|\bbytelocale\b|\btiktok\b/i],
  ["linkedin", /linkedinapp/i],
  ["snapchat", /snapchat/i],
  ["pinterest", /\bpinterest\b/i],
  ["twitter", /twitter/i],
  ["reddit", /\breddit\b/i],
  ["wechat", /micromessenger/i],
  ["line", /\bline\//i],
  ["telegram", /telegram/i],
  ["discord", /discord/i],
  ["kakaotalk", /kakaotalk/i],
  ["weibo", /weibo/i],
  ["google-app", /\bGSA\//],
];

export function detectInAppBrowser(rawUa: string): string | null {
  const ua = rawUa.slice(0, UA_SCAN_LEN);
  for (const [name, re] of IN_APP) if (re.test(ua)) return name;
  if (/;\s*wv\)/.test(ua)) return "webview";
  if (/\b(iPhone|iPad|iPod)\b/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) return "webview";
  return null;
}

/** User agents are scanned only up to this length: bounds every regex's cost (ReDoS). */
export const UA_SCAN_LEN = 512;

function hasAny(o: object): boolean {
  return Object.keys(o).length > 0;
}

export function extractFacts(request: RequestLike, opts: ResolvedCoreOptions, now: number): RequestFacts {
  const url = new URL(request.url);
  const headers = request.headers;
  const cf = readCf(request);
  const clicks = parseClickIds(url.searchParams);
  const utm = parseUtm(url.searchParams);
  const referrer = parseReferrer(headers.get("referer"), url, opts);

  let recovered: RecoveredAttribution | null = null;
  if (referrer.kind === "internal" && !hasAny(clicks) && !utm) {
    const rClicks = parseClickIds(referrer.url.searchParams);
    const rUtm = parseUtm(referrer.url.searchParams);
    if (hasAny(rClicks) || rUtm) recovered = { clicks: rClicks, utm: rUtm, path: landingPath(referrer.url) };
  }

  const cookies = parseCookieHeader(headers.get("cookie"));
  const rawDevice = cookies.get(opts.deviceIdCookie) ?? null;
  const country = typeof cf?.country === "string" && cf.country ? cf.country.toUpperCase() : null;
  const userAgent = headers.get("user-agent") ?? "";

  return {
    now,
    url,
    host: url.hostname.toLowerCase(),
    path: landingPath(url),
    clicks,
    utm,
    referrer,
    recovered,
    cookies,
    deviceId: rawDevice && DEVICE_ID_RE.test(rawDevice) ? rawDevice : null,
    country,
    isEUCountry: cf?.isEUCountry === "1",
    gpc: headers.get("sec-gpc")?.trim() === "1",
    userAgent,
    inAppBrowser: detectInAppBrowser(userAgent),
    headers,
  };
}
