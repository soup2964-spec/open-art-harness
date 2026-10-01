// The COLLECTION SEAL: the per-request decision the watchdog applies at the CDP Fetch layer while
// openart.ai pages load and journeys run (before any full seal).
//
//   ALLOW  GET documents / scripts / stylesheets / fonts / images / media needed to render
//          openart.ai: first-party requests only when they match an explicit allowlist
//          (FIRST_PARTY_RULES: build assets, the CDN, the gateway container/config loader and the
//          read-only app APIs seen in the saved journeys; page navigations and RSC route data), and
//          third-party requests only when they match RENDER_RULES (SDK scripts, fonts).
//   FAIL   every request to a known measurement/collection endpoint (any method, any type, host and
//          percent-decoded path both checked), every non-GET request, every third-party request
//          that would carry a synthetic WD_TEST marker, every service-worker script, every
//          first-party request that is not on the allowlist ("first-party-unlisted", reported for
//          review), and everything else (default deny).
//
// Transport: first-party requests go through the gatekeeper proxy, whose allowConnectHost()
// admits first-party hosts ONLY; allowed third-party GETs are fetched by the watchdog itself and
// fulfilled (transport 'node'), so the browser has no route to any third-party host at all — a
// request CDP never saw (browser-process traffic) cannot reach an ad platform.
import type { Platform } from '../types.js';
import { containsMarker } from '../markers.js';

export interface PolicyRequest {
  url: string;
  method: string;
  resourceType: string;
  headers?: Record<string, string>;
  /** True for frame navigations (top-level or iframe Document requests). */
  isNavigation?: boolean;
}

export interface PolicyContext {
  markers: string[];
  /** Extra render hosts (only the pilot adds example.com here). */
  extraHosts?: RegExp[];
  /** Extra collection rules (only the pilot adds its probe path here). */
  extraCollection?: CollectionRule[];
}

export interface Decision {
  action: 'allow' | 'fail';
  reason: string;
  collection: boolean;
  rule?: string;
  platform?: Platform | string;
  /** For allowed requests: through the proxy tunnel (first party) or fetched by the watchdog (third party). */
  transport?: 'tunnel' | 'node';
}

export interface CollectionRule {
  id: string;
  platform: Platform | string;
  host: RegExp;
  /** Path must match (default: any path). */
  path?: RegExp;
  /** Path must NOT match (used for hosts that also serve allowed scripts). */
  exceptPath?: RegExp;
}

