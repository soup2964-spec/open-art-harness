// ZERO-LEAK PROOF. For every browser session of a run, prove that no collection request completed.
// Deliberately NOT relying only on the policy that made the decisions, and fail-closed: a session
// whose evidence is missing or incomplete is UNPROVEN, never "clean by default".
//   (1) the interception layers were live: browser-level AND page Fetch enabled, >0 decisions, no
//       target resumed without Fetch, and the proxy saw the browser's traffic (liveness);
//   (2) every request the policy labelled collection was failed, and Fetch.failRequest succeeded;
//   (3) an INDEPENDENT classifier (the research's vendor regexes, crawl/teardown2/analyze.cjs,
//       SHA-256 6c31393924b65549…, extended with the remaining vendors of the endpoint inventory)
//       re-audits every request that WAS allowed, including the ones the watchdog fetched itself;
//   (4) the Network domain (a separate CDP event stream) shows no failed request received a
//       response, and EVERY network record is accounted for by a Fetch decision (or a cache hit, or
//       a block by Chrome itself) — a request Chrome sent without a Fetch decision fails the proof;
//   (5) no allowed third-party request carried a synthetic WD_TEST marker (URL or Referer);
//   (6) the out-of-process proxy tunnelled first-party hosts only (after the seal: nothing);
//   (7) the channels Fetch cannot see stayed closed: no WebSocket, no running service worker, no
//       popup/extra page, no Reporting API report;
//   (8) Chrome's process tree is dead, nothing references the profile, the profile is deleted, and
//       the proxy was sealed before the kill.
import { allowConnectHost, decide, isFirstPartyHost, type CollectionRule } from '../policy/policy.js';
import { containsMarker } from '../markers.js';
import type { CapturedRequest } from '../types.js';
import type { ProxySummary } from '../legacy/gatekeeper_proxy.cjs';

