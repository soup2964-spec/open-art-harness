// Hermetic end-to-end test of the collection seal + patch mechanics: real headless Chrome through the
// gatekeeper proxy against a LOCAL loopback server that logs every request it actually receives.
// No internet traffic. Proves on the receiving side that failed requests never arrive.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SealedSession } from '../src/browser/harness.js';
import { loadEdgeSim } from '../src/patches/patches.js';
import { proveSession } from '../src/observe/leakproof.js';
import { UboEngine } from '../src/ubo/engine.js';

const CHROME = process.env.WATCHDOG_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);

let server: http.Server;
let port = 0;
const received: Array<{ method: string; url: string; body: string }> = [];
const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-int-profiles-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-int-'));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><script>window.__order=(window.__order||[]);window.__order.push('page-head');</script><title>t</title></head>
<body><p>hello</p><a href="/next" id="cta">Start for free</a><script>
  navigator.sendBeacon('/collect/beacon', 'b=1');
  fetch('/collect/keepalive', {method:'POST', body:'k=1', keepalive:true}).catch(function(){});
  new Image().src = '/collect/pixel.gif?id=WD_TEST_PIXEL';
  var x = new XMLHttpRequest(); x.open('POST', '/collect/xhr'); x.send('x=1');
  fetch('/api/ok').then(function(r){ return r.text(); }).then(function(t){ window.__api = t; }).catch(function(e){ window.__api = 'err ' + e; });
  fetch('/api/post', {method:'POST', body:'p=1'}).catch(function(){});
  new Worker(URL.createObjectURL(new Blob(["fetch('" + location.origin + "/collect/worker').catch(function(){})"], {type:'text/javascript'})));
  if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').catch(function(){});
  try { new WebSocket('ws://' + location.host + '/ws-probe'); window.__ws = 'constructed'; } catch (e) { window.__ws = 'threw ' + e.name; }
  var ww = new Worker(URL.createObjectURL(new Blob(["try { new WebSocket('ws://" + location.host + "/ws-probe-worker'); postMessage('constructed'); } catch (e) { postMessage('threw ' + e.name); }"], {type:'text/javascript'})));
  ww.onmessage = function (e) { window.__wsWorker = e.data; };
  addEventListener('pagehide', function(){ navigator.sendBeacon('/collect/pagehide', 'h=1'); });
</script></body></html>`;

// Third-party SDK hosts: the browser has no route to them; the watchdog fetches allowed GETs itself.
const THIRD = `<!doctype html><html><head>
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K"></script>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script>
</head><body><img src="https://www.facebook.com/tr/?id=1&ev=PageView&noscript=1"><script>fetch('https://www.google.com/ccm/collect?en=page_view', {method:'POST', body:'x'}).catch(function(){});</script></body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method!, url: req.url!, body });
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'origin_cookie=1; Path=/' });
        res.end(PAGE);
      } else if (u.pathname === '/next') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head></head><body>next</body></html>');
      } else if (u.pathname === '/third') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(THIRD);
      } else if (u.pathname === '/api/ok') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('api-ok');
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(profilesDir, { recursive: true, force: true });
});