// --------------------------------------------------------------------------------------------
// Known measurement / collection endpoints (labelled, always failed). Sources: the endpoint
// inventories in research/01 §2-§4 and research/11 §3.3, plus every host seen in
// crawl/teardown2/T*.json.
// --------------------------------------------------------------------------------------------
export const COLLECTION_RULES: CollectionRule[] = [
  // Google Ads / Google tag (incl. the first-party Google tag gateway at /4vu8/)
  { id: 'google.googleadservices', platform: 'google_ads', host: /(^|\.)googleadservices\.com$/ },
  { id: 'google.doubleclick', platform: 'google_ads', host: /(^|\.)doubleclick\.net$/ },
  { id: 'google.collect', platform: 'google_ads', host: /(^|\.)google\.[a-z.]{2,6}$/, path: /^\/(ccm|rmkt|pagead|measurement|ads|g\/collect|j\/collect|gen_204|log|xjs)/ },
  { id: 'google.analytics', platform: 'ga4', host: /(^|\.)(google-analytics\.com|analytics\.google\.com|googlesyndication\.com|googletagservices\.com)$/ },
  {
    id: 'google.gtm-non-script', platform: 'google_ads', host: /^www\.googletagmanager\.com$/,
    exceptPath: /^\/(gtm\.js|gtag\/js|gtag\/destination)$/,
  },
  {
    id: 'google.gateway-collect', platform: 'google_ads', host: /(^|\.)openart\.ai$/, path: /^\/4vu8\//,
    // container (/4vu8/), config (/4vu8/<long token>) and explicit loaders are the only non-collection paths
    exceptPath: /^\/4vu8\/(?:|[A-Za-z0-9_-]{20,}|gtm\.js|gtag\/js|gtag\/destination)$/,
  },
  { id: 'google.logging', platform: 'google_ads', host: /^(play\.google\.com|accounts\.google\.com)$/, path: /^\/(log|gsi\/log)/ },
  // Meta: pixel endpoint + Conversions API Gateway (AWS ECS primary, GCP Cloud Run fallback)
  { id: 'meta.pixel', platform: 'meta', host: /(^|\.)facebook\.com$/ },
  { id: 'meta.capig', platform: 'meta', host: /\.on\.aws$|\.run\.app$/ },
  { id: 'meta.graph', platform: 'meta', host: /^graph\.facebook\.com$/ },
  // TikTok
  { id: 'tiktok.api', platform: 'tiktok', host: /(^|\.)tiktok\.com$/, path: /^\/api\// },
  { id: 'tiktok.enrich', platform: 'tiktok', host: /(^|\.)tiktokw\.us$/ },
  // Reddit
  { id: 'reddit.alb', platform: 'reddit', host: /(^|\.)reddit\.com$/ },
  // LinkedIn
  { id: 'linkedin.px', platform: 'linkedin', host: /(^|\.)ads\.linkedin\.com$/ },
  { id: 'linkedin.sync', platform: 'linkedin', host: /^www\.linkedin\.com$/, path: /^\/(px|li)\// },
  // X
  { id: 'x.tco', platform: 'x', host: /^t\.co$/ },
  { id: 'x.analytics', platform: 'x', host: /(^|\.)analytics\.twitter\.com$|^ads-api\.twitter\.com$|^ads\.x\.com$/ },
  { id: 'x.twitter-collect', platform: 'x', host: /(^|\.)twitter\.com$/, path: /\/(adsct|adsctp|jot|oct)/ },
  // Microsoft UET / Clarity
  { id: 'microsoft.uet-action', platform: 'microsoft_uet', host: /^bat\.bing\.(com|net)$/, path: /^\/(action|actionp|p\/conversions\/c|p\/insights\/c)/ },
  { id: 'microsoft.cbing', platform: 'microsoft_uet', host: /^c\.bing\.com$/ },
  { id: 'clarity.collect', platform: 'clarity', host: /(^|\.)clarity\.ms$/, exceptPath: /^\/(tag\/|[0-9.]+\/clarity\.js)/ },
  // OpenAI Ads
  { id: 'openai.events', platform: 'openai_ads', host: /^bzr\.openai\.com$/ },
  // Product analytics / experimentation / affiliates / session replay
  { id: 'amplitude.api', platform: 'amplitude', host: /^(api|api2|api\.eu|api-sr|api2\.eu)\.amplitude\.com$/ },
  { id: 'statsig', platform: 'statsig', host: /(^|\.)(prodregistryv2\.org|statsig\.com|statsigapi\.net|featuregates\.org|featureassets\.org)$/ },
  { id: 'hotjar.collect', platform: 'hotjar', host: /(^|\.)hotjar\.(com|io)$/, exceptPath: /^\/(c\/hotjar-\d+\.js|modules\.[0-9a-f]+\.js|browser-perf\.[0-9a-f]+\.js)$/ },
  { id: 'tolt.api', platform: 'tolt', host: /(^|\.)tolt\.io$|\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/, exceptPath: /^\/tolt\.js$/ },
  { id: 'chargeblast', platform: 'chargeblast', host: /^(api\.chargeblast\.com|api\.ipify\.org|api64\.ipify\.org)$/ },
  { id: 'cloudflare.rum', platform: 'cloudflare_rum', host: /(^|\.)cloudflareinsights\.com$/, path: /^\/cdn-cgi\/rum/ },
  { id: 'cloudflare.nel', platform: 'cloudflare_nel', host: /(^|\.)nel\.cloudflare\.com$/ },
  { id: 'sentry', platform: 'sentry', host: /(^|\.)sentry\.io$|(^|\.)ingest\.sentry\./ },
  { id: 'crm.brevo', platform: 'brevo', host: /(^|\.)(brevo\.com|sibautomation\.com|sendinblue\.com)$/ },
  { id: 'crm.customerio', platform: 'customerio', host: /(^|\.)customer\.io$/ },
  { id: 'affiliate.impact', platform: 'impact', host: /(^|\.)(impact\.com|sjv\.io|ojrq\.net)$/ },
  { id: 'affiliate.firstpromoter', platform: 'firstpromoter', host: /(^|\.)firstpromoter\.com$/ },
  { id: 'launchdarkly.events', platform: 'launchdarkly', host: /^events\.launchdarkly\.com$/ },
  // OpenArt's own first-party tracking endpoints (research/02 §3.3-§3.5)
  {
    id: 'openart.tracking', platform: 'openart_first_party', host: /(^|\.)openart\.ai$/,
    path: /^\/(cdn-cgi\/rum|(suite\/|legacy\/)?api\/user\/ad-click-ids|(suite\/|legacy\/)?api\/(tracking|analytics|collect|ingest|beacon|pixel)|(suite\/|legacy\/)?api\/(track|tracks|log|logs|logging|event|events|telemetry|metrics)(\/|$)|ingest\/|monitoring(\/|$))/i,
  },
];

// --------------------------------------------------------------------------------------------
// Render allowlist: hosts (and, for third parties, exact path families and resource types) that
// an anonymous openart.ai page load needs. Derived from the host inventory of all saved journeys.
// --------------------------------------------------------------------------------------------
interface RenderRule {
  id: string;
  host: RegExp;
  types: string[];
  path?: RegExp;
}

const STATIC = ['Document', 'Script', 'Stylesheet', 'Font', 'Image', 'Media', 'Manifest', 'TextTrack', 'Other'];
const FIRST_PARTY = /(^|\.)openart\.ai$/;

// --------------------------------------------------------------------------------------------
// First-party allowlist (positive): what an anonymous visit legitimately fetches from openart.ai
// besides page navigations. Derived from the first-party inventory of the saved journeys
// (reports/baseline-2026-09-30/raw); anything else first-party is failed as "first-party-unlisted"
// and listed in results.json for review (a new read-only API gets added here; a beacon never does).
// --------------------------------------------------------------------------------------------
export interface FirstPartyRule {
  id: string;
  host: RegExp;
  types: string[];
  path: RegExp;
}

export const FIRST_PARTY_RULES: FirstPartyRule[] = [
  { id: 'fp-build', host: /^openart\.ai$/, types: ['Script', 'Stylesheet', 'Font', 'Image', 'Media', 'Manifest', 'Other'], path: /^\/(_astro\/|suite\/_next\/static\/|_next\/static\/|legacy\/_next\/static\/|pageforge-assets\/)/ },
  { id: 'fp-gateway-loader', host: /^openart\.ai$/, types: ['Script'], path: /^\/4vu8\/(?:|[A-Za-z0-9_-]{20,}|gtm\.js|gtag\/js|gtag\/destination)$/ },
  { id: 'fp-icons', host: /^openart\.ai$/, types: ['Image', 'Other', 'Manifest'], path: /^\/(suite\/)?[A-Za-z0-9_.-]+\.(ico|png|svg|webmanifest)$/ },
  { id: 'fp-cf-image', host: /(^|\.)openart\.ai$/, types: ['Image', 'Media', 'Other'], path: /^\/cdn-cgi\/(image|media)\// },
  { id: 'fp-cdn', host: /^cdn\.openart\.ai$/, types: ['Image', 'Media', 'Other', 'Script', 'Stylesheet', 'Font', 'Fetch', 'XHR'], path: /^\/(?!cdn-cgi\/(rum|beacon|challenge))/ },
  { id: 'fp-i18n', host: /^i18n\.openart\.ai$/, types: ['Script', 'Fetch', 'XHR', 'Other'], path: /^\/[A-Za-z0-9_./-]*\.(js|json)$/ },
  { id: 'fp-clerk-js', host: /^clerk\.openart\.ai$/, types: ['Script'], path: /^\/npm\/@clerk\// },
  { id: 'fp-clerk-api', host: /^clerk\.openart\.ai$/, types: ['Fetch', 'XHR'], path: /^\/v1\/(client|environment)$/ },
  { id: 'fp-media-fetch', host: /^openart\.ai$/, types: ['Fetch', 'XHR'], path: /^\/pageforge-assets\// },
  { id: 'fp-suite-api', host: /^openart\.ai$/, types: ['Fetch', 'XHR'], path: /^\/suite\/api\/(auth\/challenge-check|community\/(categories|posts)|how-it-works|ip|model-availability|resources|system\/banner|tutorial\/labels|uploaded-assets|viral-templates|whats-new\/current)$/ },
];

/** A page route (RSC data / prefetch target): no file extension, not an API or gateway path. */
const PAGE_ROUTE = /^\/(?!(suite\/|legacy\/)?api\/|4vu8\/|cdn-cgi\/|_next\/|_astro\/|ingest\/)[A-Za-z0-9_\-./]*$/;

/** Raw, percent-decoded and slash-collapsed forms of a pathname (rules must hold for every form). */
export function pathForms(pathname: string): string[] {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* keep raw */
  }
  return Array.from(new Set([pathname, decoded, decoded.replace(/\/{2,}/g, '/')]));
}

export const RENDER_RULES: RenderRule[] = [
  { id: 'astro-origin', host: /^pageforge-56o\.pages\.dev$/, types: ['Script', 'Stylesheet', 'Font', 'Image', 'Media', 'Other'] },
  { id: 'gtm', host: /^www\.googletagmanager\.com$/, types: ['Script'], path: /^\/(gtm\.js|gtag\/js|gtag\/destination)$/ },
  { id: 'google-fonts-css', host: /^fonts\.googleapis\.com$/, types: ['Stylesheet'] },
  { id: 'google-fonts', host: /^fonts\.gstatic\.com$/, types: ['Font'] },
  // accounts.google.com (Google One Tap / GSI) and www.gstatic.com are deliberately NOT allowlisted:
  // no check needs One Tap, and Chrome's own sign-in/static-asset background calls go to those hosts
  // (observed in the pilot), so the proxy refuses them for everyone.
  { id: 'meta-sdk', host: /^connect\.facebook\.net$/, types: ['Script'], path: /^\/([a-zA-Z_]+\/(fbevents|sdk)\.js|signals\/(config|plugins)\/)/ },
  { id: 'tiktok-sdk', host: /^analytics\.tiktok\.com$/, types: ['Script'], path: /^\/i18n\/pixel\// },
  { id: 'uet-sdk', host: /^bat\.bing\.com$/, types: ['Script'], path: /^\/(bat\.js|p\/action\/\d+\.js|p\/conversions\/t\/\d+|p\/insightsConversions\/)/ },
  { id: 'uet-sdk-net', host: /^bat\.bing\.net$/, types: ['Script'], path: /^\/bat\.js$/ },
  { id: 'linkedin-sdk', host: /^snap\.licdn\.com$/, types: ['Script'], path: /^\/li\.lms-analytics\// },
  { id: 'x-sdk', host: /^static\.ads-twitter\.com$/, types: ['Script'], path: /^\/(uwt|oct)\.js$/ },
  { id: 'reddit-sdk', host: /^www\.redditstatic\.com$/, types: ['Script'], path: /^\/ads\// },
  { id: 'openai-sdk', host: /^bzrcdn\.openai\.com$/, types: ['Script'], path: /^\/sdk\// },
  { id: 'openai-config', host: /^bzrcdn\.openai\.com$/, types: ['Fetch', 'XHR'], path: /^\/pixel-config\// },
  { id: 'clarity-tag', host: /^www\.clarity\.ms$/, types: ['Script'], path: /^\/tag\// },
  { id: 'clarity-sdk', host: /^scripts\.clarity\.ms$/, types: ['Script'] },
  { id: 'hotjar-sdk', host: /^(static|script)\.hotjar\.com$/, types: ['Script'] },
  { id: 'tolt-sdk', host: /^cdn\.tolt\.io$/, types: ['Script'], path: /^\/tolt\.js$/ },
  { id: 'chargeblast-sdk', host: /^cdn\.cgb\.la$/, types: ['Script'] },
  { id: 'jsdelivr', host: /^cdn\.jsdelivr\.net$/, types: ['Script', 'Stylesheet'] },
  { id: 'cf-web-analytics-sdk', host: /^static\.cloudflareinsights\.com$/, types: ['Script'], path: /^\/beacon\.min\.js/ },
  { id: 'turnstile', host: /^challenges\.cloudflare\.com$/, types: ['Script', 'Document', 'Stylesheet', 'Image', 'Font'] },
  { id: 'iconify', host: /^api\.iconify\.design$/, types: ['Image'] },
];

export function isFirstPartyHost(host: string): boolean {
  return FIRST_PARTY.test(host);
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}

export function classifyCollection(u: URL, _method: string, _type: string, extra: CollectionRule[] = []): { rule: string; platform: Platform | string } | null {
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  const forms = pathForms(u.pathname);
  for (const r of extra.concat(COLLECTION_RULES)) {
    if (!r.host.test(host)) continue;
    // collection if ANY form of the path is a collection path (an encoded /%34vu8/g/collect still counts)
    if (!forms.some((f) => (!r.path || r.path.test(f)) && !(r.exceptPath && r.exceptPath.test(f)))) continue;
    return { rule: r.id, platform: r.platform };
  }
  return null;
}

export function firstPartyRule(u: URL, type: string): FirstPartyRule | null {
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  const forms = pathForms(u.pathname);
  // encoded separators / dot-segments could be decoded server-side into another path: never allowlisted
  if (/%(2f|5c|2e)/i.test(u.pathname)) return null;
  for (const r of FIRST_PARTY_RULES) {
    if (r.host.test(host) && r.types.includes(type) && forms.every((f) => r.path.test(f))) return r;
  }
  return null;
}

function renderRule(u: URL, type: string, extraHosts: RegExp[] = []): RenderRule | null {
  if (extraHosts.some((h) => h.test(u.hostname))) return { id: 'extra-host', host: /./, types: STATIC };
  for (const r of RENDER_RULES) {
    if (!r.host.test(u.hostname)) continue;
    if (!r.types.includes(type)) continue;
    if (r.path && !r.path.test(u.pathname)) continue;
    return r;
  }
  return null;
}

function isRscOrPrefetch(u: URL, headers?: Record<string, string>): boolean {
  return u.searchParams.has('_rsc') || header(headers, 'rsc') === '1' || !!header(headers, 'next-router-prefetch') || header(headers, 'purpose') === 'prefetch';
}

export function decide(req: PolicyRequest, ctx: PolicyContext): Decision {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { action: 'fail', reason: 'unparseable-url', collection: false };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { action: 'fail', reason: 'scheme:' + u.protocol, collection: false };
  const method = (req.method || 'GET').toUpperCase();
  const type = req.resourceType || 'Other';

  if (u.username || u.password) return { action: 'fail', reason: 'credentials-in-url', collection: false };
  const col = classifyCollection(u, method, type, ctx.extraCollection);
  if (col) return { action: 'fail', reason: 'collection-endpoint', collection: true, rule: col.rule, platform: col.platform };

  if (method !== 'GET') return { action: 'fail', reason: 'non-GET (' + method + ')', collection: false };
  if (header(req.headers, 'service-worker') === 'script') return { action: 'fail', reason: 'service-worker-script', collection: false };

  const extraHost = (ctx.extraHosts || []).some((h) => h.test(u.hostname));
  const firstParty = isFirstPartyHost(u.hostname.replace(/\.$/, '')) || extraHost;
  if (u.port && !['443', '80'].includes(u.port) && !extraHost) return { action: 'fail', reason: 'non-standard-port', collection: false };
  const urlHasMarker = containsMarker(req.url, ctx.markers);
  const refHasMarker = containsMarker(header(req.headers, 'referer'), ctx.markers);

  if (!firstParty) {
    if (urlHasMarker || refHasMarker) return { action: 'fail', reason: 'synthetic-marker-to-third-party', collection: false };
    const r = renderRule(u, type, ctx.extraHosts);
    if (!r) return { action: 'fail', reason: 'not-on-render-allowlist', collection: false };
    return { action: 'allow', reason: 'render:' + r.id, collection: false, transport: 'node' };
  }

  // Test hosts (pilot / loopback tests only): permissive first-party behaviour, no allowlist tables.
  if (extraHost && !isFirstPartyHost(u.hostname)) {
    if (STATIC.includes(type) || ['Fetch', 'XHR', 'EventSource', 'Prefetch'].includes(type)) {
      if (urlHasMarker && type !== 'Document') return { action: 'fail', reason: 'synthetic-marker-in-first-party-subresource', collection: false };
      return { action: 'allow', reason: 'test-host', collection: false, transport: 'tunnel' };
    }
    return { action: 'fail', reason: 'type-not-allowed:' + type, collection: false };
  }

  // First-party GET.
  if (type === 'Document') return { action: 'allow', reason: 'first-party-navigation', collection: false, transport: 'tunnel' };
  if (urlHasMarker && !(isRscOrPrefetch(u, req.headers) && PAGE_ROUTE.test(u.pathname))) return { action: 'fail', reason: 'synthetic-marker-in-first-party-subresource', collection: false };
  if ((type === 'Fetch' || type === 'XHR' || type === 'Prefetch') && isRscOrPrefetch(u, req.headers) && u.hostname === 'openart.ai' && PAGE_ROUTE.test(u.pathname) && !/%(2f|5c|2e)/i.test(u.pathname)) {
    return { action: 'allow', reason: 'first-party-rsc', collection: false, transport: 'tunnel' };
  }
  const fp = firstPartyRule(u, type);
  if (fp) return { action: 'allow', reason: 'first-party:' + fp.id, collection: false, transport: 'tunnel' };
  return { action: 'fail', reason: 'first-party-unlisted', collection: false };
}

/**
 * Out-of-process layer: may the gatekeeper proxy open a tunnel to host:port? First-party hosts
 * only (plus the loopback test hosts); third-party bytes reach the browser only via the watchdog's
 * own fetch (transport 'node'), never via a tunnel.
 */
export function allowConnectHost(host: string, port: number, opts: { extraHosts?: RegExp[] } = {}): boolean {
  if ((opts.extraHosts || []).some((h) => h.test(host))) return true; // loopback test hosts (any port)
  if (port !== 443 && port !== 80) return false;
  return FIRST_PARTY.test(host);
}
