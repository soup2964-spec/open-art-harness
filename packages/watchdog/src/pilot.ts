// SEAL SELF-TEST ("pilot"), run before anything touches openart.ai: the exact Chrome build, flags,
// preferences and harness of the run, pointed at a LOOPBACK server that logs every request it
// receives — receiving-side proof, not just "the harness says it failed it". A probe-only
// collection rule marks /wd-collect-probe* as collection. Every transport a vendor tag can use is
// fired at it, plus every channel the CDP Fetch domain cannot see:
//   renderer requests  fetch, keepalive POST, sendBeacon, <img>, XHR, iframe, dedicated-worker
//                      fetch, <link rel=prefetch>, CSP report-uri, pagehide beacon on navigation
//                      -> each must be recorded as failed AND never reach the server;
//   browser-process    speculation-rules prefetch + prerender, Reporting API
//                      -> must never reach the server (preference / disabled features);
//   in-page seal       WebSocket (direct, via prototype.constructor, via an about:blank iframe and
//                      via window.frames), SharedWorker, service-worker registration, window.open
//                      -> must be refused in the page, with no handshake/target/popup;
//   out-of-process     the gatekeeper proxy must carry the page load (liveness) and refuse a
//                      CONNECT to a host outside the allowlist.
// Nothing leaves the machine: the server is 127.0.0.1 and the proxy refuses every other host.
import http from 'node:http';
import net from 'node:net';
import { SealedSession } from './browser/harness.js';
import { allowConnectHost } from './policy/policy.js';
import type { CapturedRequest } from './types.js';

const LOOPBACK = /^127\.0\.0\.1$/;

export const pilotProbes = (base: string) => `(async function(){
  var P = '${base}/wd-collect-probe';
  var r = {};
  function sleep(ms){ return new Promise(function(res){ setTimeout(res, ms); }); }
  try { await fetch(P + '-fetch'); r.fetch = 'RESOLVED(!)'; } catch(e) { r.fetch = 'rejected'; }
  try { await fetch(P + '-keepalive', {method:'POST', body:'p=1', keepalive:true, mode:'no-cors'}); r.keepalive = 'RESOLVED(!)'; } catch(e) { r.keepalive = 'rejected'; }
  try { r.beaconReturned = navigator.sendBeacon(P + '-beacon', 'p=1'); } catch(e) { r.beaconReturned = 'threw'; }
  r.img = await new Promise(function(res){ var i = new Image(); i.onload = function(){ res('LOADED(!)'); }; i.onerror = function(){ res('onerror'); }; i.src = P + '-img'; setTimeout(function(){ res('timeout'); }, 4000); });
  r.xhr = await new Promise(function(res){ var x = new XMLHttpRequest(); x.open('POST', P + '-xhr'); x.onload = function(){ res('LOADED(!)'); }; x.onerror = function(){ res('onerror'); }; x.send('p=1'); setTimeout(function(){ res('timeout'); }, 4000); });
  r.iframe = await new Promise(function(res){ var f = document.createElement('iframe'); f.onload = function(){ res('onload (error page)'); }; f.src = P + '-iframe'; document.body.appendChild(f); setTimeout(function(){ res('timeout'); }, 4000); });
  r.worker = await new Promise(function(res){ try { var src = "fetch('" + P + "-worker').then(function(){postMessage('RESOLVED(!)')}).catch(function(){postMessage('rejected')})"; var w = new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'}))); w.onmessage = function(e){ res(e.data); }; setTimeout(function(){ res('timeout'); }, 5000); } catch(e) { res('threw ' + e.name); } });
  r.workerWebSocket = await new Promise(function(res){ try { var src = "try { new WebSocket('ws://127.0.0.1:1/wd-collect-probe-ws-worker'); postMessage('CONSTRUCTED(!)'); } catch (e) { postMessage(e.name); }"; var w = new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'}))); w.onmessage = function(e){ res(e.data); }; setTimeout(function(){ res('timeout'); }, 5000); } catch(e) { res('threw ' + e.name); } });
  var wsUrl = '${base.replace(/^http/, 'ws')}/wd-collect-probe-ws';
  try { new WebSocket(wsUrl + '-direct'); r.ws = 'CONSTRUCTED(!)'; } catch(e) { r.ws = e.name; }
  try { new WebSocket.prototype.constructor(wsUrl + '-proto'); r.wsProto = 'CONSTRUCTED(!)'; } catch(e) { r.wsProto = e.name; }
  var bf = document.createElement('iframe'); document.body.appendChild(bf);
  try { new bf.contentWindow.WebSocket(wsUrl + '-iframe'); r.wsIframe = 'CONSTRUCTED(!)'; } catch(e) { r.wsIframe = e.name; }
  var bf2 = document.createElement('iframe'); document.body.appendChild(bf2);
  try { var fw = window.frames[window.frames.length - 1]; new fw.WebSocket(wsUrl + '-frames'); r.wsFrames = 'CONSTRUCTED(!)'; } catch(e) { r.wsFrames = e.name; }
  try { new SharedWorker('${base}/wd-collect-probe-shared.js'); r.sharedWorker = 'CONSTRUCTED(!)'; } catch(e) { r.sharedWorker = e.name; }
  r.serviceWorker = await new Promise(function(res){ if (!navigator.serviceWorker) return res('unsupported'); navigator.serviceWorker.register('/wd-collect-probe-sw.js').then(function(){ res('REGISTERED(!)'); }, function(e){ res('rejected ' + e.name); }); setTimeout(function(){ res('timeout(!)'); }, 5000); });
  try { var w2 = window.open('${base}/wd-collect-probe-popup'); r.popup = w2 ? 'OPENED(!)' : 'null'; } catch(e) { r.popup = 'threw ' + e.name; }
  addEventListener('pagehide', function(){ navigator.sendBeacon(P + '-pagehide', 'p=1'); });
  await sleep(3000);
  return r;
})()`;

