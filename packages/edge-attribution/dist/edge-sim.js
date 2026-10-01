// src/sim.ts
import { createHmac, timingSafeEqual } from "node:crypto";

// src/core/base64url.ts
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
function bytesToBase64url(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63];
  } else if (rest === 2) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8;
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63];
  }
  return out;
}
function base64urlToBytes(s) {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c] : -1;
    if (v < 0) return null;
    buf = (buf << 6 | v) & 65535;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = buf >> bits & 255;
    }
  }
  if (bits > 0 && (buf & (1 << bits) - 1) !== 0) return null;
  return out.subarray(0, o);
}
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
function utf8(s) {
  return encoder.encode(s);
}
function fromUtf8(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
function utf8Length(s) {
  return encoder.encode(s).length;
}

// src/core/constants.ts
var CLICK_KEYS = [
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
  "sccid"
];
var CLICK_PARAM_ALIASES = {
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
  sccid: ["ScCid", "sccid"]
};
var CLICK_VALUE_RE = /^[A-Za-z0-9._~+/=-]+$/;
var CLICK_MAX_LEN_DEFAULT = 512;
var CLICK_MAX_LEN = { fbclid: 500, ttclid: 1e3 };
var OA_AD_CLIDS_VALUE_RE = /^[A-Za-z0-9._-]{1,512}$/;
var META_FBCLID_RE = /^[\w.~-]{1,500}$/;
var UTM_FIELDS = ["source", "medium", "campaign", "term", "content", "id"];
var UTM_MAX_LEN = 200;
var PATH_MAX_LEN = 200;
var HOST_MAX_LEN = 253;
var SAFE_HOST_RE = /^[a-z0-9._-]+$/;
var COOKIE = {
  attr: "oa_attr",
  adClids: "oa_ad_clids",
  fbc: "_fbc",
  oppref: "__oppref",
  ttclid: "ttclid",
  deviceId: "oa_device_id",
  consent: "oa_consent"
};
var DAY_MS = 864e5;
var TTL = {
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
  kvSeconds: 90 * 86400,
  /** Re-write the KV record at most this often when nothing changed, to keep its TTL alive. */
  kvRefreshMs: 30 * DAY_MS,
  /** In-app-browser handoff token. */
  handoffSeconds: 30 * 60,
  /** Same-URL touches inside this window are one touch (reloads, back/forward). */
  touchDedupeMs: 30 * 6e4,
  /** Tolerated clock skew when validating stored timestamps. */
  skewMs: 5 * 6e4
};
var ATTR_PAIR_BUDGET = 2048;
var AD_CLIDS_PAIR_BUDGET = 1536;
var JAR_BUDGET_BYTES = 4096;
var MAX_PRESERVED_KEYS = 20;
var DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
var MIN_SECRET_LENGTH = 32;

// src/core/options.ts
var DEFAULT_EXCLUDED_REFERRERS = [
  "stripe.com",
  "accounts.google.com",
  "accounts.youtube.com",
  "appleid.apple.com"
];
var DEFAULT_SKIP_PATH_PREFIXES = [
  "/_next/",
  "/suite/_next/",
  "/legacy/_next/",
  "/_astro/",
  "/cdn-cgi/",
  "/api/",
  "/suite/api/",
  "/legacy/api/",
  "/4vu8/",
  "/.well-known/"
];
var DAY_MS2 = 864e5;
function resolveOptions(o = {}) {
  const cookieDomain = (o.cookieDomain ?? ".openart.ai").trim().toLowerCase();
  const days = Math.min(90, Math.max(TTL.ttclidMinMs / DAY_MS2, o.ttclidTtlDays ?? 28));
  return {
    cookieDomain,
    cookieDomainRoot: cookieDomain.replace(/^\./, ""),
    excludedReferrers: [...DEFAULT_EXCLUDED_REFERRERS, ...o.excludedReferrers ?? []],
    skipPathPrefixes: [...DEFAULT_SKIP_PATH_PREFIXES, ...o.skipPathPrefixes ?? []],
    hosts: o.hosts?.map((h) => h.toLowerCase()) ?? null,
    isBot: o.isBot ?? null,
    minBotScore: o.minBotScore ?? 2,
    ttclidTtlMs: Math.round(days) * DAY_MS2,
    deviceIdCookie: o.deviceIdCookie ?? COOKIE.deviceId
  };
}
function hostInDomain(host, root) {
  const h = host.toLowerCase();
  return h === root || h.endsWith(`.${root}`);
}

// src/core/cookies.ts
var TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
var COOKIE_OCTETS_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
var DOMAIN_RE = /^\.?[A-Za-z0-9.-]+$/;
var MAX_AGE_CAP_SECONDS = 400 * 86400;
function isCookieOctets(value) {
  return COOKIE_OCTETS_RE.test(value);
}
function parseCookieHeader(header2) {
  const out = /* @__PURE__ */ new Map();
  if (!header2) return out;
  for (const part of header2.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out.set(name, value);
  }
  return out;
}
function serializeSetCookie(name, value, attrs) {
  if (!TOKEN_RE.test(name)) throw new Error(`invalid cookie name: ${name}`);
  if (!isCookieOctets(value)) throw new Error(`invalid cookie value for ${name}`);
  const parts = [`${name}=${value}`];
  if (attrs.domain) {
    if (!DOMAIN_RE.test(attrs.domain)) throw new Error(`invalid cookie domain: ${attrs.domain}`);
    parts.push(`Domain=${attrs.domain}`);
  }
  parts.push(`Path=${attrs.path ?? "/"}`);
  const maxAge = Number.isFinite(attrs.maxAgeSeconds) ? Math.min(MAX_AGE_CAP_SECONDS, Math.max(0, Math.ceil(attrs.maxAgeSeconds))) : 0;
  parts.push(`Max-Age=${maxAge}`);
  if (attrs.secure !== false) parts.push("Secure");
  if (attrs.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${attrs.sameSite ?? "Lax"}`);
  return parts.join("; ");
}
function setCookieName(line) {
  const eq = line.indexOf("=");
  return (eq === -1 ? line : line.slice(0, eq)).trim();
}

// src/core/parse.ts
function readCf(request) {
  const cf = request.cf;
  return cf && typeof cf === "object" ? cf : null;
}
function validClick(key, raw) {
  if (raw === null) return null;
  const v = raw.trim();
  if (!v || v.length > (CLICK_MAX_LEN[key] ?? CLICK_MAX_LEN_DEFAULT)) return null;
  return CLICK_VALUE_RE.test(v) ? v : null;
}
function parseClickIds(params) {
  const out = {};
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
var CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
var EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
function cleanText(raw, max) {
  const cleaned = raw.replace(CONTROL_RE, " ").trim();
  const points = Array.from(cleaned);
  return points.length > max ? points.slice(0, max).join("") : cleaned;
}
function parseUtm(params) {
  const out = {};
  let any = false;
  for (const field of UTM_FIELDS) {
    const raw = params.get(`utm_${field}`);
    if (raw === null) continue;
    const v = cleanText(raw, UTM_MAX_LEN);
    if (!v || EMAIL_RE.test(v)) continue;
    out[field] = v;
    any = true;
  }
  return any ? out : null;
}
function matchesExcluded(host, patterns) {
  return patterns.some((p) => typeof p === "string" ? hostInDomain(host, p.toLowerCase()) : p.test(host));
}
function parseReferrer(raw, requestUrl, opts) {
  if (!raw) return { kind: "none" };
  let u;
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
var SENSITIVE_PREFIX_RE = /^\/(auth|oauth|login|signin|sign-in|signup|sign-up|register|reset-password|password-reset|forgot-password|magic-link|magic|verify|verify-email|email-verification|confirm|confirm-email|invite|invitation|invitations|unsubscribe|token)(?=\/|$)/i;
function isTokenSegment(segment) {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  return s.length >= 20 && /^[A-Za-z0-9_-]+$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.match(/-/g)?.length ?? 0) <= 2;
}
function landingPath(url) {
  const raw = url.pathname || "/";
  const m = SENSITIVE_PREFIX_RE.exec(raw);
  const path = m ? raw.length > m[0].length + 1 ? `${m[0]}/:redacted` : m[0] : raw.split("/").map((seg) => seg && isTokenSegment(seg) ? ":token" : seg).join("/");
  return path.slice(0, PATH_MAX_LEN) || "/";
}
var IN_APP = [
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
  ["google-app", /\bGSA\//]
];
function detectInAppBrowser(rawUa) {
  const ua = rawUa.slice(0, UA_SCAN_LEN);
  for (const [name, re] of IN_APP) if (re.test(ua)) return name;
  if (/;\s*wv\)/.test(ua)) return "webview";
  if (/\b(iPhone|iPad|iPod)\b/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) return "webview";
  return null;
}
var UA_SCAN_LEN = 512;
function hasAny(o) {
  return Object.keys(o).length > 0;
}
function extractFacts(request, opts, now) {
  const url = new URL(request.url);
  const headers = request.headers;
  const cf = readCf(request);
  const clicks = parseClickIds(url.searchParams);
  const utm = parseUtm(url.searchParams);
  const referrer = parseReferrer(headers.get("referer"), url, opts);
  let recovered = null;
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
    headers
  };
}

// src/core/classify.ts
function classifyRequest(request, url, opts) {
  if (request.method !== "GET") return "method";
  if (opts.hosts && !hostAllowed(url.hostname, opts.hosts)) return "host";
  if (isAssetPath(url.pathname, opts.skipPathPrefixes)) return "asset";
  if (!isDocumentNavigation(request.headers)) return "not-document";
  if (isPrefetch(request.headers)) return "prefetch";
  if (isBotRequest(request, opts)) return "bot";
  return null;
}
function hostAllowed(host, hosts) {
  const h = host.toLowerCase();
  return hosts.some((entry) => entry.startsWith(".") ? hostInDomain(h, entry.slice(1)) : h === entry);
}
var ASSET_EXTENSIONS = /* @__PURE__ */ new Set([
  "js",
  "mjs",
  "cjs",
  "css",
  "map",
  "json",
  "xml",
  "txt",
  "csv",
  "rss",
  "atom",
  "webmanifest",
  "ico",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "m3u8",
  "ts",
  "mp3",
  "m4a",
  "wav",
  "ogg",
  "flac",
  "pdf",
  "zip",
  "gz",
  "br",
  "wasm"
]);
function isAssetPath(pathname, prefixes) {
  const p = pathname.toLowerCase();
  if (prefixes.some((pre) => p.startsWith(pre.toLowerCase()))) return true;
  const last = p.slice(p.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 && ASSET_EXTENSIONS.has(last.slice(dot + 1));
}
function header(headers, name) {
  return (headers.get(name) ?? "").trim().toLowerCase();
}
function isDocumentNavigation(headers) {
  const dest = header(headers, "sec-fetch-dest");
  if (dest) return dest === "document";
  const mode = header(headers, "sec-fetch-mode");
  if (mode && mode !== "navigate") return false;
  return header(headers, "accept").includes("text/html");
}
function isPrefetch(headers) {
  const secPurpose = header(headers, "sec-purpose");
  if (secPurpose.includes("prefetch") || secPurpose.includes("prerender")) return true;
  const purpose = header(headers, "purpose");
  if (purpose === "prefetch" || purpose === "preview") return true;
  const xPurpose = header(headers, "x-purpose");
  if (xPurpose === "preview" || xPurpose === "prefetch") return true;
  return header(headers, "x-moz") === "prefetch";
}
var BOT_TOKENS = [
  "googlebot",
  "adsbot-google",
  "mediapartners-google",
  "google-inspectiontool",
  "googleother",
  "google-extended",
  "storebot-google",
  "apis-google",
  "feedfetcher-google",
  "google-read-aloud",
  "google favicon",
  "google-adwords",
  "bingbot",
  "bingpreview",
  "msnbot",
  "adidxbot",
  "slurp",
  "duckduckbot",
  "baiduspider",
  "yandex",
  "sogou",
  "exabot",
  "facebookexternalhit",
  "facebookcatalog",
  "meta-externalagent",
  "meta-externalfetcher",
  "facebot",
  "twitterbot",
  "linkedinbot",
  "slackbot",
  "slack-imgproxy",
  "discordbot",
  "telegrambot",
  "pinterestbot",
  "pinterest/0.",
  "redditbot",
  "applebot",
  "petalbot",
  "semrushbot",
  "ahrefsbot",
  "mj12bot",
  "dotbot",
  "rogerbot",
  "screaming frog",
  "bytespider",
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "claudebot",
  "claude-user",
  "claude-searchbot",
  "anthropic-ai",
  "perplexitybot",
  "perplexity-user",
  "ccbot",
  "amazonbot",
  "headlesschrome",
  "phantomjs",
  "lighthouse",
  "pagespeed",
  "pingdom",
  "uptimerobot",
  "statuscake",
  "datadog",
  "newrelicpinger",
  "site24x7",
  "ia_archiver",
  "archive.org_bot",
  "embedly",
  "iframely",
  "quora link preview",
  "snap url preview",
  "vkshare",
  "skypeuripreview",
  "bitlybot"
];
var NON_BROWSER_RE = /^(curl|wget|python-requests|python-urllib|python-httpx|aiohttp|httpx|go-http-client|okhttp|java\/|apache-httpclient|libwww-perl|node-fetch|axios|undici|got\b|postmanruntime|insomnia|scrapy|ruby|faraday|php|guzzlehttp|dart:io|reqwest|powershell|whatsapp\/)/i;
var GENERIC_BOT_RES = [
  /(?:bot|crawler|spider|crawling)\/\d/i,
  /compatible;[^;)]*(?:bot|crawler|spider)\b/i,
  /(?:bot|crawler|spider)[^a-z]*https?:\/\//i
];
function isBotUserAgent(raw) {
  if (!raw || !raw.trim()) return true;
  const ua = raw.slice(0, UA_SCAN_LEN);
  const s = ua.toLowerCase();
  if (BOT_TOKENS.some((t) => s.includes(t))) return true;
  if (NON_BROWSER_RE.test(ua.trim())) return true;
  return GENERIC_BOT_RES.some((re) => re.test(ua));
}
function isBotRequest(request, opts) {
  if (opts.isBot) return opts.isBot(request);
  const bm = readCf(request)?.botManagement;
  if (bm) {
    if (bm.verifiedBot === true) return true;
    if (typeof bm.score === "number" && bm.score >= 1 && bm.score < opts.minBotScore) return true;
  }
  return isBotUserAgent(request.headers.get("user-agent"));
}

// src/core/codec.ts
var ATTR_FORMAT_VERSION = "1";
var MAX_ATTR_VALUE_LENGTH = 4096;
var TYPE_TO_CODE = { paid: "p", campaign: "c", referral: "r", direct: "d" };
var CODE_TO_TYPE = { p: "paid", c: "campaign", r: "referral", d: "direct" };
var UTM_TO_CODE = { source: "s", medium: "m", campaign: "c", term: "t", content: "n", id: "i" };
var CODE_TO_UTM = { s: "source", m: "medium", c: "campaign", t: "term", n: "content", i: "id" };
function compactTouch(t) {
  const o = { a: t.at, t: TYPE_TO_CODE[t.type], p: t.landingPath };
  if (t.utm) {
    const u = {};
    for (const f of UTM_FIELDS) if (t.utm[f] !== void 0) u[UTM_TO_CODE[f]] = t.utm[f];
    o.u = u;
  }
  if (t.clickKeys.length) o.k = [...t.clickKeys];
  if (t.referrerHost) o.r = t.referrerHost;
  if (t.inAppBrowser) o.b = t.inAppBrowser;
  if (t.seenBefore) o.sb = 1;
  if (t.recovered) o.rv = 1;
  return o;
}
function compactState(s) {
  const o = { v: 1, c: s.createdAt, f: compactTouch(s.firstTouch), m: s.consentMode === "full" ? "f" : "u" };
  if (s.lastTouch) {
    const l = compactTouch(s.lastTouch);
    o.l = JSON.stringify(l) === JSON.stringify(o.f) ? "f" : l;
  }
  const ids = s.clickIds;
  const keys = [...CLICK_KEYS.filter((k) => ids[k]), ...Object.keys(ids).filter((k) => ids[k] && !isClickKey(k))];
  if (keys.length) {
    const k = {};
    for (const key of keys) k[key] = [ids[key].v, ids[key].ts];
    o.k = k;
  }
  if (s.persistedAt !== null) o.pa = s.persistedAt;
  if (s.handoffFrom) o.hf = s.handoffFrom;
  if (s.boundDevice) o.bd = s.boundDevice;
  if (s.consentKey) o.ck = s.consentKey;
  return o;
}
function encodeStatePayload(state) {
  return bytesToBase64url(utf8(JSON.stringify(compactState(state))));
}
function attrSigningInput(payload) {
  return `oa_attr.${ATTR_FORMAT_VERSION}.${payload}`;
}
function formatAttrCookieValue(payload, tag) {
  return `${ATTR_FORMAT_VERSION}.${payload}.${tag}`;
}
var SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
function splitAttrCookieValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ATTR_VALUE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== ATTR_FORMAT_VERSION) return null;
  const [, payload, tag] = parts;
  if (!SEGMENT_RE.test(payload) || !SEGMENT_RE.test(tag)) return null;
  return { payload, tag };
}
var isInt = (n) => typeof n === "number" && Number.isSafeInteger(n);
var own = (table, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
var CONSENT_KEY_RE = /^[rux][01][01][gd-]{4}o?$/;
var PLAUSIBLE_MS = 15e11;
var HOST_RE = SAFE_HOST_RE;
var PATH_RE = /^\/[\x21-\x7E]*$/;
var IAB_RE = /^[a-z-]{1,32}$/;
var CONTROL_RE2 = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
function validClickValue(key, v) {
  return typeof v === "string" && v.length > 0 && v.length <= (CLICK_MAX_LEN[key] ?? CLICK_MAX_LEN_DEFAULT) && CLICK_VALUE_RE.test(v);
}
function isClickKey(k) {
  return CLICK_KEYS.includes(k);
}
function decodeUtm(u) {
  if (u === void 0) return null;
  if (!u || typeof u !== "object" || Array.isArray(u)) return void 0;
  const out = {};
  let any = false;
  for (const [code, v] of Object.entries(u)) {
    const field = own(CODE_TO_UTM, code);
    if (!field || typeof v !== "string" || !v || CONTROL_RE2.test(v) || Array.from(v).length > UTM_MAX_LEN) return void 0;
    out[field] = v;
    any = true;
  }
  return any ? out : void 0;
}
function decodeTouch(raw, lo, hi) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw;
  if (!isInt(t.a) || t.a < lo || t.a > hi) return null;
  const type = own(CODE_TO_TYPE, t.t);
  if (!type) return null;
  const utm = decodeUtm(t.u);
  if (utm === void 0) return null;
  let clickKeys = [];
  if (t.k !== void 0) {
    if (!Array.isArray(t.k) || t.k.length === 0 || new Set(t.k).size !== t.k.length) return null;
    if (!t.k.every((k) => typeof k === "string" && isClickKey(k))) return null;
    clickKeys = CLICK_KEYS.filter((k) => t.k.includes(k));
  }
  if (t.r !== void 0 && (typeof t.r !== "string" || t.r.length > HOST_MAX_LEN || !HOST_RE.test(t.r))) return null;
  if (typeof t.p !== "string" || t.p.length > PATH_MAX_LEN || !PATH_RE.test(t.p)) return null;
  if (t.b !== void 0 && (typeof t.b !== "string" || !IAB_RE.test(t.b))) return null;
  if (t.sb !== void 0 && t.sb !== 1) return null;
  if (t.rv !== void 0 && t.rv !== 1) return null;
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
    recovered: t.rv === 1
  };
}
function decodeStatePayload(payload, now) {
  if (payload.length > MAX_ATTR_VALUE_LENGTH) return null;
  const bytes = base64urlToBytes(payload);
  if (!bytes) return null;
  const text = fromUtf8(bytes);
  if (text === null) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw;
  if (s.v !== 1) return null;
  if (!isInt(s.c) || s.c < PLAUSIBLE_MS || s.c > now + TTL.skewMs || now - s.c > TTL.attrMs) return null;
  const lo = s.c - TTL.skewMs;
  const hi = now + TTL.skewMs;
  const firstTouch = decodeTouch(s.f, lo, hi);
  if (!firstTouch) return null;
  let lastTouch = null;
  if (s.l !== void 0) {
    lastTouch = s.l === "f" ? { ...firstTouch, utm: firstTouch.utm ? { ...firstTouch.utm } : null, clickKeys: [...firstTouch.clickKeys] } : decodeTouch(s.l, lo, hi);
    if (!lastTouch || lastTouch.type === "direct") return null;
  }
  if (s.m !== "f" && s.m !== "u") return null;
  const clickIds = {};
  if (s.k !== void 0) {
    if (!s.k || typeof s.k !== "object" || Array.isArray(s.k)) return null;
    for (const [key, entry] of Object.entries(s.k)) {
      if (!isClickKey(key) || !Array.isArray(entry) || entry.length !== 2) return null;
      const [v, ts] = entry;
      if (!validClickValue(key, v) || !isInt(ts) || ts < PLAUSIBLE_MS || ts > hi) return null;
      clickIds[key] = { v, ts };
    }
    if (Object.keys(clickIds).length === 0) return null;
    if (s.m === "u") return null;
  }
  if (s.pa !== void 0 && (!isInt(s.pa) || s.pa < PLAUSIBLE_MS || s.pa > hi)) return null;
  if (s.hf !== void 0 && (typeof s.hf !== "string" || !DEVICE_ID_RE.test(s.hf))) return null;
  if (s.bd !== void 0 && (typeof s.bd !== "string" || !DEVICE_ID_RE.test(s.bd) || s.m !== "f")) return null;
  if (s.ck !== void 0 && (typeof s.ck !== "string" || !CONSENT_KEY_RE.test(s.ck))) return null;
  const extra = {};
  if (s.bd !== void 0) extra.boundDevice = s.bd;
  if (s.ck !== void 0) extra.consentKey = s.ck;
  return {
    ...extra,
    createdAt: s.c,
    firstTouch,
    lastTouch,
    clickIds,
    consentMode: s.m === "f" ? "full" : "utm-only",
    persistedAt: s.pa ?? null,
    handoffFrom: s.hf ?? null
  };
}

// ../contracts/src/consent-regions.ts
var EU27_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE"
];
var EEA_EFTA_COUNTRIES = ["IS", "LI", "NO"];
var EU_SPECIAL_TERRITORIES = ["RE", "GF", "GP", "MQ", "YT", "MF", "AX", "IC", "EA"];
var EEA_ADJACENT_CONSENT_COUNTRIES = ["GB", "UK", "CH"];
var CONSENT_REQUIRED_REGIONS = /* @__PURE__ */ new Set([
  ...EU27_COUNTRIES,
  ...EEA_EFTA_COUNTRIES,
  ...EU_SPECIAL_TERRITORIES,
  ...EEA_ADJACENT_CONSENT_COUNTRIES
]);
var UNKNOWN_COUNTRY_CODES = /* @__PURE__ */ new Set(["XX", "T1", "ZZ"]);
function consentCountry(region) {
  if (typeof region !== "string") return null;
  const country = (region.trim().toUpperCase().split("-")[0] ?? "").trim();
  if (!/^[A-Z]{2}$/.test(country) || UNKNOWN_COUNTRY_CODES.has(country)) return null;
  return country === "UK" ? "GB" : country;
}

// src/core/consent.ts
var REGULATED_COUNTRIES = CONSENT_REQUIRED_REGIONS;
var US_PRIVACY_COOKIE = "usprivacy";
function consentRegion(ctx, regulated) {
  if (ctx.isEUCountry) return "regulated";
  const c = consentCountry(ctx.country);
  if (c === null) return "unknown";
  return regulated.has(c) ? "regulated" : "unregulated";
}
function parseUsPrivacyString(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  if (!/^1[YN-]{3}$/.test(s)) return null;
  const flag = s.charAt(2);
  return flag === "Y" ? true : flag === "N" ? false : null;
}
function readOptOutSaleSharing(cookies) {
  const raw = cookies.get(COOKIE.consent);
  if (raw && parseConsentCookieObject(raw)?.opt_out_sale_sharing === true) return true;
  return parseUsPrivacyString(cookies.get(US_PRIVACY_COOKIE)) === true;
}
function createDefaultConsentPolicy(options = {}) {
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
    let signals = {};
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
    const explicit = signals.ad_storage !== void 0 || signals.analytics_storage !== void 0 || optOutApplies;
    const region = consentRegion(ctx, regulated);
    const isRegulated = region === "regulated" || region === "unknown" && unknownIsRegulated;
    const noAds = signals.analytics_storage === "denied" ? "none" : withoutAds;
    let mode;
    let reason;
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
function consentSnapshot(d) {
  return { mode: d.mode, region: d.region, explicit: d.explicit, gpc: d.gpc, optOutSaleSharing: d.optOutSaleSharing === true, signals: { ...d.signals } };
}
var SIGNAL_KEYS = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"];
var asValue = (v) => v === "granted" || v === "denied" ? v : void 0;
function parseConsentModeCookie(raw) {
  const obj = parseConsentCookieObject(raw);
  if (!obj) return null;
  const out = {};
  for (const k of SIGNAL_KEYS) {
    const v = asValue(obj[k]);
    if (v) out[k] = v;
  }
  return out;
}
function parseConsentCookieObject(raw) {
  let text = raw;
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      text = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
}
var REGIONS = /* @__PURE__ */ new Set(["regulated", "unregulated", "unknown"]);
function normalizeDecision(d) {
  const o = d ?? {};
  const ok = (o.mode === "full" || o.mode === "utm-only" || o.mode === "none") && typeof o.region === "string" && REGIONS.has(o.region) && typeof o.explicit === "boolean" && typeof o.gpc === "boolean" && (o.optOutSaleSharing === void 0 || typeof o.optOutSaleSharing === "boolean") && !!o.signals && typeof o.signals === "object";
  if (ok) return { decision: { ...o, optOutSaleSharing: o.optOutSaleSharing === true }, error: null };
  return {
    decision: { mode: "none", region: "unknown", explicit: false, gpc: false, optOutSaleSharing: false, signals: {}, reason: "invalid-policy-output" },
    error: new Error(`consent policy returned an invalid decision (mode: ${String(o.mode)}); failing closed`)
  };
}
function consentFingerprint(d) {
  const sig = (v) => v === "granted" ? "g" : v === "denied" ? "d" : "-";
  const region = d.region === "regulated" ? "r" : d.region === "unregulated" ? "u" : "x";
  const s = d.signals;
  return `${region}${d.explicit ? 1 : 0}${d.gpc ? 1 : 0}${sig(s.ad_storage)}${sig(s.analytics_storage)}${sig(s.ad_user_data)}${sig(s.ad_personalization)}${d.optOutSaleSharing ? "o" : ""}`;
}

// src/core/secrets.ts
var PLACEHOLDER_SECRETS = /* @__PURE__ */ new Set(["replace-with-32-or-more-random-characters"]);
function isUsableSecret(s) {
  return typeof s === "string" && s.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_SECRETS.has(s) && new Set(s).size >= 12;
}

// src/core/clicks.ts
var RANK = { cookie: 1, vault: 2, referrer: 3, url: 4 };
function isValidClickValue(key, v) {
  return typeof v === "string" && v.length > 0 && v.length <= (CLICK_MAX_LEN[key] ?? CLICK_MAX_LEN_DEFAULT) && CLICK_VALUE_RE.test(v);
}
function resolveClickIds(candidates, now, maxAgeMs = TTL.adClidsMs) {
  const byKey = /* @__PURE__ */ new Map();
  for (const c of candidates) {
    if (!isValidClickValue(c.key, c.v) || !Number.isFinite(c.ts)) continue;
    const ts = Math.min(Math.trunc(c.ts), now);
    if (now - ts >= maxAgeMs) continue;
    const list = byKey.get(c.key) ?? [];
    list.push({ ...c, ts });
    byKey.set(c.key, list);
  }
  const out = {};
  for (const key of CLICK_KEYS) {
    const list = byKey.get(key);
    if (!list) continue;
    list.sort((a, b) => a.ts - b.ts || a.rank - b.rank || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
    let cur;
    for (const c of list) if (!cur || c.v !== cur.v) cur = c;
    if (cur) out[key] = { v: cur.v, ts: cur.ts };
  }
  return out;
}
function vaultCandidates(ids, rank) {
  return CLICK_KEYS.filter((k) => ids[k]).map((k) => ({ key: k, v: ids[k].v, ts: ids[k].ts, rank }));
}
var SAFE_JSON_KEY = /^[A-Za-z0-9_]{1,64}$/;
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var isClickKey2 = (k) => CLICK_KEYS.includes(k);
function parseAdClidsCookie(raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const known = {};
  const unknown = [];
  for (const [k, e] of Object.entries(obj)) {
    if (!e || typeof e !== "object") continue;
    const { v, ts } = e;
    if (typeof v !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (isClickKey2(k)) {
      if (isValidClickValue(k, v)) known[k] = { v, ts };
    } else if (SAFE_JSON_KEY.test(k) && !FORBIDDEN_KEYS.has(k) && OA_AD_CLIDS_VALUE_RE.test(v)) {
      unknown.push([k, { v, ts }]);
    }
  }
  return { known, unknown };
}
var AD_CLIDS_PRIORITY = [
  "gclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "gbraid",
  "wbraid",
  ...CLICK_KEYS.filter((k) => !["gclid", "fbclid", "msclkid", "ttclid", "gbraid", "wbraid"].includes(k))
];
function buildAdClidsCookie(ids, preserved, now) {
  const fresh = (e) => now - e.ts < TTL.adClidsMs;
  const pool = /* @__PURE__ */ new Map();
  for (const k of AD_CLIDS_PRIORITY) {
    const e = ids[k];
    if (e && fresh(e) && OA_AD_CLIDS_VALUE_RE.test(e.v)) pool.set(k, e);
  }
  let kept = 0;
  for (const [k, e] of preserved) {
    if (pool.has(k) || kept >= MAX_PRESERVED_KEYS) continue;
    const clamped = { v: e.v, ts: Math.min(e.ts, now) };
    if (!fresh(clamped)) continue;
    pool.set(k, clamped);
    kept++;
  }
  const chosen = /* @__PURE__ */ new Map();
  for (const [k, e] of pool) {
    chosen.set(k, e);
    if (utf8Length(`${COOKIE.adClids}=${encodeAdClids(ordered(chosen))}`) > AD_CLIDS_PAIR_BUDGET) chosen.delete(k);
  }
  if (chosen.size === 0) return null;
  const entries = ordered(chosen);
  return { value: encodeAdClids(entries), entries, newestTs: Math.max(...entries.map(([, e]) => e.ts)) };
}
function ordered(m) {
  const known = CLICK_KEYS.filter((k) => m.has(k)).map((k) => [k, m.get(k)]);
  const rest = [...m].filter(([k]) => !isClickKey2(k));
  return [...known, ...rest];
}
function encodeAdClids(entries) {
  const obj = /* @__PURE__ */ Object.create(null);
  for (const [k, e] of entries) obj[k] = { v: e.v, ts: e.ts };
  return encodeURIComponent(JSON.stringify(obj));
}
function sameAdClids(entries, current) {
  if (!current) return false;
  const have = new Map([...CLICK_KEYS.filter((k) => current.known[k]).map((k) => [k, current.known[k]]), ...current.unknown]);
  if (have.size !== entries.length) return false;
  return entries.every(([k, e]) => {
    const h = have.get(k);
    return !!h && h.v === e.v && h.ts === e.ts;
  });
}
var FBC_APPENDIX = /* @__PURE__ */ new Set(["AQ", "Ag", "Aw", "BA", "BQ", "Bg"]);
function packFbc(fbclid, ts) {
  return `fb.1.${ts}.${fbclid.replace(/\./g, "__DOT__")}`;
}
function unpackFbc(raw) {
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
  const [ver, idx, ct, payload, appendix] = parts;
  if (ver !== "fb" || !/^\d+$/.test(idx) || !/^\d+$/.test(ct) || !payload) return null;
  if (appendix !== void 0 && !(/^[A-Za-z0-9_-]{8}$/.test(appendix) || FBC_APPENDIX.has(appendix))) return null;
  const fbclid = payload.replace(/__DOT__/g, ".");
  if (!META_FBCLID_RE.test(fbclid)) return null;
  return { subdomainIndex: Number(idx), creationTime: Number(ct), payload: fbclid, appendix: appendix ?? null };
}
function formatFbc(f) {
  return `fb.${f.subdomainIndex}.${f.creationTime}.${f.payload.replace(/\./g, "__DOT__")}${f.appendix ? `.${f.appendix}` : ""}`;
}
function isMetaFbclid(v) {
  return META_FBCLID_RE.test(v);
}
function parseTtclidCookie(raw) {
  const e = raw.lastIndexOf(".");
  const suffix = raw.slice(e + 1);
  return e <= 0 || !/^\d{13}$/.test(suffix) ? { clickId: raw, observedAt: null } : { clickId: raw.slice(0, e), observedAt: Number(suffix) };
}
function formatTtclidCookie(clickId, ts) {
  const t = String(ts);
  return /^\d{13}$/.test(t) ? `${clickId}.${t}` : null;
}

// src/core/record.ts
function deriveFbc(ids, existingCookie, now) {
  const f = ids.fbclid;
  if (!f || !isMetaFbclid(f.v) || now - f.ts >= TTL.fbcMs) return null;
  const existing = unpackFbc(existingCookie);
  return existing && existing.payload === f.v ? formatFbc(existing) : packFbc(f.v, f.ts);
}
function toRecord(state, consent, now, deviceId, existingFbcCookie) {
  return {
    schema: "oa_attr/1",
    createdAt: state.createdAt,
    expiresAt: state.createdAt + TTL.attrMs,
    updatedAt: now,
    firstTouch: state.firstTouch,
    lastTouch: state.lastTouch,
    clickIds: state.clickIds,
    fbc: deriveFbc(state.clickIds, existingFbcCookie, now),
    consent,
    deviceId,
    handoffFrom: state.handoffFrom
  };
}

// src/core/plan.ts
var PROJECTION_COOKIES = [COOKIE.adClids, COOKIE.fbc, COOKIE.ttclid, COOKIE.oppref];
var JAR_DROP_ORDER = [COOKIE.oppref, COOKIE.ttclid, COOKIE.adClids, COOKIE.fbc];
var EVICTION_ORDER = [
  "epik",
  "sccid",
  "irclickid",
  "dclid",
  "twclid",
  "li_fat_id",
  "rdt_cid",
  "oppref",
  "wbraid",
  "gbraid",
  "msclkid",
  "ttclid",
  "fbclid",
  "gclid"
];
var LATE_FIELDS_RESERVE = 96;
function attrPairBytes(payloadLength) {
  return `${COOKIE.attr}=`.length + 2 + payloadLength + 1 + 43;
}
var ATTR_PAYLOAD_BUDGET = ATTR_PAIR_BUDGET - attrPairBytes(0) - LATE_FIELDS_RESERVE;
function cookieDomainFor(host, opts) {
  return hostInDomain(host, opts.cookieDomainRoot) ? opts.cookieDomain : null;
}
function expireCookie(name, domain, httpOnly = false) {
  return serializeSetCookie(name, "", { domain, maxAgeSeconds: 0, httpOnly });
}
function cloneState(s) {
  return {
    ...s,
    firstTouch: cloneTouch(s.firstTouch),
    lastTouch: s.lastTouch ? cloneTouch(s.lastTouch) : null,
    clickIds: Object.fromEntries(Object.entries(s.clickIds).map(([k, e]) => [k, { ...e }]))
  };
}
function cloneTouch(t) {
  return { ...t, utm: t.utm ? { ...t.utm } : null, clickKeys: [...t.clickKeys] };
}
function hasAny2(o) {
  return Object.keys(o).length > 0;
}
function contentKey(s) {
  return encodeStatePayload({ ...s, persistedAt: null });
}
function touchKey(t) {
  if (!t) return "null";
  const utm = t.utm ? UTM_FIELDS.map((f) => t.utm[f] ?? null) : null;
  return JSON.stringify([t.at, t.type, t.landingPath, t.referrerHost, t.inAppBrowser, t.seenBefore, t.recovered, t.clickKeys, utm]);
}
function buildTouch(facts, isFirst) {
  let clicks = facts.clicks;
  let utm = facts.utm;
  let path = facts.path;
  let referrerHost = facts.referrer.kind === "external" ? facts.referrer.host : null;
  let recovered = false;
  if (!hasAny2(clicks) && !utm && facts.recovered) {
    clicks = facts.recovered.clicks;
    utm = facts.recovered.utm;
    path = facts.recovered.path;
    referrerHost = null;
    recovered = true;
  }
  const clickKeys = CLICK_KEYS.filter((k) => clicks[k] !== void 0);
  const type = clickKeys.length ? "paid" : utm ? "campaign" : referrerHost ? "referral" : "direct";
  return {
    at: facts.now,
    type,
    utm: utm ? { ...utm } : null,
    clickKeys,
    referrerHost,
    landingPath: path,
    inAppBrowser: facts.inAppBrowser,
    seenBefore: isFirst && facts.deviceId !== null,
    recovered
  };
}
function utmEqual(a, b) {
  if (!a || !b) return a === b;
  return UTM_FIELDS.every((f) => a[f] === b[f]);
}
function sameTouch(a, b, ignoreReferrer) {
  return a.type === b.type && a.landingPath === b.landingPath && a.clickKeys.join(",") === b.clickKeys.join(",") && utmEqual(a.utm, b.utm) && (ignoreReferrer || a.referrerHost === b.referrerHost);
}
function replacesLastTouch(state, touch, now, newClickValue) {
  const last = state.lastTouch;
  if (touch.recovered) {
    return !(last && sameTouch(last, touch, true)) && !sameTouch(state.firstTouch, touch, true);
  }
  if (!last || !sameTouch(last, touch, false)) return true;
  return newClickValue || now - last.at >= TTL.touchDedupeMs;
}
function mergeStates(a, b, now) {
  const firstTouch = b.firstTouch.at < a.firstTouch.at ? b.firstTouch : a.firstTouch;
  const lasts = [a.lastTouch, b.lastTouch].filter((t) => t !== null);
  const lastTouch = lasts.length ? lasts.reduce((x, y) => y.at > x.at ? y : x) : null;
  return cloneState({
    createdAt: Math.min(a.createdAt, b.createdAt),
    firstTouch,
    lastTouch,
    clickIds: resolveClickIds([...vaultCandidates(a.clickIds, RANK.vault), ...vaultCandidates(b.clickIds, RANK.vault)], now),
    consentMode: a.consentMode === "full" && b.consentMode === "full" ? "full" : "utm-only",
    persistedAt: null,
    handoffFrom: b.handoffFrom ?? a.handoffFrom,
    boundDevice: a.boundDevice ?? null,
    consentKey: a.consentKey ?? null
  });
}
function cookieCandidates(facts) {
  const out = [];
  const parsed = parseAdClidsCookie(facts.cookies.get(COOKIE.adClids));
  if (parsed) {
    for (const k of CLICK_KEYS) if (parsed.known[k]) out.push({ key: k, ...parsed.known[k], rank: RANK.cookie });
  }
  const fbc = unpackFbc(facts.cookies.get(COOKIE.fbc));
  if (fbc) out.push({ key: "fbclid", v: fbc.payload, ts: fbc.creationTime, rank: RANK.cookie });
  const tt = facts.cookies.get(COOKIE.ttclid);
  if (tt) {
    const p = parseTtclidCookie(tt);
    out.push({ key: "ttclid", v: p.clickId, ts: p.observedAt ?? facts.now, rank: RANK.cookie });
  }
  const op = facts.cookies.get(COOKIE.oppref);
  if (op) out.push({ key: "oppref", v: op, ts: facts.now, rank: RANK.cookie });
  return out;
}
function requestCandidates(facts, known) {
  const out = [];
  for (const k of CLICK_KEYS) {
    const v = facts.clicks[k];
    if (v) out.push({ key: k, v, ts: facts.now, rank: RANK.url });
    const r = facts.recovered?.clicks[k];
    if (r && !known.has(k)) out.push({ key: k, v: r, ts: facts.now, rank: RANK.referrer });
  }
  return out;
}
function truncate(s, n) {
  const p = Array.from(s);
  return p.length > n ? p.slice(0, n).join("") : s;
}
function shrinkTouch(t, n) {
  const utm = t.utm ? Object.fromEntries(Object.entries(t.utm).map(([k, v]) => [k, truncate(v, n)])) : null;
  return { ...t, utm, landingPath: t.landingPath.slice(0, n) || "/" };
}
function minimalTouch(t) {
  return { ...t, utm: null, referrerHost: null, landingPath: "/" };
}
function fitToBudget(state, protectedKeys) {
  const fits = (s2) => encodeStatePayload(s2).length <= ATTR_PAYLOAD_BUDGET;
  if (fits(state)) return { state, trimmed: false };
  const s = cloneState(state);
  const evict = (keys) => {
    const order = [...keys].sort(
      (x, y) => s.clickIds[x].ts - s.clickIds[y].ts || EVICTION_ORDER.indexOf(x) - EVICTION_ORDER.indexOf(y)
    );
    for (const k of order) {
      if (fits(s)) return;
      delete s.clickIds[k];
    }
  };
  evict(CLICK_KEYS.filter((k) => s.clickIds[k] && !protectedKeys.has(k)));
  if (!fits(s)) {
    s.firstTouch = shrinkTouch(s.firstTouch, 64);
    if (s.lastTouch) s.lastTouch = shrinkTouch(s.lastTouch, 64);
  }
  evict(CLICK_KEYS.filter((k) => s.clickIds[k]));
  if (!fits(s)) {
    s.firstTouch = minimalTouch(s.firstTouch);
    if (s.lastTouch) s.lastTouch = minimalTouch(s.lastTouch);
  }
  return { state: s, trimmed: true };
}
function projection(name, value, maxAgeSeconds, domain, reason) {
  return { name, line: serializeSetCookie(name, value, { domain, maxAgeSeconds }), pair: utf8Length(`${name}=${value}`), reason };
}
function projections(state, facts, opts, domain) {
  const now = facts.now;
  const out = [];
  const secs = (ms) => ms / 1e3;
  const current = parseAdClidsCookie(facts.cookies.get(COOKIE.adClids));
  const desired = buildAdClidsCookie(state.clickIds, current?.unknown ?? [], now);
  if (desired && !sameAdClids(desired.entries, current)) {
    out.push(projection(COOKIE.adClids, desired.value, secs(desired.newestTs + TTL.adClidsMs - now), domain, `cookie:${COOKIE.adClids}`));
  }
  const f = state.clickIds.fbclid;
  if (f && isMetaFbclid(f.v) && now - f.ts < TTL.fbcMs) {
    const existing = unpackFbc(facts.cookies.get(COOKIE.fbc));
    if (!existing || existing.payload !== f.v) {
      const reason = existing ? "fbc:replaced" : facts.cookies.has(COOKIE.fbc) ? "fbc:repaired" : "fbc:set";
      out.push(projection(COOKIE.fbc, packFbc(f.v, f.ts), secs(f.ts + TTL.fbcMs - now), domain, reason));
    }
  }
  const t = state.clickIds.ttclid;
  if (t && now - t.ts < opts.ttclidTtlMs) {
    const cur = facts.cookies.get(COOKIE.ttclid);
    const value = formatTtclidCookie(t.v, t.ts);
    if (value && (!cur || parseTtclidCookie(cur).clickId !== t.v)) {
      out.push(projection(COOKIE.ttclid, value, secs(t.ts + opts.ttclidTtlMs - now), domain, `cookie:${COOKIE.ttclid}`));
    }
  }
  const o = state.clickIds.oppref;
  if (o && now - o.ts < TTL.opprefMs && facts.cookies.get(COOKIE.oppref) !== o.v) {
    out.push(projection(COOKIE.oppref, o.v, secs(o.ts + TTL.opprefMs - now), domain, `cookie:${COOKIE.oppref}`));
  }
  return out;
}
function withinJarBudget(emitted, attrPair, facts, changes) {
  const stored = (name) => {
    const v = facts.cookies.get(name);
    return v === void 0 ? 0 : utf8Length(`${name}=${v}`);
  };
  let total = attrPair + PROJECTION_COOKIES.reduce((sum, n) => sum + (emitted.find((p) => p.name === n)?.pair ?? stored(n)), 0);
  const kept = [...emitted];
  for (const name of JAR_DROP_ORDER) {
    if (total <= JAR_BUDGET_BYTES) break;
    const i = kept.findIndex((p) => p.name === name);
    if (i === -1) continue;
    total -= kept[i].pair - stored(name);
    kept.splice(i, 1);
    changes.push(`budget:skipped:${name}`);
  }
  for (const p of kept) changes.push(p.reason);
  return kept.map((p) => p.line);
}
function planCapture(input) {
  const { facts, consent, opts } = input;
  const now = facts.now;
  const domain = cookieDomainFor(facts.host, opts);
  const changes = [];
  const cookies = [];
  if (input.existingInvalid) changes.push("attr:invalid-ignored");
  const purge = () => {
    let any = false;
    for (const name of PROJECTION_COOKIES) {
      if (facts.cookies.has(name)) {
        cookies.push(expireCookie(name, domain));
        changes.push(`purge:${name}`);
        any = true;
      }
    }
    return any;
  };
  const explicitRefusal = consent.explicit && consent.mode !== "full";
  const purged = explicitRefusal ? purge() : false;
  const existing = input.existing?.state ?? null;
  const hadIdentifiers = !!existing && (hasAny2(existing.clickIds) || !!existing.boundDevice || !!existing.handoffFrom);
  const canForget = input.persistenceEnabled && explicitRefusal && facts.deviceId !== null;
  const empty = (expireAttr, forget2) => ({
    state: null,
    emitAttr: false,
    expireAttr,
    cookies,
    persist: "no",
    forget: forget2,
    record: null,
    changes,
    cookieDomain: domain
  });
  if (consent.mode === "none") {
    const expireAttr = facts.cookies.has(COOKIE.attr);
    if (expireAttr) changes.push("attr:removed");
    const forget2 = canForget && (expireAttr || purged);
    if (forget2) changes.push("persist:forget");
    return empty(expireAttr, forget2);
  }
  const mode = consent.mode;
  let state = existing ? cloneState(existing) : null;
  if (input.existing?.needsResign) changes.push("attr:resigned");
  if (input.incoming) {
    state = state ? mergeStates(state, input.incoming, now) : { ...cloneState(input.incoming), boundDevice: null };
    changes.push("handoff:merged");
  }
  const touch = input.noTouch ? null : buildTouch(facts, state === null);
  if (!state) {
    if (!touch) return empty(false, false);
    state = {
      createdAt: now,
      firstTouch: touch,
      lastTouch: touch.type === "direct" ? null : touch,
      clickIds: {},
      consentMode: mode,
      persistedAt: null,
      handoffFrom: null,
      boundDevice: null,
      consentKey: null
    };
  } else if (touch && touch.type !== "direct") {
    const vault = state.clickIds;
    const newClickValue = mode === "full" && touch.clickKeys.some((k) => facts.clicks[k] !== void 0 && vault[k]?.v !== facts.clicks[k]);
    if (replacesLastTouch(state, touch, now, newClickValue)) state.lastTouch = touch;
  }
  const protectedKeys = new Set(CLICK_KEYS.filter((k) => facts.clicks[k] || facts.recovered?.clicks[k]));
  if (mode === "utm-only") {
    state.clickIds = {};
    state.handoffFrom = null;
    state.boundDevice = null;
    state.consentMode = "utm-only";
  } else {
    const held = [...vaultCandidates(state.clickIds, RANK.vault), ...cookieCandidates(facts)];
    const known = new Set(held.map((c) => c.key));
    state.clickIds = resolveClickIds([...held, ...requestCandidates(facts, known)], now);
    state.consentMode = "full";
    if (!state.boundDevice && facts.deviceId) state.boundDevice = facts.deviceId;
  }
  state.consentKey = consentFingerprint(consent);
  const fitted = fitToBudget(state, protectedKeys);
  state = fitted.state;
  const changed = !existing || contentKey(state) !== contentKey(existing);
  if (!existing) {
    changes.push("first-touch");
    if (state.lastTouch) changes.push("last-touch");
  } else if (changed) {
    if (touchKey(state.lastTouch) !== touchKey(existing.lastTouch)) changes.push("last-touch");
    for (const k of CLICK_KEYS) {
      const a = state.clickIds[k];
      const b = existing.clickIds[k];
      if (a?.v !== b?.v || a?.ts !== b?.ts) changes.push(a ? `click:${k}` : `click-removed:${k}`);
    }
    if ((existing.consentKey ?? null) !== state.consentKey) changes.push("consent");
    if (fitted.trimmed) changes.push("budget:trimmed");
  }
  let emit = changed || !!input.existing?.needsResign;
  let persist = "no";
  let forget = false;
  if (mode === "full") {
    const hasSignal = state.lastTouch !== null || hasAny2(state.clickIds);
    const due = hasSignal && (changed || state.persistedAt === null || now - state.persistedAt >= TTL.kvRefreshMs);
    if (input.persistenceEnabled && due) {
      if (facts.deviceId) {
        if (!changed && state.persistedAt !== null) changes.push("persist:refresh");
        state.persistedAt = now;
        emit = true;
        persist = "now";
      } else {
        persist = "awaiting-device-id";
      }
    }
  } else if (canForget && (hadIdentifiers || purged)) {
    forget = true;
    changes.push("persist:forget");
  }
  const attrPair = emit ? attrPairBytes(encodeStatePayload(state).length) : utf8Length(`${COOKIE.attr}=${facts.cookies.get(COOKIE.attr) ?? ""}`);
  if (mode === "full") cookies.push(...withinJarBudget(projections(state, facts, opts, domain), attrPair, facts, changes));
  const record = toRecord(
    state,
    consentSnapshot(consent),
    now,
    mode === "full" ? facts.deviceId : null,
    mode === "full" ? facts.cookies.get(COOKIE.fbc) : void 0
  );
  return { state, emitAttr: emit, expireAttr: false, cookies, persist, forget, record, changes, cookieDomain: domain };
}
function attrSetCookie(signedValue, state, domain, now) {
  return serializeSetCookie(COOKIE.attr, signedValue, {
    domain,
    maxAgeSeconds: (state.createdAt + TTL.attrMs - now) / 1e3,
    httpOnly: true
  });
}
function finalizeSetCookies(plan, signedAttr, now) {
  const head = [];
  if (plan.emitAttr && plan.state && signedAttr) head.push(attrSetCookie(signedAttr, plan.state, plan.cookieDomain, now));
  else if (plan.expireAttr) head.push(expireCookie(COOKIE.attr, plan.cookieDomain, true));
  return [...head, ...plan.cookies];
}

// src/sim.ts
var EDGE_SIM_DEFAULT_SECRET = "edge-sim-not-a-secret-000000000000000";
function mac(secret, data) {
  return bytesToBase64url(new Uint8Array(createHmac("sha256", secret).update(data, "utf8").digest()));
}
function verify(value, secrets, now) {
  const parts = splitAttrCookieValue(value);
  if (!parts) return null;
  const tag = base64urlToBytes(parts.tag);
  if (!tag || tag.length !== 32) return null;
  const input = attrSigningInput(parts.payload);
  const index = secrets.findIndex((s) => {
    const expected = createHmac("sha256", s).update(input, "utf8").digest();
    return timingSafeEqual(expected, tag);
  });
  if (index === -1) return null;
  const state = decodeStatePayload(parts.payload, now);
  return state ? { state, needsResign: index > 0 } : null;
}
var defaultPolicy = createDefaultConsentPolicy();
function simulate(requestUrl, requestHeaders, options = {}) {
  const opts = resolveOptions(options);
  const now = options.now ?? Date.now();
  const headers = new Headers(requestHeaders);
  const country = options.country === void 0 ? "US" : options.country;
  const cf = options.cf ?? (country ? { country } : void 0);
  const request = { url: requestUrl, method: "GET", headers, cf };
  const none = (skipped2) => ({ setCookies: [], skipped: skipped2, record: null, consent: null, changes: [] });
  const skipped = classifyRequest(request, new URL(requestUrl), opts);
  if (skipped) return none(skipped);
  const secret = options.secret ?? EDGE_SIM_DEFAULT_SECRET;
  if (!isUsableSecret(secret)) return none("misconfigured");
  const secrets = isUsableSecret(options.previousSecret) ? [secret, options.previousSecret] : [secret];
  const facts = extractFacts(request, opts, now);
  const { decision: consent } = normalizeDecision(
    (options.consentPolicy ?? defaultPolicy)({
      country: facts.country,
      isEUCountry: facts.isEUCountry,
      cookies: facts.cookies,
      headers: facts.headers,
      gpc: facts.gpc
    })
  );
  const raw = facts.cookies.get(COOKIE.attr);
  const existing = verify(raw, secrets, now);
  const plan = planCapture({
    facts,
    existing,
    existingInvalid: raw !== void 0 && existing === null,
    consent,
    opts,
    persistenceEnabled: options.persistence === true
  });
  let signed = null;
  if (plan.emitAttr && plan.state) {
    const payload = encodeStatePayload(plan.state);
    signed = formatAttrCookieValue(payload, mac(secret, attrSigningInput(payload)));
  }
  return { setCookies: finalizeSetCookies(plan, signed, now), skipped: null, record: plan.record, consent, changes: plan.changes };
}
function applySetCookies(cookieHeader, setCookies) {
  const jar = new Map(parseCookieHeader(cookieHeader));
  for (const line of setCookies) {
    const name = setCookieName(line);
    if (!name) continue;
    const first = line.split(";", 1)[0] ?? "";
    const value = first.slice(first.indexOf("=") + 1).trim();
    const maxAge = /;\s*max-age=(-?\d+)/i.exec(line)?.[1];
    if (maxAge !== void 0 && Number(maxAge) <= 0) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
export {
  EDGE_SIM_DEFAULT_SECRET,
  applySetCookies,
  simulate
};