const policy = { markers: ['WD_TEST'], extraHosts: [/^127\.0\.0\.1$/], extraCollection: [{ id: 'test.collect', platform: 'test', host: /^127\.0\.0\.1$/, path: /^\/collect\// }] };

describe.skipIf(!hasChrome)('collection seal end-to-end (loopback)', () => {
  it('delivers render + first-party GETs, fails every collection/non-GET request before it leaves Chrome, and applies patches', async () => {
    const edge = path.join(tmp, 'edge.mjs');
    fs.writeFileSync(edge, "export function simulate(url, headers){ return { setCookies: ['edge_cookie=WD_TEST_EDGE; Path=/', 'x=1; Domain=.example.com'] }; }");
    const s = await SealedSession.launch({
      name: 'int',
      profilesDir,
      chromePath: CHROME,
      device: 'desktop',
      captureLoaders: false,
      allowConnect: (h) => h === '127.0.0.1',
      intercept: {
        policy,
        isPatchHost: (h) => h === '127.0.0.1',
        patches: {
          injectScript: { path: 'inline', sha256: 'x', text: "window.__order=(window.__order||[]);window.__order.push('injected');window.__wdInjected=1;" },
          edgeSim: { path: edge, module: await loadEdgeSim(edge) },
        },
      },
    });
    try {
      const nav = await s.goto(`http://127.0.0.1:${port}/page`, 'page');
      expect(nav.ok, nav.err).toBe(true);
      await s.quiet(2500, 8000, 1500);
      const st = await s.evaluate<any>('({order: window.__order, injected: window.__wdInjected, api: window.__api, cookie: document.cookie, ws: window.__ws, wsWorker: window.__wsWorker})');
      expect(st.ws).toBe('threw SecurityError');
      expect(st.wsWorker).toBe('threw SecurityError');
      expect(st.injected).toBe(1);
      expect(st.order).toEqual(['injected', 'page-head']); // inject-script runs before anything in <head>
      expect(st.api).toBe('api-ok');
      const snap = await s.snapshot('page');
      expect(snap.injectSentinel).toBe('x'); // the injected block ran (sentinel = sha256 prefix of the script)
      const names = snap.cookies.map((c) => c.name);
      expect(names).toContain('edge_cookie'); // edge-sim Set-Cookie applied on the fulfilled document
      expect(names).toContain('origin_cookie'); // the origin's own Set-Cookie survives fulfillment
      expect(names).not.toContain('x');
      expect(s.state.errors.some((e) => /edge-sim cookie rejected/.test(e))).toBe(true);
      const click = await s.clickCTA([{ text: '^Start for free$' }], 'next');
      expect(click.found).toBe(true);
      expect(click.navigated).toBe(true);
      expect(click.after).toBe(`http://127.0.0.1:${port}/next`);
      await s.quiet(2000, 6000, 1500);
    } finally {
      await s.close();
    }
    // --- receiving side: nothing under /collect/ and no non-GET ever arrived
    expect(received.filter((r) => r.url.startsWith('/collect/'))).toEqual([]);
    expect(received.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(received.filter((r) => r.url === '/sw.js')).toEqual([]);
    expect(received.map((r) => r.url)).toEqual(expect.arrayContaining(['/page', '/api/ok', '/next']));
    // --- sender side: every collection attempt was recorded and failed
    const failed = s.state.requests.filter((r) => r.action === 'fail').map((r) => new URL(r.url).pathname);
    for (const p of ['/collect/beacon', '/collect/keepalive', '/collect/pixel.gif', '/collect/xhr', '/collect/worker', '/collect/pagehide', '/api/post']) expect(failed, p).toContain(p);
    expect(s.state.requests.filter((r) => r.action === 'fail').every((r) => r.failResult === 'ok')).toBe(true);
    // no Network record of a failed request ever received a response
    const failedIds = new Set(s.state.requests.filter((r) => r.action === 'fail' && r.networkId).map((r) => r.networkId));
    expect(s.net.filter((n) => failedIds.has(n.requestId) && n.responseReceived)).toEqual([]);
    expect(s.pageLoads).toBe(2);
    expect(s.teardown!.profileDeleted).toBe(true);
    expect(s.teardown!.stillAlive).toEqual([]);
    expect(s.proxySummary!.tunnelledHosts.every((h) => h === '127.0.0.1')).toBe(true);
    // WebSockets bypass Fetch: the WS seal stops them before a handshake exists (page and worker)
    expect(s.webSockets).toEqual([]);
    expect((s.proxySummary!.log ?? []).filter((e) => /ws-probe/.test(e.target) || e.kind === 'UPGRADE')).toEqual([]);
    expect(received.filter((r) => /ws-probe/.test(r.url))).toEqual([]);
    // the strengthened zero-leak proof holds for this session (in-page refusals are listed)
    const proof = proveSession(s.evidence('int', 'journey', ['WD_TEST'], [/^127\.0\.0\.1$/]));
    expect(proof.problems).toEqual([]);
    expect(proof.blockedInPage.join(' ')).toMatch(/serviceWorker\.register \/sw\.js/);
  });

  it('serves allowed third-party SDKs through the watchdog fetch only: no browser route to any third-party host', async () => {
    const fetched: Array<{ url: string; headers: Record<string, string> }> = [];
    const s = await SealedSession.launch({
      name: 'int-3p', profilesDir, chromePath: CHROME, device: 'desktop', captureLoaders: true,
      allowConnect: (h) => h === '127.0.0.1',
      intercept: {
        policy, isPatchHost: () => false, patches: {},
        thirdPartyFetch: async (url, headers) => {
          fetched.push({ url, headers });
          const body = /gtm\.js/.test(url) ? "window.__gtm='served-by-watchdog';" : "window.__fbq='served-by-watchdog';";
          return { status: 200, headers: [{ name: 'content-type', value: 'text/javascript' }], body: Buffer.from(body) };
        },
      },
    });
    try {
      await s.goto(`http://127.0.0.1:${port}/third`, 'third');
      await s.quiet(1500, 5000, 1000);
      expect(await s.evaluate('[window.__gtm, window.__fbq].join(",")')).toBe('served-by-watchdog,served-by-watchdog');
    } finally {
      await s.close();
    }
    expect(fetched.map((f) => new URL(f.url).hostname).sort()).toEqual(['connect.facebook.net', 'www.googletagmanager.com']);
    expect(fetched.every((f) => !('cookie' in f.headers) && !('Cookie' in f.headers))).toBe(true);
    const via = s.state.requests.filter((r) => r.action === 'allow' && /googletagmanager|facebook\.net/.test(r.url)).map((r) => r.via);
    expect(via).toEqual(['node', 'node']);
    const failed = s.state.requests.filter((r) => r.action === 'fail').map((r) => new URL(r.url).hostname);
    expect(failed).toEqual(expect.arrayContaining(['www.facebook.com', 'www.google.com']));
    // the proxy never opened (or was never asked for) a tunnel to a third-party host
    expect(s.proxySummary!.tunnelledHosts).toEqual(['127.0.0.1']);
    expect(proveSession(s.evidence('int-3p', 'journey', ['WD_TEST'], [/^127\.0\.0\.1$/])).problems).toEqual([]);
  });

  it('simulates uBlock $removeparam: the server only ever sees the stripped URL', async () => {
    received.length = 0;
    const ubo = new UboEngine(['$removeparam=gclid\n$removeparam=fbclid']);
    const s = await SealedSession.launch({
      name: 'int-ubo', profilesDir, chromePath: CHROME, device: 'desktop', captureLoaders: false,
      allowConnect: (h) => h === '127.0.0.1',
      intercept: { policy, isPatchHost: () => false, patches: {}, ubo },
    });
    try {
      await s.goto(`http://127.0.0.1:${port}/next?gclid=WD_TEST_G&fbclid=WD_TEST_F&utm_source=keep`, 'landing');
      await s.quiet(1500, 4000, 1000);
      expect(s.page.url()).toBe(`http://127.0.0.1:${port}/next?utm_source=keep`);
    } finally {
      await s.close();
    }
    expect(received.filter((r) => r.url !== '/favicon.ico').map((r) => r.url)).toEqual(['/next?utm_source=keep']);
    expect(received.some((r) => /gclid|fbclid/.test(r.url))).toBe(false);
    expect(s.state.patchEvents.find((p) => p.what === 'ubo-removeparam')!.detail).toMatch(/gclid, fbclid/);
  });
});