const PILOT_PAGE = (base: string) => `<!doctype html><html><head><title>watchdog pilot</title>
<script type="speculationrules">{"prefetch":[{"source":"list","urls":["/wd-collect-probe-spec-prefetch"]}],"prerender":[{"source":"list","urls":["/wd-collect-probe-spec-prerender"]}]}</script>
<link rel="prefetch" href="/wd-collect-probe-link-prefetch">
</head><body><h1>seal self-test</h1><img src="/csp-violation.png" alt=""><a href="${base}/wd-collect-probe-spec-prerender">next</a></body></html>`;

export interface ProbeServer {
  base: string;
  received: Array<{ method: string; url: string; upgrade?: boolean; secPurpose?: string }>;
  close(): Promise<void>;
}

/** Loopback HTTP server that logs every request (and every WebSocket upgrade) it receives. */
export async function startProbeServer(page: (base: string) => string = PILOT_PAGE): Promise<ProbeServer> {
  const received: ProbeServer['received'] = [];
  let base = '';
  const server = http.createServer((req, res) => {
    received.push({ method: req.method ?? '?', url: req.url ?? '', secPurpose: req.headers['sec-purpose'] as string | undefined });
    const u = (req.url ?? '').split('?')[0] ?? '';
    if (u === '/pilot' || u === '/pilot-next') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'reporting-endpoints': `default="${base}/wd-collect-probe-reporting-api"`,
        'content-security-policy-report-only': `img-src 'none'; report-uri /wd-collect-probe-csp-report; report-to default`,
      });
      return res.end(page(base));
    }
    res.writeHead(200, { 'content-type': u.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(u.endsWith('.js') ? '' : 'ok');
  });
  server.on('upgrade', (req, socket) => {
    received.push({ method: 'UPGRADE', url: req.url ?? '', upgrade: true });
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return { base, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A CONNECT to a host outside the allowlist, straight at the proxy: it must be refused. */
export async function proxyRefusalCanary(proxyPort: number, host = 'wd-proxy-canary.invalid'): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) {
        sock.destroy();
        resolve(buf.split('\r\n')[0]!);
      }
    });
    sock.on('error', (e) => resolve('error ' + e.message));
    sock.on('close', () => resolve(buf.split('\r\n')[0] || 'closed without a response'));
    setTimeout(() => {
      sock.destroy();
      resolve('timeout');
    }, 5000);
  });
}

export interface PilotResult {
  ok: boolean;
  probes: Record<string, unknown> | null;
  expectations: Array<{ probe: string; ok: boolean; detail: string }>;
  session: SealedSession;
  received: ProbeServer['received'];
}

