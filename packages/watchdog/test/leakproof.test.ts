import { describe, expect, it } from 'vitest';
import { proveAll, proveSession, researchTrackingVendor, type SessionEvidence } from '../src/observe/leakproof.js';
import type { CapturedRequest } from '../src/types.js';

const req = (o: Partial<CapturedRequest>): CapturedRequest => ({ id: 'r' + Math.random(), t: 0, step: 's', url: 'https://openart.ai/', method: 'GET', resourceType: 'Document', action: 'allow', collection: false, ...o });

function clean(): SessionEvidence {
  return {
    id: 'j', kind: 'journey', markers: ['WD_TEST'],
    requests: [
      req({ networkId: '1', url: 'https://openart.ai/?fbclid=WD_TEST_FBCLID_X', via: 'tunnel' }),
      req({ networkId: '2', url: 'https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K', resourceType: 'Script', referer: 'https://openart.ai/', via: 'node', status: 200 }),
      req({ networkId: '3', url: 'https://www.google.com/ccm/collect?en=page_view', method: 'POST', resourceType: 'Fetch', action: 'fail', collection: true, failResult: 'ok' }),
      req({ networkId: '4', url: 'https://analytics.tiktok.com/api/v2/pixel', method: 'POST', resourceType: 'Ping', action: 'fail', collection: true, failResult: 'ok' }),
      req({ networkId: '5', url: 'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=X', resourceType: 'Script', via: 'node', status: 200 }),
    ],
    net: [
      { requestId: '1', url: 'https://openart.ai/?fbclid=WD_TEST_FBCLID_X', type: 'Document', responseReceived: true },
      { requestId: '2', url: 'https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K', type: 'Script', responseReceived: true },
      { requestId: '3', url: 'https://www.google.com/ccm/collect?en=page_view', type: 'Fetch', failed: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' },
      { requestId: '9', url: 'data:image/png;base64,xx', type: 'Image', responseReceived: true },
      { requestId: '10', url: 'https://cdn.openart.ai/a.webp', type: 'Image', servedFromCache: true },
      { requestId: '11', url: 'https://evil.example/x.js', type: 'Script', failed: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'csp' },
    ],
    proxy: { port: 1, sealedAt: null, totalAttempts: 3, preSealAttempts: 3, postSealAttempts: 0, postSealAllowed: 0, postSealRefused: [], tunnelsDestroyedAtSeal: 0, bytesDroppedUpstreamAfterSeal: 0, bytesDroppedDownstreamAfterSeal: 0, refusedByPolicy: [{ iso: '', kind: 'CONNECT', target: 'www.google.com:443' }], tunnelledHosts: ['openart.ai', 'cdn.openart.ai'] },
    teardown: { stillAlive: [], profileDeleted: true, pgrepProfile: [], proxySealedBeforeKill: true },
    fetchLayers: { browser: true, page: true, failed: [] },
    webSockets: [], heldTargets: [], serviceWorkerVersions: [], extraPages: [], reportingReports: [],
    sealLog: [{ step: 'app', entry: 'serviceWorker.register /4vu8/_/service_worker/sw.js' }],
  };
}

describe('zero-leak proof', () => {
  it('proves a clean session (tunnel for first party, watchdog fetch for third party)', () => {
    const p = proveSession(clean());
    expect(p.problems).toEqual([]);
    expect(p.pass).toBe(true);
    expect(p.collectionAttempts).toBe(2);
    expect(p.allowedViaWatchdogFetch).toBe(2);
    expect(p.refusedByProxy).toEqual(['www.google.com']);
    expect(p.blockedInPage).toEqual(['app: serviceWorker.register /4vu8/_/service_worker/sw.js']);
    expect(proveAll([clean()]).status).toBe('PROVEN');
  });

  it.each([
    ['an allowed tracking endpoint', (e: SessionEvidence) => e.requests.push(req({ url: 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/', resourceType: 'Script' }))],
    ['an allowed first-party beacon the policy did not know', (e: SessionEvidence) => e.requests.push(req({ url: 'https://openart.ai/api/logs?e=pageview', resourceType: 'XHR' }))],
    ['a failed request that still got a response', (e: SessionEvidence) => (e.net.find((n) => n.requestId === '3')!.responseReceived = true)],
    ['a collection request that was not failed', (e: SessionEvidence) => (e.requests[2]!.action = 'allow')],
    ['a failRequest error', (e: SessionEvidence) => (e.requests[2]!.failResult = 'err: Invalid InterceptionId')],
    ['a marker in a third-party referer', (e: SessionEvidence) => (e.requests[1]!.referer = 'https://openart.ai/?fbclid=WD_TEST_FBCLID_X')],
    ['a request Chrome sent without a Fetch decision (even unanswered)', (e: SessionEvidence) => e.net.push({ requestId: '77', url: 'https://openart.ai/home', type: 'Other', method: 'GET' })],
    ['a service-worker-served response without a Fetch decision', (e: SessionEvidence) => e.net.push({ requestId: '78', url: 'https://bat.bing.com/action/0', type: 'Fetch', responseReceived: true, fromServiceWorker: true })],
    ['a tunnel to a third-party host', (e: SessionEvidence) => e.proxy!.tunnelledHosts.push('analytics.tiktok.com')],
    ['a first-party request fetched outside the browser', (e: SessionEvidence) => e.requests.push(req({ url: 'https://openart.ai/suite/api/ip', resourceType: 'XHR', via: 'node' }))],
    ['a watchdog-fetched non-GET', (e: SessionEvidence) => (e.requests[1]!.method = 'POST')],
    ['a surviving Chrome process', (e: SessionEvidence) => (e.teardown!.stillAlive = [123])],
    ['a process still referencing the profile', (e: SessionEvidence) => (e.teardown!.pgrepProfile = ['4242'])],
    ['a proxy not sealed before the kill', (e: SessionEvidence) => (e.teardown!.proxySealedBeforeKill = false)],
    ['a WebSocket handshake', (e: SessionEvidence) => e.webSockets!.push({ url: 'wss://openart.ai/ws' })],
    ['a service worker that ran', (e: SessionEvidence) => e.serviceWorkerVersions!.push({ scriptURL: 'https://openart.ai/4vu8/_/service_worker/sw.js', runningStatus: 'running', status: 'activated' })],
    ['a popup', (e: SessionEvidence) => e.extraPages!.push({ url: 'https://openart.ai/x', closed: true })],
    ['a queued Reporting API report', (e: SessionEvidence) => e.reportingReports!.push({ type: 'csp-violation', destination: 'default' })],
    ['a page whose Fetch could not be enabled', (e: SessionEvidence) => e.fetchLayers!.failed.push('iframe:https://openart.ai/x')],
    ['no browser-level interception', (e: SessionEvidence) => (e.fetchLayers!.browser = false)],
  ])('fails on %s', (_name, mutate) => {
    const e = clean();
    mutate(e);
    const p = proveSession(e);
    expect(p.pass).toBe(false);
    expect(proveAll([e]).status).toBe('FAILED');
  });

  it('is fail-closed: vacuous evidence is never PROVEN', () => {
    const empty: SessionEvidence = { id: 'x', kind: 'journey', markers: [], requests: [], net: [], proxy: null, teardown: null };
    const p = proveSession(empty);
    expect(p.pass).toBe(false);
    expect(p.problems.join(' | ')).toMatch(/interception-layer status unknown.*no Fetch decision.*no proxy summary.*teardown/);
    const noTraffic = clean();
    noTraffic.proxy!.totalAttempts = 0;
    expect(proveSession(noTraffic).problems).toContain('the proxy saw no traffic (the browser did not use it)');
    expect(proveAll([]).status).toBe('FAILED');
  });

  it('research classifier labels the endpoints the research found (and the rest of the inventory)', () => {
    expect(researchTrackingVendor('https://www.facebook.com/tr/')).toBe('meta_tr');
    expect(researchTrackingVendor('https://openart.ai/4vu8/as/p/c/11252321380/')).toBe('gtg_collect');
    expect(researchTrackingVendor('https://openart.ai/%34vu8/g/collect')).not.toBeNull();
    expect(researchTrackingVendor('https://openart.ai/%34vu8/td?id=1')).toBe('gtg_collect');
    expect(researchTrackingVendor('https://o1.ingest.sentry.io/api/1/envelope/')).toBe('sentry');
    expect(researchTrackingVendor('https://openart.ai/suite/api/tracking/x')).toBe('openart_first_party');
    expect(researchTrackingVendor('https://openart.ai/4vu8/')).toBeNull();
    expect(researchTrackingVendor('https://connect.facebook.net/en_US/fbevents.js')).toBeNull();
  });
});

describe('requests without their own Fetch decision', () => {
  it('are accepted only when provably undelivered: Chrome block, failed CORS preflight, or a third-party host with no route', () => {
    const e = clean();
    // Amplitude: the OPTIONS preflight was paused and failed by the seal; the POST itself never got a pause
    e.requests.push(req({ networkId: 'PF1', url: 'https://api2.amplitude.com/2/httpapi', method: 'OPTIONS', resourceType: 'XHR', action: 'fail', collection: true, failResult: 'ok' }));
    e.net.push({ requestId: 'PF1', url: 'https://api2.amplitude.com/2/httpapi', type: 'Preflight', method: 'OPTIONS', initiatorType: 'preflight', initiatorRequestId: 'M1' });
    e.net.push({ requestId: 'M1', url: 'https://api2.amplitude.com/2/httpapi', type: 'Fetch', method: 'POST', failed: 'net::ERR_FAILED', corsError: 'PreflightInvalidStatus' });
    // a third-party beacon the proxy never connected to
    e.net.push({ requestId: 'B1', url: 'https://n.clarity.ms/collect', type: 'Ping', method: 'POST' });
    const p = proveSession(e);
    expect(p.problems).toEqual([]);
    expect(p.accountedOtherwise).toEqual({ blockedByChrome: 1, preflightFailed: 1, noRoute: 1, policyAllowed: 0 });
  });
  it('list (not fail on) requests the policy would have allowed anyway, e.g. a media range request cancelled before interception', () => {
    const e = clean();
    e.net.push({ requestId: 'M9', url: 'https://cdn.openart.ai/openart-strapi-assets/feature_1/feature_1.mp4', type: 'Media', method: 'GET', failed: 'net::ERR_ABORTED' });
    const p = proveSession(e);
    expect(p.problems).toEqual([]);
    expect(p.unpausedAllowed[0]).toMatch(/feature_1\.mp4 \(no response\)/);
    // ...but never a collection path, a marker-bearing URL, or anything the pilot's probe rule marks as collection
    const bad = clean();
    bad.net.push({ requestId: 'M10', url: 'https://cdn.openart.ai/x.mp4?fbclid=WD_TEST_FBCLID_X', type: 'Media', method: 'GET' });
    expect(proveSession(bad).unaccounted).toHaveLength(1);
    const pilot: SessionEvidence = { ...clean(), id: 'pilot', kind: 'pilot', extraAllowedHosts: [/^127\.0\.0\.1$/], extraCollection: [{ id: 'pilot.probe', platform: 'pilot', host: /^127\.0\.0\.1$/, path: /^\/wd-collect-probe/ }] };
    pilot.net.push({ requestId: 'P1', url: 'http://127.0.0.1:5000/wd-collect-probe-img', type: 'Image', method: 'GET' });
    expect(proveSession(pilot).unaccounted).toHaveLength(1);
  });
  it('fail the proof for first-party requests and for third-party hosts the proxy did connect to', () => {
    const first = clean();
    first.net.push({ requestId: 'F1', url: 'https://openart.ai/api/anything', type: 'Fetch', method: 'POST' });
    expect(proveSession(first).unaccounted).toHaveLength(1);
    const routed = clean();
    routed.proxy!.tunnelledHosts.push('n.clarity.ms');
    routed.net.push({ requestId: 'B2', url: 'https://n.clarity.ms/collect', type: 'Ping', method: 'POST' });
    const p = proveSession(routed);
    expect(p.pass).toBe(false);
    expect(p.unaccounted).toHaveLength(1);
  });
});