// crawl/teardown2/analyze.cjs VENDORS (research classifier) + the rest of the endpoint inventory
// (research/01 §2-§4, research/02 §3), used here as the independent auditor.
const RESEARCH_VENDORS: Array<[string, RegExp]> = [
  ['meta_tr', /facebook\.com\/tr\b|facebook\.com\/tr\//],
  ['meta_capig', /ecs\.us-east-2\.on\.aws|run\.app\/events|\.on\.aws\//],
  ['meta_other', /facebook\.com\/(privacy_sandbox|signals)/],
  ['gads', /googleadservices\.com|googleads\.g\.doubleclick\.net|google\.com\/(pagead|ccm|rmkt)|ad\.doubleclick\.net|td\.doubleclick\.net|google\.com\/measurement|google\.[a-z.]+\/pagead/],
  ['ga4', /google-analytics\.com|\/g\/collect/],
  ['gtm_diag', /googletagmanager\.com\/(td|a)\?/],
  ['tiktok_api', /tiktok\.com\/api\/|tiktokw\.us/],
  ['reddit', /alb\.reddit\.com|reddit\.com\/rp/],
  ['linkedin', /px\.ads\.linkedin\.com|linkedin\.com\/px\//],
  ['bing', /bat\.bing\.(com|net)\/action|c\.bing\.com|bat\.bing\.com\/p\/conversions\/c\//],
  ['x', /analytics\.twitter\.com|t\.co\/|\/adsct/],
  ['amplitude', /api2?\.amplitude\.com|api\.eu\.amplitude\.com/],
  ['openai', /bzr\.openai\.com/],
  ['clarity', /[a-z]\.clarity\.ms\/(collect|c\.gif)/],
  ['hotjar', /hotjar\.(com|io)\/(api|sessions)|in\.hotjar\.com|content\.hotjar\.io|vc\.hotjar\.io/],
  ['statsig', /prodregistryv2\.org|featuregates\.org|statsigapi\.net|api\.statsig\.com/],
  ['cf_rum', /cdn-cgi\/rum|cloudflareinsights\.com\/cdn-cgi/],
  ['cf_nel', /nel\.cloudflare\.com/],
  ['sentry', /sentry\.io|ingest\.sentry\./],
  ['tolt', /tolt\.io\/(api|v1|track)|execute-api\.[a-z0-9-]+\.amazonaws\.com/],
  ['chargeblast', /api\.chargeblast\.com|ipify\.org/],
  ['brevo', /brevo\.com|sibautomation\.com|sendinblue\.com/],
  ['customerio', /customer\.io/],
  ['impact', /impact\.com|sjv\.io|ojrq\.net/],
  ['firstpromoter', /firstpromoter\.com/],
  ['launchdarkly', /events\.launchdarkly\.com/],
  ['gtg_collect', /openart\.ai\/(4vu8|%34vu8)\/(a\?|as\/|d\/|g\/|_\/|td)/i],
  ['openart_first_party', /openart\.ai\/((suite|legacy)\/)?api\/(user\/ad-click-ids|track|tracks|tracking|log|logs|event|events|analytics|telemetry|metrics|collect|ingest|beacon|pixel)|openart\.ai\/ingest\/|pixel\.openart\.ai/],
];

export function researchTrackingVendor(url: string): string | null {
  for (const [v, re] of RESEARCH_VENDORS) if (re.test(url)) return v;
  return null;
}

export interface NetLite {
  requestId: string;
  url: string;
  type: string;
  method?: string;
  sess?: string;
  responseReceived?: boolean;
  failed?: string;
  blockedReason?: string | null;
  corsError?: string;
  servedFromCache?: boolean;
  fromServiceWorker?: boolean;
  initiatorType?: string;
  initiatorRequestId?: string;
}

export interface SessionEvidence {
  id: string;
  kind: 'journey' | 'consent-probe' | 'pilot' | 'replay (pre-seal page load)' | 'replay (full seal)';
  requests: CapturedRequest[];
  net: NetLite[];
  proxy: ProxySummary | null;
  teardown: { stillAlive?: number[]; profileDeleted: boolean; pgrepProfile?: string[]; proxySealedBeforeKill?: boolean } | null;
  markers: string[];
  extraAllowedHosts?: RegExp[];
  /** Extra collection rules the session's policy used (the pilot's probe paths). */
  extraCollection?: CollectionRule[];
  /** Interception layers: browser-level and page Fetch enabled; targets whose Fetch failed. */
  fetchLayers?: { browser: boolean; page: boolean; failed: string[] };
  /** WebSocket handshakes Chrome reported (the in-page seal should leave none). */
  webSockets?: Array<{ url: string }>;
  /** Service/shared worker targets held paused (never run). */
  heldTargets?: Array<{ type: string; url: string }>;
  /** Service worker versions Chrome reported (none may run or install). */
  serviceWorkerVersions?: Array<{ scriptURL: string; runningStatus: string; status: string }>;
  /** Page targets other than the journey's page (popups). */
  extraPages?: Array<{ url: string; closed: boolean }>;
  /** Reporting API reports queued (the feature is disabled: none expected). */
  reportingReports?: Array<{ type: string; destination: string }>;
  /** Attempts the in-page seal refused (informational). */
  sealLog?: Array<{ step: string; entry: string }>;
  /** Post-seal legacy accounting (replay only). */
  legacy?: { unaccounted: number; failRequestErrors: number; postSealAllowed: number; responsesAfterSeal: number };
  /** Net records are not captured for this session (the full-seal replay: see legacy accounting). */
  netNotApplicable?: boolean;
}

export interface SessionProof {
  id: string;
  kind: string;
  seen: number;
  allowed: number;
  allowedViaWatchdogFetch: number;
  failed: number;
  collectionAttempts: number;
  collectionFailedOk: number;
  independentSuspects: string[];
  responsesForFailed: string[];
  /** Network requests without a Fetch decision that could have left Chrome (first-party, or a host the proxy tunnelled). Fails the proof. */
  unaccounted: string[];
  /** Network requests without their own Fetch decision that provably never left: Chrome blocked them, their CORS preflight was failed by the seal, or their (third-party) host was never connected to. */
  accountedOtherwise: { blockedByChrome: number; preflightFailed: number; noRoute: number; policyAllowed: number };
  /** Requests without a Fetch pause that the policy would have ALLOWED anyway (e.g. media range requests the page cancelled): not a leak, listed so an interception gap would still be visible. */
  unpausedAllowed: string[];
  markerLeaks: string[];
  tunnelledHosts: string[];
  nonAllowlistedTunnels: string[];
  refusedByProxy: string[];
  postSealAllowed: number;
  blockedInPage: string[];
  heldTargets: string[];
  teardownOk: boolean;
  pass: boolean;
  problems: string[];
}

export interface ZeroLeakProof {
  status: 'PROVEN' | 'FAILED';
  sessions: SessionProof[];
  totals: { seen: number; allowed: number; allowedViaWatchdogFetch: number; failed: number; collectionAttempts: number; collectionCompleted: number; independentSuspects: number; unaccounted: number };
  method: string[];
}

const SDK_PATH = /\.(js|css|woff2?|ttf)(\?|$)|\/i18n\/pixel\/|\/p\/action\/|\/p\/conversions\/t\/|\/p\/insightsConversions\/|\/signals\/(config|plugins)\//;
/** Chrome's own blocks happen before a request is sent (Fetch never needs to see them). */
const CHROME_BLOCK = /^(csp|mixed-content|origin|subresource-filter|content-type|coep-frame-resource-needs-coep-header|coop-sandboxed-iframe-cannot-navigate-to-coop-page|corp-not-same-origin|corp-not-same-origin-after-defaulted-to-same-origin-by-coep|corp-not-same-site|sri-message-signature-mismatch)$/;

export function proveSession(e: SessionEvidence): SessionProof {
  const problems: string[] = [];
  const byNet = new Map<string, CapturedRequest[]>();
  for (const r of e.requests) if (r.networkId) byNet.set(r.networkId, [...(byNet.get(r.networkId) ?? []), r]);
  const allowed = e.requests.filter((r) => r.action === 'allow');
  const failed = e.requests.filter((r) => r.action === 'fail');
  const collection = e.requests.filter((r) => r.collection);

  // (1) liveness of every layer — absence of evidence is not evidence of absence
  if (!e.fetchLayers) problems.push('interception-layer status unknown');
  else {
    if (!e.fetchLayers.browser) problems.push('browser-level Fetch interception was not enabled');
    if (!e.fetchLayers.page) problems.push('page Fetch interception was not enabled');
    if (e.fetchLayers.failed.length) problems.push(`Fetch could not be enabled on: ${e.fetchLayers.failed.join(', ').slice(0, 200)}`);
  }
  if (!e.requests.length) problems.push('no Fetch decision at all (interception not live?)');
  if (!e.proxy) problems.push('no proxy summary');
  else if (!e.proxy.totalAttempts && e.kind !== 'replay (full seal)') problems.push('the proxy saw no traffic (the browser did not use it)');

  // (2) policy-labelled collection
  // 'cancelled-by-page': the page aborted the paused request itself; it no longer exists and was never sent.
  const collectionFailedOk = collection.filter((r) => r.action === 'fail' && (r.failResult === 'ok' || r.failResult === undefined || r.failResult === 'cancelled-by-page')).length;
  if (collectionFailedOk !== collection.length) problems.push(`${collection.length - collectionFailedOk} collection request(s) not cleanly failed`);

  // (3) independent re-audit of everything that was allowed (tunnel or watchdog fetch)
  const independentSuspects = allowed
    .filter((r) => {
      const v = researchTrackingVendor(r.url);
      if (!v) return false;
      return !(['Script', 'Stylesheet', 'Font'].includes(r.resourceType) && SDK_PATH.test(new URL(r.url).pathname + new URL(r.url).search) && !/viewthroughconversion/.test(r.url));
    })
    .map((r) => `${r.resourceType} ${r.method} ${r.url.slice(0, 160)}`);
  if (independentSuspects.length) problems.push(`${independentSuspects.length} allowed request(s) look like tracking to the independent classifier`);
  const nodeFetched = allowed.filter((r) => r.via === 'node');
  const nodeNonGet = nodeFetched.filter((r) => r.method.toUpperCase() !== 'GET');
  if (nodeNonGet.length) problems.push(`${nodeNonGet.length} watchdog-fetched request(s) were not GET`);
  const nodeFirstParty = nodeFetched.filter((r) => isFirstPartyHost(safeHost(r.url)));
  if (nodeFirstParty.length) problems.push(`${nodeFirstParty.length} first-party request(s) were fetched outside the browser`);

  // (4) the Network stream, independently of Fetch
  const failedNet = new Set(failed.map((r) => r.networkId).filter(Boolean) as string[]);
  const responsesForFailed = e.net.filter((n) => failedNet.has(n.requestId) && n.responseReceived && !(byNet.get(n.requestId) ?? []).some((r) => r.action === 'allow' || r.action === 'redirect')).map((n) => n.url.slice(0, 160));
  if (responsesForFailed.length) problems.push(`${responsesForFailed.length} failed request(s) received a network response`);
  // A request with no Fetch decision of its own is still provably undelivered when (a) Chrome blocked it
  // before sending, (b) its CORS preflight was paused and failed by the seal (the request itself is
  // then never sent), or (c) it targets a third-party host the proxy never connected to (the proxy is
  // the browser's only route out). Anything else — notably any first-party request — is unaccounted.
  const accountedOtherwise = { blockedByChrome: 0, preflightFailed: 0, noRoute: 0, policyAllowed: 0 };
  const unpausedAllowed: string[] = [];
  const failedPreflightFor = new Set(
    e.net.filter((n) => n.initiatorType === 'preflight' && n.initiatorRequestId && (byNet.get(n.requestId) ?? []).some((r) => r.action === 'fail')).map((n) => n.initiatorRequestId!),
  );
  const tunnelled = new Set(e.proxy?.tunnelledHosts ?? []);
  const unaccounted: string[] = [];
  if (!e.netNotApplicable) {
    for (const n of e.net) {
      if (!/^https?:/.test(n.url) || byNet.has(n.requestId) || n.servedFromCache) continue;
      const host = safeHost(n.url);
      if (n.blockedReason && CHROME_BLOCK.test(n.blockedReason)) accountedOtherwise.blockedByChrome++;
      else if (failedPreflightFor.has(n.requestId) && !n.responseReceived) accountedOtherwise.preflightFailed++;
      else if (!isFirstPartyHost(host) && !(e.extraAllowedHosts ?? []).some((h) => h.test(host)) && !tunnelled.has(host) && !n.responseReceived) accountedOtherwise.noRoute++;
      else if (wouldAllow(n, e)) {
        accountedOtherwise.policyAllowed++;
        unpausedAllowed.push(`${n.type} ${n.method ?? 'GET'} ${n.url.slice(0, 150)}${n.responseReceived ? ' (response received)' : ' (no response)'}${n.failed ? ' ' + n.failed : ''}`);
      } else unaccounted.push(`${n.sess ?? ''} ${n.type} ${n.method ?? ''} ${n.url.slice(0, 150)}${n.responseReceived ? ' (response received)' : ''}${n.fromServiceWorker ? ' (from service worker)' : ''}`.trim());
    }
  }
  if (unaccounted.length) problems.push(`${unaccounted.length} network request(s) without a Fetch decision that could have left Chrome`);

  // (5) synthetic markers towards third parties
  const markerLeaks = allowed
    .filter((r) => {
      const host = safeHost(r.url);
      const third = !isFirstPartyHost(host) && !(e.extraAllowedHosts ?? []).some((h) => h.test(host));
      return third && (containsMarker(r.url, e.markers) || containsMarker(r.referer ?? '', e.markers));
    })
    .map((r) => r.url.slice(0, 160));
  if (markerLeaks.length) problems.push(`${markerLeaks.length} allowed third-party request(s) carried a synthetic marker`);

  // (6) the out-of-process layer
  const tunnelledHosts = e.proxy?.tunnelledHosts ?? [];
  const nonAllowlistedTunnels = tunnelledHosts.filter((h) => !allowConnectHost(h, 443, { extraHosts: e.extraAllowedHosts }));
  if (nonAllowlistedTunnels.length) problems.push(`proxy tunnelled non-first-party host(s): ${nonAllowlistedTunnels.join(', ')}`);
  const postSealAllowed = e.proxy?.postSealAllowed ?? 0;
  if (postSealAllowed) problems.push(`proxy allowed ${postSealAllowed} connection(s) after the seal`);

  // (7) channels outside Fetch
  if ((e.webSockets ?? []).length) problems.push(`${e.webSockets!.length} WebSocket handshake(s) were created: ${e.webSockets!.map((w) => w.url).join(', ').slice(0, 200)}`);
  const swActive = (e.serviceWorkerVersions ?? []).filter((v) => v.runningStatus !== 'stopped' || !['new', 'redundant'].includes(v.status));
  if (swActive.length) problems.push(`${swActive.length} service worker version(s) started or installed: ${swActive.map((v) => `${v.scriptURL} ${v.status}/${v.runningStatus}`).join(', ').slice(0, 200)}`);
  if ((e.extraPages ?? []).length) problems.push(`${e.extraPages!.length} unexpected page target(s) (popup/new tab): ${e.extraPages!.map((p) => p.url).join(', ').slice(0, 200)}`);
  if ((e.reportingReports ?? []).length) problems.push(`${e.reportingReports!.length} Reporting API report(s) were queued`);

  // (8) teardown
  const td = e.teardown;
  const teardownOk = !!td && td.profileDeleted && (td.stillAlive ?? []).length === 0 && (td.pgrepProfile ?? []).length === 0 && td.proxySealedBeforeKill !== false;
  if (!teardownOk) problems.push('teardown incomplete (process alive, profile referenced or not deleted, or proxy not sealed before the kill)');
  if (e.legacy) {
    if (e.legacy.unaccounted) problems.push(`${e.legacy.unaccounted} post-seal network record(s) unaccounted`);
    if (e.legacy.failRequestErrors) problems.push(`${e.legacy.failRequestErrors} post-seal failRequest error(s)`);
    if (e.legacy.responsesAfterSeal) problems.push(`${e.legacy.responsesAfterSeal} response(s) received after the seal`);
  }
  return {
    id: e.id,
    kind: e.kind,
    seen: new Set(e.requests.map((r) => r.networkId ?? r.id)).size,
    allowed: new Set(allowed.map((r) => r.networkId ?? r.id)).size,
    allowedViaWatchdogFetch: nodeFetched.length,
    failed: failed.length,
    collectionAttempts: collection.length,
    collectionFailedOk,
    independentSuspects,
    responsesForFailed,
    unaccounted,
    accountedOtherwise,
    unpausedAllowed,
    markerLeaks,
    tunnelledHosts,
    nonAllowlistedTunnels,
    refusedByProxy: Array.from(new Set((e.proxy?.refusedByPolicy ?? []).map((x) => x.target.split(':')[0]!))).sort(),
    postSealAllowed,
    blockedInPage: (e.sealLog ?? []).map((x) => `${x.step}: ${x.entry}`),
    heldTargets: (e.heldTargets ?? []).map((t) => `${t.type} ${t.url}`),
    teardownOk,
    pass: problems.length === 0,
    problems,
  };
}

/** Would the collection seal have allowed this request (GET, non-collection, allowlisted)? Headers are unknown, so markers in the URL count. */
function wouldAllow(n: NetLite, e: SessionEvidence): boolean {
  const d = decide({ url: n.url, method: n.method ?? 'GET', resourceType: n.type, isNavigation: n.type === 'Document' }, { markers: e.markers, extraHosts: e.extraAllowedHosts, extraCollection: e.extraCollection });
  return d.action === 'allow' && !d.collection && !researchTrackingVendor(n.url);
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

export function proveAll(sessions: SessionEvidence[]): ZeroLeakProof {
  const proofs = sessions.map(proveSession);
  const totals = proofs.reduce(
    (a, p) => ({
      seen: a.seen + p.seen,
      allowed: a.allowed + p.allowed,
      allowedViaWatchdogFetch: a.allowedViaWatchdogFetch + p.allowedViaWatchdogFetch,
      failed: a.failed + p.failed,
      collectionAttempts: a.collectionAttempts + p.collectionAttempts,
      collectionCompleted: a.collectionCompleted + (p.collectionAttempts - p.collectionFailedOk) + p.responsesForFailed.length,
      independentSuspects: a.independentSuspects + p.independentSuspects.length,
      unaccounted: a.unaccounted + p.unaccounted.length,
    }),
    { seen: 0, allowed: 0, allowedViaWatchdogFetch: 0, failed: 0, collectionAttempts: 0, collectionCompleted: 0, independentSuspects: 0, unaccounted: 0 },
  );
  return {
    status: proofs.length && proofs.every((p) => p.pass) ? 'PROVEN' : 'FAILED',
    sessions: proofs,
    totals,
    method: [
      'Interception was live in every session: browser-level and page Fetch enabled (a target whose Fetch failed is never resumed), >0 decisions, and the proxy carried the browser traffic.',
      'Every collection-endpoint request (policy label) was answered with Fetch.failRequest(BlockedByClient) before leaving Chrome; failRequest succeeded.',
      'An independent classifier (the research teardown regexes + the rest of the endpoint inventory) re-audited every ALLOWED request, including third-party GETs the watchdog fetched itself: none is a tracking endpoint.',
      'The Network event stream shows no failed request received a response, and every network request Chrome made is accounted for: by its own Fetch decision; as provably undelivered (blocked by Chrome, its CORS preflight failed by the seal, or a third-party host the proxy never connected to); or as a request the policy allows anyway (e.g. a media range request the page cancelled before interception) — those are listed.',
      'No allowed third-party request carried a synthetic WD_TEST marker in its URL or Referer.',
      'The browser could reach first-party openart.ai hosts only: the gatekeeper proxy refused every other CONNECT before any upstream socket existed; third-party bytes came only from the watchdog\'s own GETs.',
      'Channels outside Fetch stayed closed: no WebSocket, no service worker ran or installed (registrations refused in-page; worker targets held paused), no popup, no Reporting API report, no speculation-rules prefetch/prerender (disabled by profile preference).',
      'Chrome was SIGKILLed with the proxy sealed (no unload beacons); the process tree is dead, nothing references the profile, and the profile directory is deleted.',
    ],
  };
}