export async function runPilot(o: { chromePath: string; profilesDir: string; log: (m: string) => void }): Promise<PilotResult> {
  const server = await startProbeServer();
  const s = await SealedSession.launch({
    name: 'pilot',
    profilesDir: o.profilesDir,
    chromePath: o.chromePath,
    device: 'desktop',
    captureLoaders: false,
    allowConnect: (h, p) => allowConnectHost(h, p, { extraHosts: [LOOPBACK] }),
    intercept: {
      policy: { markers: ['WD_TEST'], extraHosts: [LOOPBACK], extraCollection: [{ id: 'pilot.probe', platform: 'pilot', host: LOOPBACK, path: /^\/wd-collect-probe/ }] },
      isPatchHost: () => false,
      patches: {},
    },
    log: o.log,
  });
  let probes: Record<string, unknown> | null = null;
  let canary = '';
  try {
    await s.goto(`${server.base}/pilot`, 'pilot');
    probes = await s.evaluate<Record<string, unknown>>(pilotProbes(server.base));
    await s.snapshot('pilot');
    canary = await proxyRefusalCanary(s.proxy.port);
    await s.goto(`${server.base}/pilot-next`, 'pilot_navigation'); // fires the pagehide beacon
    await new Promise((r) => setTimeout(r, 2500));
  } finally {
    await s.close();
    await server.close();
  }
  const probePath = (u: string) => {
    try {
      return new URL(u, server.base).pathname;
    } catch {
      return u;
    }
  };
  const failedPath = (suffix: string) =>
    s.state.requests.some((r: CapturedRequest) => r.action === 'fail' && probePath(r.url) === `/wd-collect-probe${suffix}` && (r.failResult === 'ok' || r.failResult === undefined));
  const reached = server.received.filter((x) => x.url.startsWith('/wd-collect-probe'));
  const expectations: PilotResult['expectations'] = [
    ['-fetch', 'fetch()'],
    ['-keepalive', 'fetch keepalive POST'],
    ['-beacon', 'navigator.sendBeacon'],
    ['-img', 'new Image()'],
    ['-xhr', 'XMLHttpRequest POST'],
    ['-iframe', 'iframe navigation'],
    ['-worker', 'dedicated worker fetch()'],
    ['-pagehide', 'sendBeacon during navigation (pagehide)'],
  ].map(([suffix, probe]) => ({ probe: probe!, ok: failedPath(suffix!), detail: failedPath(suffix!) ? 'paused → failed (BlockedByClient)' : 'NOT observed as failed' }));
  const p = (probes ?? {}) as Record<string, string>;
  const inPage = (probe: string, key: string, want: RegExp) => expectations.push({ probe, ok: want.test(String(p[key])), detail: String(p[key]) });
  inPage('WebSocket (in-page seal)', 'ws', /^SecurityError$/);
  inPage('WebSocket via prototype.constructor', 'wsProto', /^SecurityError$/);
  inPage('WebSocket from an about:blank iframe (contentWindow)', 'wsIframe', /^SecurityError$/);
  inPage('WebSocket from an about:blank iframe (window.frames)', 'wsFrames', /^SecurityError$/);
  inPage('WebSocket in a dedicated worker', 'workerWebSocket', /^SecurityError$/);
  inPage('SharedWorker', 'sharedWorker', /^SecurityError$/);
  inPage('service-worker registration', 'serviceWorker', /^rejected SecurityError$/);
  inPage('window.open popup', 'popup', /^null$/);
  expectations.push({ probe: 'no WebSocket handshake reached the server or Chrome', ok: !server.received.some((x) => x.upgrade) && s.webSockets.length === 0, detail: `server upgrades ${server.received.filter((x) => x.upgrade).length}, Chrome webSocketCreated ${s.webSockets.length}` });
  expectations.push({ probe: 'no service worker ran; no popup target', ok: !s.serviceWorkerVersions.some((v) => v.runningStatus !== 'stopped') && s.extraPages.length === 0, detail: `sw versions ${JSON.stringify(s.serviceWorkerVersions)}; extra pages ${s.extraPages.length}; held targets ${s.heldTargets.length}` });
  const spec = reached.filter((x) => /spec-(prefetch|prerender)/.test(x.url));
  expectations.push({ probe: 'speculation-rules prefetch/prerender (browser process, invisible to Fetch)', ok: spec.length === 0, detail: spec.length ? `REACHED the server: ${spec.map((x) => x.url).join(', ')}` : 'never requested (no-preloading preference)' });
  expectations.push({ probe: 'Reporting API (network service, invisible to Fetch)', ok: s.reportingReports.length === 0 && !reached.some((x) => /reporting-api/.test(x.url)), detail: `${s.reportingReports.length} report(s) queued` });
  expectations.push({ probe: 'RECEIVING SIDE: no probe request reached the server', ok: reached.length === 0, detail: reached.length ? reached.map((x) => `${x.method} ${x.url}`).join(', ') : `server saw only: ${[...new Set(server.received.map((x) => x.url.split('?')[0]))].join(' ')}` });
  const carried = (s.proxySummary?.log ?? []).filter((x) => x.action === 'forwarded' || x.action === 'tunnel').length;
  const pageLoads = server.received.filter((x) => /^\/pilot(-next)?$/.test(x.url)).length;
  expectations.push({ probe: 'RECEIVING SIDE: the pilot pages themselves arrived (the page really loaded)', ok: pageLoads === 2, detail: `${pageLoads}/2 page loads received` });
  expectations.push({ probe: 'proxy liveness (the page load went through the gatekeeper proxy)', ok: carried > 0, detail: `${carried} request(s) carried, ${(s.proxySummary?.refusedByPolicy ?? []).length} refused (incl. Chrome background hosts)` });
  expectations.push({ probe: 'proxy refuses a host outside the allowlist', ok: /^HTTP\/1\.[01] 403/.test(canary) && (s.proxySummary?.refusedByPolicy ?? []).some((x) => /^wd-proxy-canary\.invalid:443$/.test(x.target)), detail: canary });
  const noResolve = !JSON.stringify(probes ?? {}).includes('(!)');
  expectations.push({ probe: 'no probe resolved in the page', ok: noResolve, detail: JSON.stringify(probes) });
  return { ok: expectations.every((e) => e.ok), probes, expectations, session: s, received: server.received };
}
