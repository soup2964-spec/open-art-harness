// Decides whether a request is a real top-level page view worth attributing.
import { hostInDomain } from "./options.js";
import type { ResolvedCoreOptions } from "./options.js";
import { UA_SCAN_LEN, readCf } from "./parse.js";
import type { RequestLike } from "./parse.js";

export type SkipReason = "method" | "host" | "asset" | "not-document" | "prefetch" | "bot";

export function classifyRequest(request: RequestLike, url: URL, opts: ResolvedCoreOptions): SkipReason | null {
  if (request.method !== "GET") return "method";
  if (opts.hosts && !hostAllowed(url.hostname, opts.hosts)) return "host";
  if (isAssetPath(url.pathname, opts.skipPathPrefixes)) return "asset";
  if (!isDocumentNavigation(request.headers)) return "not-document";
  if (isPrefetch(request.headers)) return "prefetch";
  if (isBotRequest(request, opts)) return "bot";
  return null;
}

export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((entry) => (entry.startsWith(".") ? hostInDomain(h, entry.slice(1)) : h === entry));
}

const ASSET_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "css", "map", "json", "xml", "txt", "csv", "rss", "atom", "webmanifest",
  "ico", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "tif", "tiff", "heic",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "webm", "mov", "m4v", "m3u8", "ts", "mp3", "m4a", "wav", "ogg", "flac",
  "pdf", "zip", "gz", "br", "wasm",
]);

export function isAssetPath(pathname: string, prefixes: readonly string[]): boolean {
  const p = pathname.toLowerCase();
  if (prefixes.some((pre) => p.startsWith(pre.toLowerCase()))) return true;
  const last = p.slice(p.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 && ASSET_EXTENSIONS.has(last.slice(dot + 1));
}

function header(headers: Headers, name: string): string {
  return (headers.get(name) ?? "").trim().toLowerCase();
}

/**
 * Sec-Fetch-Dest: document is authoritative when sent (all current engines, Safari since 16.4).
 * Otherwise fall back to a navigate mode or an Accept header that asks for HTML.
 */
export function isDocumentNavigation(headers: Headers): boolean {
  const dest = header(headers, "sec-fetch-dest");
  if (dest) return dest === "document";
  const mode = header(headers, "sec-fetch-mode");
  if (mode && mode !== "navigate") return false;
  return header(headers, "accept").includes("text/html");
}

/** Speculative loads that may never become a visit: Speculation Rules, <link rel=prefetch>, legacy variants. */
export function isPrefetch(headers: Headers): boolean {
  const secPurpose = header(headers, "sec-purpose");
  if (secPurpose.includes("prefetch") || secPurpose.includes("prerender")) return true;
  const purpose = header(headers, "purpose");
  if (purpose === "prefetch" || purpose === "preview") return true;
  const xPurpose = header(headers, "x-purpose");
  if (xPurpose === "preview" || xPurpose === "prefetch") return true;
  return header(headers, "x-moz") === "prefetch";
}

/** Crawlers, link unfurlers, monitors and headless tools (lower-case substrings). */
const BOT_TOKENS = [
  "googlebot", "adsbot-google", "mediapartners-google", "google-inspectiontool", "googleother",
  "google-extended", "storebot-google", "apis-google", "feedfetcher-google", "google-read-aloud",
  "google favicon", "google-adwords", "bingbot", "bingpreview", "msnbot", "adidxbot", "slurp",
  "duckduckbot", "baiduspider", "yandex", "sogou", "exabot", "facebookexternalhit", "facebookcatalog",
  "meta-externalagent", "meta-externalfetcher", "facebot", "twitterbot", "linkedinbot", "slackbot",
  "slack-imgproxy", "discordbot", "telegrambot", "pinterestbot", "pinterest/0.", "redditbot", "applebot",
  "petalbot", "semrushbot", "ahrefsbot", "mj12bot", "dotbot", "rogerbot", "screaming frog", "bytespider",
  "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-user", "claude-searchbot", "anthropic-ai",
  "perplexitybot", "perplexity-user", "ccbot", "amazonbot", "headlesschrome", "phantomjs", "lighthouse",
  "pagespeed", "pingdom", "uptimerobot", "statuscake", "datadog", "newrelicpinger", "site24x7",
  "ia_archiver", "archive.org_bot", "embedly", "iframely", "quora link preview", "snap url preview",
  "vkshare", "skypeuripreview", "bitlybot",
];

/** Non-browser HTTP clients (anchored at the start of the UA). */
const NON_BROWSER_RE =
  /^(curl|wget|python-requests|python-urllib|python-httpx|aiohttp|httpx|go-http-client|okhttp|java\/|apache-httpclient|libwww-perl|node-fetch|axios|undici|got\b|postmanruntime|insomnia|scrapy|ruby|faraday|php|guzzlehttp|dart:io|reqwest|powershell|whatsapp\/)/i;

/**
 * Generic crawler shapes: "Foobot/1.2", "(compatible; FooBot; +http://...)", "... bot +http://...".
 * A bare "bot" suffix is deliberately NOT enough: phones such as "CUBOT X30" would match.
 */
const GENERIC_BOT_RES = [
  /(?:bot|crawler|spider|crawling)\/\d/i,
  /compatible;[^;)]*(?:bot|crawler|spider)\b/i,
  /(?:bot|crawler|spider)[^a-z]*https?:\/\//i,
];

export function isBotUserAgent(raw: string | null | undefined): boolean {
  if (!raw || !raw.trim()) return true;
  const ua = raw.slice(0, UA_SCAN_LEN); // bounds regex cost on hostile 16 KB headers
  const s = ua.toLowerCase();
  if (BOT_TOKENS.some((t) => s.includes(t))) return true;
  if (NON_BROWSER_RE.test(ua.trim())) return true;
  return GENERIC_BOT_RES.some((re) => re.test(ua));
}

export function isBotRequest(request: RequestLike, opts: ResolvedCoreOptions): boolean {
  if (opts.isBot) return opts.isBot(request);
  const bm = readCf(request)?.botManagement;
  if (bm) {
    if (bm.verifiedBot === true) return true;
    if (typeof bm.score === "number" && bm.score >= 1 && bm.score < opts.minBotScore) return true;
  }
  return isBotUserAgent(request.headers.get("user-agent"));
}
