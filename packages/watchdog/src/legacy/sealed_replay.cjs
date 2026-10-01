// ---------------------------------------------------------------------------------------------
// ATTRIBUTION. Copied from the proven sealed-replay harness that produced
// research/11_sealed_replay_verification.md (OpenArt tag verification, 2026-09-29):
//   openart_2026-09-29/crawl/sealed_evidence/tools/sealed_replay.cjs
//   original SHA-256 fa1a428688fb26bee413ed3b381d3b504eb0dacc608bb10218493171054ff04b
// The seal itself (Fetch fail-all on the browser target + every attached target, sealing new
// targets before they resume, the out-of-process gatekeeper proxy, the example.com seal probes,
// the passive vendor-call tracer, SIGKILL-while-sealed teardown, profile deletion) is unchanged.
// Every change made for the watchdog is marked "[watchdog]":
//   [watchdog] 1. main() became runSealedReplay(opts): paths, Chrome binary, profile directory,
//                 scenario set and timings are options; nothing is hard-coded to the research tree;
//                 it returns the run object instead of calling process.exit.
//   [watchdog] 2. COLLECTION SEAL DURING THE PAGE LOAD. The original let the ordinary page-view
//                 hits of the anonymous load through before sealing. With opts.preSeal the Fetch
//                 domain is enabled on every target from the first request, and each paused request
//                 is handed to opts.preSeal.handler (the watchdog's request policy: documents /
//                 scripts / styles / fonts / images needed to render are continued, every collection
//                 or non-GET request is failed and recorded). opts.allowConnect gives the proxy the
//                 same host allowlist. After SEAL the original fail-everything path takes over.
//   [watchdog] 3. puppeteer-core is resolved from the repository's node_modules.
//   [watchdog] 4. The needles used for the final storage scan are parameterised (WD_TEST data).
//   [watchdog] 5. SEAL_PROBES / WRAP_CODE / READY_EXPR / killChromeTree are exported for reuse.
//   [watchdog] 6. Channels outside the Fetch domain are closed as in the journey harness:
//                 opts.profilePrefs is written into the fresh profile before launch (no preloading =
//                 no speculation-rules prefetch/prerender), opts.ignoreDefaultArgs drops puppeteer's
//                 --disable-popup-blocking, and service/shared worker targets are held paused
//                 (never instrumented, never resumed) and recorded in out.seal.heldTargets.
// ---------------------------------------------------------------------------------------------
// Sealed replay harness (OpenArt tag verification, 2026-09-29).
//
// Guarantees (in order):
//  1. Own Chrome (puppeteer-core), FRESH --user-data-dir; never port 9333 (the watchdog launches
//     with pipe:true, so no debugging port is opened at all).
//  2. All browser traffic is forced through a local gatekeeper proxy (gatekeeper_proxy.cjs);
//     QUIC disabled, WebRTC restricted to proxied UDP (i.e. none), no DIRECT fallback.
//  3. Anonymous page load (under the watchdog collection seal: no measurement hit is delivered),
//     then ~8 s for GTM/gtag to initialise.
//  4. SEAL before any synthetic event:
//       - Fetch.enable {urlPattern:'*', requestStage:'Request'} on the browser target (if supported)
//         and on every attached target (page, OOPIFs, workers; new targets are sealed on attach
//         before they are resumed). Every Fetch.requestPaused is recorded then Fetch.failRequest
//         (BlockedByClient).
//       - Network.setBlockedURLs(['*']) on every target (belt and braces), after a Fetch-only probe
//         (only in blockedMode 'both').
//       - Proxy switched to SEALED: open tunnels destroyed, every new connection refused (403),
//         no upstream socket is ever opened again.
//  5. Seal verification probes to example.com (fetch, keepalive fetch, beacon, img, xhr, iframe,
//     worker, websocket).
//  6. Scenario replay with gaps; every intercepted request labelled with the active scenario.
//  7. Chrome is SIGKILLed while still sealed (no unload handlers, no shutdown beacons), the
//     process tree is verified dead, then the profile directory is deleted.
'use strict';
const puppeteer = require('puppeteer-core'); // [watchdog] repo node_modules (was an npx cache path)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { startProxy } = require('./gatekeeper_proxy.cjs');

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // [watchdog] overridable

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const DESKTOP_META = {
  brands: [{ brand: 'Google Chrome', version: '154' }, { brand: 'Chromium', version: '154' }, { brand: 'Not.A/Brand', version: '99' }],
  fullVersionList: [{ brand: 'Google Chrome', version: '154.0.8037.58' }, { brand: 'Chromium', version: '154.0.8037.58' }, { brand: 'Not.A/Brand', version: '99.0.0.0' }],
  platform: 'macOS', platformVersion: '15.6.0', architecture: 'arm', model: '', mobile: false, bitness: '64', wow64: false,
};

const EMAIL = 'seal.test@example.com';
const ITEMS_JS = "[{item_id:'pro_monthly',quantity:1}]";
const ENSURE_GTAG = "var __def=false; if (typeof window.gtag!=='function'){ window.gtag=function gtag(){ window.dataLayer.push(arguments); }; __def=true; }";

// Exactly what the app does (static forensics §3.1/§3.2), with synthetic data only.
// [watchdog] kept as the default set; the watchdog passes its own WD_TEST scenario set.
const SCENARIOS = {
  S1: { desc: "dataLayer.push({event:'signup', user_data:{email}})",
    code: `window.dataLayer.push({event:'signup', user_data:{email:'${EMAIL}'}}); ({pushed:true})` },
  S2: { desc: "dataLayer.push({event:'new_user_signed_up'})",
    code: `window.dataLayer.push({event:'new_user_signed_up'}); ({pushed:true})` },
  S3c: { desc: "CONTROL: gtag('event','purchase',{...}) WITHOUT gtag('set','user_data')",
    code: `(function(){ ${ENSURE_GTAG} gtag('event','purchase',{transaction_id:'sub_SEALTEST_C0',value:56,currency:'USD',items:${ITEMS_JS}}); return {gtagDefinedByHarness:__def}; })()` },
  S3: { desc: "gtag('set','user_data',{email}); gtag('event','purchase',{transaction_id:'sub_SEALTEST_1',value:56,currency:'USD',items})",
    code: `(function(){ ${ENSURE_GTAG} gtag('set','user_data',{email:'${EMAIL}'}); gtag('event','purchase',{transaction_id:'sub_SEALTEST_1',value:56,currency:'USD',items:${ITEMS_JS}}); return {gtagDefinedByHarness:__def}; })()` },
  S4: { desc: "dataLayer.push({event:'first_purchase', eventModel:{transaction_id:'sub_SEALTEST_2',value:300,currency:'USD',items}, user_data:{email}})",
    code: `window.dataLayer.push({event:'first_purchase', eventModel:{transaction_id:'sub_SEALTEST_2',value:300,currency:'USD',items:${ITEMS_JS}}, user_data:{email:'${EMAIL}'}}); ({pushed:true})` },
  S5: { desc: "dataLayer.push({event:'business_subscription', eventModel:{transaction_id:'sub_SEALTEST_3',value:227,currency:'USD'}, user_data:{email}})",
    code: `window.dataLayer.push({event:'business_subscription', eventModel:{transaction_id:'sub_SEALTEST_3',value:227,currency:'USD'}, user_data:{email:'${EMAIL}'}}); ({pushed:true})` },
  S6a: { desc: "gtag('event','purchase_first',{transaction_id:'sub_SEALTEST_4',value:56,currency:'USD'})",
    code: `(function(){ ${ENSURE_GTAG} gtag('event','purchase_first',{transaction_id:'sub_SEALTEST_4',value:56,currency:'USD'}); return {gtagDefinedByHarness:__def}; })()` },
  S6b: { desc: "gtag('event','conversion_event_purchase',{transaction_id:'sub_SEALTEST_5',value:56,currency:'USD',items})",
    code: `(function(){ ${ENSURE_GTAG} gtag('event','conversion_event_purchase',{transaction_id:'sub_SEALTEST_5',value:56,currency:'USD',items:${ITEMS_JS}}); return {gtagDefinedByHarness:__def}; })()` },
  S7: { desc: "EXTRA (app's UET call): uetq.push('event','purchase',{transaction_id:'sub_SEALTEST_6',revenue_value:56,currency:'USD'})",
    code: `(function(){ window.uetq=window.uetq||[]; window.uetq.push('event','purchase',{transaction_id:'sub_SEALTEST_6',revenue_value:56,currency:'USD'}); return {uetqType: typeof window.uetq, isUET: !!(window.uetq && window.uetq.constructor && window.uetq.constructor.name)}; })()` },
};
const SETS = {
  full: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6a', 'S6b', 'S7'],
  iso: ['S3c', 'S3'],
  pilot: [],
};

// Passive call tracer: wraps vendor entry points, records arguments, calls straight through.
const WRAP_CODE = `(function(){
  var T = window.__sealTrace = window.__sealTrace || [];
  function safe(v){ try { return JSON.parse(JSON.stringify(v, function(k,x){ return typeof x==='function' ? '[fn]' : x; })); } catch(e){ return String(v); } }
  function wrap(holder, key, label){
    if (!holder) return 'absent';
    var orig = holder[key];
    if (typeof orig !== 'function') return 'absent(' + typeof orig + ')';
    if (orig.__sealWrapped) return 'already';
    var w = function(){ try { T.push({t: Date.now(), fn: label, args: safe(Array.prototype.slice.call(arguments))}); } catch(e){} return orig.apply(this, arguments); };
    Object.getOwnPropertyNames(orig).forEach(function(p){ if (['length','name','prototype','arguments','caller'].indexOf(p) < 0) { try { w[p] = orig[p]; } catch(e){} } });
    w.__sealWrapped = true;
    holder[key] = w;
    if (holder[key] !== w) { var dsc = Object.getOwnPropertyDescriptor(holder, key); return 'assignment-ignored(' + (dsc ? ('own:' + (dsc.get ? 'accessor' : 'writable=' + dsc.writable)) : 'inherited') + ', sameObjEachRead=' + (holder === holder) + ')'; }
    return 'wrapped(verified)';
  }
  return {
    twq: wrap(window, 'twq', 'twq'),
    rdt: wrap(window, 'rdt', 'rdt'),
    lintrk: wrap(window, 'lintrk', 'lintrk'),
    ttq_identify: wrap(window.ttq, 'identify', 'ttq.identify'),
    ttq_track: wrap(window.ttq, 'track', 'ttq.track'),
    ttq_identity_stable: (function(){ try { return window.ttq === window.ttq; } catch(e) { return 'err'; } })(),
    ttq_track_after: (function(){ try { return !!(window.ttq && window.ttq.track && window.ttq.track.__sealWrapped); } catch(e) { return 'err'; } })(),
    uetq_push: (window.uetq && !Array.isArray(window.uetq)) ? wrap(window.uetq, 'push', 'uetq.push') : 'absent-or-array'
  };
})()`;

const SEAL_PROBES = `(async function(tagSuffix){
  var base = 'https://example.com/seal-test';
  var r = {};
  try { await fetch(base + tagSuffix); r.fetch = 'RESOLVED(!)'; } catch(e) { r.fetch = 'rejected: ' + e.message; }
  try { await fetch(base + '-keepalive' + tagSuffix, {method:'POST', body:'sealprobe=1', keepalive:true, mode:'no-cors'}); r.keepalive = 'RESOLVED(!)'; } catch(e) { r.keepalive = 'rejected: ' + e.message; }
  try { r.beaconReturned = navigator.sendBeacon(base + '-beacon' + tagSuffix, 'sealprobe=1'); } catch(e) { r.beaconReturned = 'threw ' + e.message; }
  r.img = await new Promise(function(res){ var i = new Image(); i.onload = function(){ res('LOADED(!)'); }; i.onerror = function(){ res('onerror'); }; i.src = base + '-img' + tagSuffix; setTimeout(function(){ res('timeout'); }, 4000); });
  r.xhr = await new Promise(function(res){ var x = new XMLHttpRequest(); x.open('GET', base + '-xhr' + tagSuffix); x.onload = function(){ res('LOADED(!) ' + x.status); }; x.onerror = function(){ res('onerror'); }; x.send(); setTimeout(function(){ res('timeout'); }, 4000); });
  r.iframe = await new Promise(function(res){ var f = document.createElement('iframe'); f.style.display = 'none'; f.onload = function(){ res('onload (error page)'); }; f.src = base + '-iframe' + tagSuffix; document.body.appendChild(f); setTimeout(function(){ res('timeout'); }, 4000); });
  r.worker = await new Promise(function(res){ try { var src = "fetch('" + base + "-worker" + tagSuffix + "').then(function(){postMessage('RESOLVED(!)')}).catch(function(e){postMessage('rejected: '+e.message)})"; var w = new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'}))); w.onmessage = function(e){ res(e.data); }; w.onerror = function(e){ res('worker onerror: ' + (e.message || 'blocked')); }; setTimeout(function(){ res('timeout'); }, 5000); } catch(e) { res('threw ' + e.message); } });
  r.websocket = await new Promise(function(res){ try { var ws = new WebSocket('wss://example.com/seal-test-ws' + tagSuffix); ws.onopen = function(){ res('OPEN(!)'); }; ws.onerror = function(){ res('onerror'); }; setTimeout(function(){ res('timeout'); }, 5000); } catch(e) { res('threw ' + e.message); } });
  return r;
})`;

// [watchdog] hoisted from main() so the journeys can reuse the same readiness probe
const READY_EXPR = `(function(){ var g = window.google_tag_manager || {}; return {
      href: location.href, title: document.title, webdriver: navigator.webdriver, ua: navigator.userAgent,
      gtmKeys: Object.keys(g), hasContainer: !!g['GTM-56CMP8K'], dataLayerLen: (window.dataLayer||[]).length,
      gtag: typeof window.gtag, ttq: typeof window.ttq, ttqLoaded: !!(window.ttq && window.ttq._i), twq: typeof window.twq, twqExe: !!(window.twq && window.twq.exe),
      rdt: typeof window.rdt, rdtSendEvent: !!(window.rdt && window.rdt.sendEvent), lintrk: typeof window.lintrk, uetq: typeof window.uetq, uetqIsArray: Array.isArray(window.uetq),
      fbq: typeof window.fbq, oaiq: typeof window.oaiq, googleTagData: typeof window.google_tag_data }; })()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const iso = () => new Date().toISOString();

// [watchdog] the original hardKill() body as a reusable function (same algorithm):
// SIGKILL Chrome's whole process tree, wait until every pid is gone, report survivors.
async function killChromeTree(pid, profile) {
  const teardown = {};
  let tree = [];
  try {
    const ps = execSync('ps -A -o pid=,ppid=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [p, pp] of ps) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
    const stack = [pid];
    while (stack.length) { const x = stack.pop(); tree.push(x); for (const c of (kids.get(x) || [])) stack.push(c); }
  } catch (e) { teardown.psErr = e.message; tree = [pid]; }
  teardown.processTree = tree;
  teardown.killedAt = iso();
  try { process.kill(pid, 'SIGKILL'); } catch (e) { teardown.killErr = e.message; }
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const alive = tree.filter((p) => { try { process.kill(p, 0); return true; } catch (e) { return false; } });
    if (!alive.length) { teardown.allDeadAfterMs = (i + 1) * 250; break; }
    if (i === 8) for (const p of alive) { try { process.kill(p, 'SIGKILL'); } catch (e) {} }
  }
  teardown.stillAlive = tree.filter((p) => { try { process.kill(p, 0); return true; } catch (e) { return false; } });
  if (profile) { try { const hits = execSync(`pgrep -f "${path.basename(profile)}" || true`).toString().trim(); teardown.pgrepProfile = hits ? hits.split('\n') : []; } catch (e) { teardown.pgrepErr = e.message; } }
  return teardown;
}

// [watchdog] Chrome launch arguments shared with the journey runner (unchanged from the original).
function sealedLaunchArgs(proxyPort, extra) {
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=DnsOverHttps',
    '--lang=en-US', '--window-size=1440,900',
  ].concat(extra || []);
}

async function runSealedReplay(opts) {
  opts = opts || {};
  const runName = opts.runName || 'pilot';
  const pageUrl = opts.pageUrl || 'https://example.com/';
  const setName = opts.setName || 'custom';
  const blockedMode = opts.blockedMode || 'fetchonly';
  const scenarios = opts.scenarios || SCENARIOS; // [watchdog]
  const scenarioList = opts.scenarioList || SETS[opts.setName || 'pilot'];
  if (!scenarioList) throw new Error('unknown set ' + setName);
  const needles = opts.needles || { email: 'seal.test', txn: 'SEALTEST' }; // [watchdog]
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const gapMs = opts.scenarioGapMs == null ? 6000 : opts.scenarioGapMs;
  const tailMs = opts.tailMs == null ? 12000 : opts.tailMs;
  const settleMs = opts.settleMs == null ? 8000 : opts.settleMs;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const profile = opts.profileDir; // [watchdog] fresh dir chosen by the caller (packages/watchdog/.profiles/...)
  if (!profile) throw new Error('profileDir is required');
  const outFile = opts.outFile || null;
  const BODIES = opts.bodiesDir || null;
  if (BODIES) fs.mkdirSync(BODIES, { recursive: true });
  const T0 = Date.now();

  const out = {
    meta: { runName, pageUrl, setName, blockedMode, stamp, profile, outFile, startedAt: iso(), needles, node: process.version, scenarioList },
    load: {}, versions: {}, readiness: null, seal: { sessions: [], preSealSessions: [] }, sealProbes: [], wrap: null,
    timeline: [], captures: [], net: [], jsTrace: [], console: [], targets: [], final: {}, proxy: null, teardown: {},
  };
  let current = 'LOAD';
  let SEALED = false;
  let sealT = null;
  const sessions = []; // {s, label, type}
  const netById = new Map();
  const preSeal = opts.preSeal || null; // [watchdog] {handler(sess, event, ctx), patterns}

  const proxy = await startProxy({ allowConnect: opts.allowConnect }); // [watchdog] host allowlist pre-seal
  out.meta.proxyPort = proxy.port;

  const launchArgs = sealedLaunchArgs(proxy.port, opts.extraArgs);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  if (opts.profilePrefs) { // [watchdog] 6. preferences in place before Chrome reads them
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify(opts.profilePrefs));
  }
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: opts.chromePath || DEFAULT_CHROME, headless: true, userDataDir: profile, pipe: true, // [watchdog] pipe: no debugging port
      ignoreDefaultArgs: opts.ignoreDefaultArgs || ['--enable-automation'], args: launchArgs, defaultViewport: null, protocolTimeout: 180000, // [watchdog] 6.
    });
  } catch (err) { // [watchdog] never leave the proxy listening or the profile behind
    proxy.seal(); await proxy.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true });
    throw err;
  }
  const chromeProc = browser.process();
  out.meta.chromeVersion = await browser.version();
  out.meta.chromePid = chromeProc ? chromeProc.pid : null;
  out.meta.spawnArgs = chromeProc ? chromeProc.spawnargs : null;
  const browserSession = await browser.target().createCDPSession();

  let killed = false;
  async function hardKill(reason) {
    if (killed) return; killed = true;
    out.teardown.reason = reason;
    out.teardown.proxySealedBeforeKill = proxy.state.sealed;
    if (!proxy.state.sealed) proxy.seal(); // never let anything out during shutdown
    Object.assign(out.teardown, await killChromeTree(out.meta.chromePid, profile)); // [watchdog] same algorithm, shared helper
  }
  const onSignal = async (sig) => { await hardKill('signal ' + sig); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} process.exit(2); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);

  function recFetchPaused(sess, layer, label) {
    sess.on('Fetch.requestPaused', async (e) => {
      if (!SEALED && preSeal) { // [watchdog] collection seal before the full seal
        try { await preSeal.handler(sess, e, { layer, label, scenario: current, t: Date.now() - T0 }); } catch (err) { out.console.push({ t: Date.now() - T0, type: 'harness_err', text: 'preSeal handler ' + err.message }); try { await sess.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }); } catch (e2) {} }
        return;
      }
      const q = e.request || {};
      const rec = {
        layer, sess: label, t: Date.now() - T0, iso: iso(), scenario: current, requestId: e.requestId, networkId: e.networkId || null,
        frameId: e.frameId || null, resourceType: e.resourceType, url: q.url, method: q.method, headers: q.headers,
        postData: q.postData !== undefined ? q.postData : null, hasPostData: !!q.hasPostData,
        postDataEntriesB64: Array.isArray(q.postDataEntries) ? q.postDataEntries.map((x) => x.bytes || '') : null,
        responseStatusCode: e.responseStatusCode || null,
      };
      out.captures.push(rec);
      try { await sess.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }); rec.failRequest = 'ok'; } catch (err) { rec.failRequest = 'err: ' + err.message; }
    });
  }

  async function sealSession(x) {
    const info = { label: x.label, at: iso() };
    try { await x.s.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); info.fetch = 'enabled'; } catch (e) { info.fetch = 'err: ' + e.message; }
    if (x.blockedApplied || out.seal.blockedPhase) {
      try { await x.s.send('Network.setBlockedURLs', { urls: ['*'] }); info.blockedURLs = 'set'; x.blockedApplied = true; } catch (e) { info.blockedURLs = 'err: ' + e.message; }
    }
    x.sealed = true;
    out.seal.sessions.push(info);
  }

  async function instrument(s, label, kind) {
    const x = { s, label, kind, sealed: false };
    sessions.push(x);
    recFetchPaused(s, 'fetch-target', label);
    // [watchdog] collection seal: intercept from the very first request of this target
    if (preSeal && !SEALED) {
      try { await s.send('Fetch.enable', { patterns: preSeal.patterns }); x.preSealFetch = 'enabled'; } catch (err) { x.preSealFetch = 'err: ' + err.message; }
      // [watchdog] channels invisible to Fetch (WebSocket, service/shared workers, popups): run
      // preSeal.initScript in every page/frame/worker before any of its own scripts run
      if (preSeal.initScript) {
        // Page.enable first: without the Page domain enabled, addScriptToEvaluateOnNewDocument is accepted
        // but NOT applied to later documents (verified: the script never ran on the navigated page)
        try { if (kind === 'page' || kind === 'iframe') { await s.send('Page.enable'); await s.send('Page.addScriptToEvaluateOnNewDocument', { source: preSeal.initScript, runImmediately: true }); } await s.send('Runtime.evaluate', { expression: preSeal.initScript }); x.preSealInit = 'ok'; } catch (err) { x.preSealInit = 'err: ' + err.message; }
      }
      out.seal.preSealSessions.push({ label, kind, at: iso(), fetch: x.preSealFetch, init: x.preSealInit || 'n/a' });
    }
    s.on('Network.requestWillBeSent', (e) => {
      const q = e.request || {};
      const post = SEALED;
      const init = e.initiator || {};
      let stack = null;
      if (init.stack && init.stack.callFrames) stack = init.stack.callFrames.slice(0, 6).map((f) => `${f.functionName || '(anon)'}@${f.url}:${f.lineNumber}`);
      const r = {
        sess: label, phase: post ? 'post' : 'pre', scenario: current, t: Date.now() - T0, iso: iso(), requestId: e.requestId,
        url: q.url, method: q.method, type: e.type, redirectFrom: e.redirectResponse ? true : false,
        postData: q.postData !== undefined ? (post ? q.postData : String(q.postData).slice(0, 20000)) : null, hasPostData: !!q.hasPostData,
        headers: post ? q.headers : undefined, initiator: { type: init.type, url: init.url || null, stack, requestId: init.requestId || null }, // [watchdog] requestId links a CORS preflight to its request
      };
      out.net.push(r);
      netById.set(label + ':' + e.requestId, r);
      if (q.hasPostData && q.postData === undefined) {
        s.send('Network.getRequestPostData', { requestId: e.requestId }).then((pd) => { r.postData = pd.postData; r.postDataB64 = !!pd.base64Encoded; }).catch((err) => { r.postDataErr = err.message; });
      }
    });
    s.on('Network.responseReceived', (e) => {
      const r = netById.get(label + ':' + e.requestId); if (!r) return;
      const rs = e.response || {};
      r.status = rs.status; r.mime = rs.mimeType; r.fromDiskCache = !!rs.fromDiskCache; r.fromSW = !!rs.fromServiceWorker; r.fromPrefetch = !!rs.fromPrefetchCache; r.remoteIP = rs.remoteIPAddress || null;
      if (SEALED) r.responseAfterSeal = true;
      else r.responseReceived = true; // [watchdog] needed for the pre-seal zero-leak accounting
    });
    s.on('Network.webSocketCreated', (e) => { out.net.push({ sess: label, phase: SEALED ? 'post' : 'pre', scenario: current, t: Date.now() - T0, iso: iso(), requestId: e.requestId, url: e.url, method: 'GET', type: 'WebSocket(created)' }); });
    s.on('Network.webSocketWillSendHandshakeRequest', (e) => { out.net.push({ sess: label, phase: SEALED ? 'post' : 'pre', scenario: current, t: Date.now() - T0, iso: iso(), requestId: e.requestId, url: '(ws handshake)', method: 'GET', type: 'WebSocket(handshake-attempt)' }); });
    s.on('Network.requestServedFromCache', (e) => { const r = netById.get(label + ':' + e.requestId); if (r) r.servedFromCache = true; });
    s.on('Network.loadingFailed', (e) => {
      const r = netById.get(label + ':' + e.requestId); if (!r) return;
      r.failed = e.errorText; r.blockedReason = e.blockedReason || null; r.canceled = !!e.canceled; r.failedAtPhase = SEALED ? 'post' : 'pre'; r.corsError = (e.corsErrorStatus && e.corsErrorStatus.corsError) || undefined; // [watchdog]
    });
    s.on('Network.loadingFinished', async (e) => {
      const r = netById.get(label + ':' + e.requestId); if (!r) return;
      r.finished = true; if (SEALED) r.finishedAfterSeal = true;
      if (!SEALED && BODIES && r.type === 'Script' && /googletagmanager\.com\/(gtm|gtag)|openart\.ai\/4vu8\//.test(r.url)) {
        try {
          const b = await s.send('Network.getResponseBody', { requestId: e.requestId });
          const body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
          const h = sha256(body);
          fs.writeFileSync(path.join(BODIES, h + '.js'), body);
          const ver = (body.match(/"version":"(\d+)"/) || [])[1] || null;
          const containers = Array.from(new Set((body.match(/GTM-[A-Z0-9]{6,8}/g) || []))).slice(0, 5);
          const awIds = Array.from(new Set((body.match(/AW-\d{9,12}/g) || []))).slice(0, 5);
          out.versions[r.url] = { sha256: h, bytes: body.length, containerVersion: ver, containers, awIds, file: 'script_bodies/' + h + '.js' };
        } catch (err) { out.versions[r.url] = { err: err.message }; }
      }
    });
    s.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description || a.type))).join(' ');
      out.console.push({ t: Date.now() - T0, scenario: current, sess: label, type: e.type, text: text.slice(0, 1500) });
    });
    s.on('Runtime.exceptionThrown', (e) => {
      const d = e.exceptionDetails || {};
      out.console.push({ t: Date.now() - T0, scenario: current, sess: label, type: 'exception', text: ((d.exception && d.exception.description) || d.text || '').slice(0, 800) });
    });
    s.on('Target.attachedToTarget', async (e) => {
      let child = null;
      const tl = e.targetInfo.type + ':' + (e.targetInfo.url || '').slice(0, 120);
      out.targets.push({ t: Date.now() - T0, scenario: current, via: label, type: e.targetInfo.type, url: e.targetInfo.url, waiting: e.waitingForDebugger, afterSeal: SEALED });
      if (e.targetInfo.type === 'service_worker' || e.targetInfo.type === 'shared_worker') { // [watchdog] 6. held paused
        (out.seal.heldTargets = out.seal.heldTargets || []).push({ type: e.targetInfo.type, url: e.targetInfo.url, via: label, scenario: current });
        return;
      }
      try {
        child = s.connection().session(e.sessionId);
        if (child) {
          const cx = await instrument(child, tl, e.targetInfo.type);
          if (SEALED) await sealSession(cx); // seal BEFORE the new target is resumed
        }
      } catch (err) { out.console.push({ t: Date.now() - T0, type: 'harness_err', text: 'attach ' + err.message }); }
      finally { if (child && e.waitingForDebugger) await child.send('Runtime.runIfWaitingForDebugger').catch(() => {}); }
    });
    for (const [m, p] of [
      ['Network.enable', { maxPostDataSize: 16 * 1024 * 1024, maxTotalBufferSize: 200e6, maxResourceBufferSize: 50e6 }],
      ['Runtime.enable', {}],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ]) { try { await s.send(m, p); } catch (err) { /* some targets lack a domain */ } }
    if (kind === 'page' || kind === 'iframe') {
      try { await s.send('Emulation.setUserAgentOverride', { userAgent: opts.userAgent || DESKTOP_UA, acceptLanguage: 'en-US,en', platform: 'MacIntel', userAgentMetadata: opts.userAgentMetadata || DESKTOP_META }); } catch (err) {}
    } else {
      try { await s.send('Network.setUserAgentOverride', { userAgent: opts.userAgent || DESKTOP_UA, acceptLanguage: 'en-US,en', platform: 'MacIntel', userAgentMetadata: opts.userAgentMetadata || DESKTOP_META }); } catch (err) {}
    }
    return x;
  }

  // Service/shared workers are not children of the page session: catch them at browser level.
  browser.on('targetcreated', async (t) => {
    try {
      const ty = t.type();
      out.targets.push({ t: Date.now() - T0, scenario: current, via: 'browser', type: ty, url: t.url(), afterSeal: SEALED });
      if (ty === 'service_worker' || ty === 'shared_worker') { // [watchdog] 6. held paused, never instrumented/resumed (was: instrument)
        (out.seal.heldTargets = out.seal.heldTargets || []).push({ type: ty, url: t.url(), via: 'browser', scenario: current });
      }
    } catch (err) { out.console.push({ t: Date.now() - T0, type: 'harness_err', text: 'targetcreated ' + err.message }); }
  });
  recFetchPaused(browserSession, 'fetch-browser', 'browser');
  // [watchdog] browser-level interception also runs under the collection seal (service-worker
  // script fetches and other requests not owned by an attached target)
  if (preSeal) { try { await browserSession.send('Fetch.enable', { patterns: preSeal.patterns }); out.seal.preSealBrowserFetch = 'enabled'; } catch (e) { out.seal.preSealBrowserFetch = 'unsupported: ' + e.message; } }

  let mainErr = null;
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    const pageSession = await page.createCDPSession();
    await instrument(pageSession, 'page', 'page');
    // [watchdog] 6. observe the channels outside Fetch for the zero-leak proof, and close popups
    out.seal.swVersions = []; out.seal.reportingReports = []; out.seal.extraPages = [];
    pageSession.on('ServiceWorker.workerVersionUpdated', (e) => { for (const v of e.versions || []) out.seal.swVersions.push({ scriptURL: v.scriptURL, runningStatus: v.runningStatus, status: v.status, scenario: current }); });
    pageSession.on('Network.reportingApiReportAdded', (e) => { out.seal.reportingReports.push({ type: e.report.type, destination: e.report.destination, status: e.report.status }); });
    for (const [m, p] of [['ServiceWorker.enable', {}], ['Network.enableReportingApi', { enable: true }], ['Page.setPrerenderingAllowed', { isAllowed: false }]]) { try { await pageSession.send(m, p); } catch (err) { out.console.push({ t: Date.now() - T0, type: 'harness_err', text: m + ' ' + err.message }); } }
    const mainTarget = page.target();
    browser.on('targetcreated', async (t) => {
      if (t.type() !== 'page' || t === mainTarget) return;
      const rec = { url: t.url(), scenario: current, closed: false };
      out.seal.extraPages.push(rec);
      try { await browserSession.send('Target.closeTarget', { targetId: t._targetId }); rec.closed = true; } catch (err) {}
    });
    const evalPage = async (expression, awaitPromise = false) => {
      const r = await pageSession.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: false });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
      return r.result ? r.result.value : undefined;
    };

    // ---- 1. Ordinary anonymous page load (under the collection seal) ----
    current = 'LOAD';
    log('replay: loading ' + pageUrl);
    const tl0 = Date.now();
    try { await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 }); out.load.status = 'load'; } catch (e) { out.load.status = 'goto-err: ' + e.message; }
    out.load.ms = Date.now() - tl0;
    out.load.finalUrl = page.url();
    await sleep(settleMs);
    let ready = await evalPage(READY_EXPR);
    for (let i = 0; i < 12 && !(ready && ready.hasContainer && ready.ttqLoaded && ready.twqExe && ready.rdtSendEvent && ready.lintrk === 'function'); i++) { await sleep(1000); ready = await evalPage(READY_EXPR); }
    out.readiness = ready;
    if (opts.screenshotPath) { try { fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true }); await page.screenshot({ path: opts.screenshotPath }); out.load.screenshot = opts.screenshotPath; } catch (e) { out.load.screenshotErr = e.message; } }
    out.preSealDataLayer = await evalPage(`JSON.stringify((window.dataLayer||[]).map(function(m){ try { if (m && typeof m.length==='number' && !Array.isArray(m) && m[0]!==undefined) return {__arguments: Array.prototype.slice.call(m)}; return m; } catch(e){ return String(m); } }), function(k,v){ return typeof v==='function' ? '[fn]' : (v instanceof Node ? '[node]' : v); })`);

    // ---- 2. SEAL ----
    current = 'SEAL';
    SEALED = true;
    sealT = Date.now();
    out.seal.startedAt = iso();
    try { await browserSession.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); out.seal.browserFetch = 'enabled'; } catch (e) { out.seal.browserFetch = 'unsupported: ' + e.message; }
    for (const x of sessions.slice()) if (!x.sealed) await sealSession(x);
    out.seal.proxyTunnelsDestroyed = proxy.seal();
    out.seal.proxySealedAt = iso();
    out.seal.targetsAtSeal = (await browserSession.send('Target.getTargets')).targetInfos.map((ti) => ({ type: ti.type, url: ti.url, attached: ti.attached }));
    await sleep(1500);

    // ---- 3. Seal verification, phase A: Fetch interception only ----
    current = 'SEALTEST_A_fetch_only';
    out.sealProbes.push({ phase: 'A_fetch_only', at: iso(), result: await evalPage(SEAL_PROBES + "('?phase=A')", true) });
    await sleep(2000);
    // ---- phase B: add Network.setBlockedURLs(['*']) everywhere (belt and braces) ----
    if (blockedMode === 'both') {
      out.seal.blockedPhase = true;
      for (const x of sessions.slice()) {
        try { await x.s.send('Network.setBlockedURLs', { urls: ['*'] }); x.blockedApplied = true; out.seal.sessions.push({ label: x.label, at: iso(), blockedURLs: 'set' }); } catch (e) { out.seal.sessions.push({ label: x.label, at: iso(), blockedURLs: 'err: ' + e.message }); }
      }
      current = 'SEALTEST_B_fetch_plus_blockedURLs';
      out.sealProbes.push({ phase: 'B_fetch_plus_blockedURLs', at: iso(), result: await evalPage(SEAL_PROBES + "('?phase=B')", true) });
      await sleep(2000);
    }

    // ---- 4. Passive tracer ----
    current = 'WRAP';
    out.wrap = await evalPage(WRAP_CODE);
    await sleep(500);

    // ---- 5. Scenarios ----
    let traceSeen = 0;
    for (const name of scenarioList) {
      const sc = scenarios[name];
      current = name;
      log('replay: scenario ' + name);
      const before = await evalPage(`({dataLayerLen:(window.dataLayer||[]).length, gtag: typeof window.gtag})`);
      const tStart = iso();
      const result = await evalPage(sc.code);
      await sleep(gapMs);
      const trace = await evalPage(`(window.__sealTrace||[]).slice(${traceSeen})`);
      traceSeen += Array.isArray(trace) ? trace.length : 0;
      if (Array.isArray(trace)) for (const tr of trace) out.jsTrace.push(Object.assign({ scenario: name }, tr));
      const after = await evalPage(`({dataLayerLen:(window.dataLayer||[]).length, last: JSON.stringify((window.dataLayer||[]).slice(-3).map(function(m){ try { if (m && typeof m.length==='number' && !Array.isArray(m) && m[0]!==undefined) return {__arguments: Array.prototype.slice.call(m)}; return m; } catch(e){ return String(m);} }), function(k,v){ return typeof v==='function' ? '[fn]' : v; })})`);
      out.timeline.push({ scenario: name, desc: sc.desc, start: tStart, end: iso(), before, result, after });
    }
    current = 'TAIL';
    await sleep(tailMs);
    const trace = await evalPage(`(window.__sealTrace||[]).slice(${traceSeen})`);
    if (Array.isArray(trace)) for (const tr of trace) out.jsTrace.push(Object.assign({ scenario: 'TAIL' }, tr));

    // ---- 6. Final state (what queued/retry state would have been left behind) ----
    out.final.storage = await evalPage(`(function(){ function d(st){ var o={}; try { for (var i=0;i<st.length;i++){ var k=st.key(i); var v=st.getItem(k)||''; o[k]={len:v.length, hasEmail: v.indexOf(${JSON.stringify(needles.email)})>=0, hasSealTxn: v.indexOf(${JSON.stringify(needles.txn)})>=0, head: v.slice(0,300)}; } } catch(e){ o.__err=String(e); } return o; } return {local: d(localStorage), session: d(sessionStorage)}; })()`);
    out.final.targets = (await browserSession.send('Target.getTargets')).targetInfos.map((ti) => ({ type: ti.type, url: ti.url, attached: ti.attached }));
  } catch (e) {
    mainErr = e;
    out.meta.error = String(e && e.stack || e);
  } finally {
    current = 'TEARDOWN';
    await hardKill(mainErr ? 'error' : 'normal');
    await sleep(1500);
    out.proxy = proxy.summary();
    out.proxy.log = proxy.state.log;
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { out.teardown.rmErr = e.message; }
    out.teardown.profileDeleted = !fs.existsSync(profile);
    out.teardown.at = iso();
    await proxy.close();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); // [watchdog]
    out.meta.sealAtMs = sealT ? sealT - T0 : null;
    out.meta.finishedAt = iso();
    if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(out, null, 1)); }
  }
  return out;
}

// [watchdog] direct CLI kept for parity with the original tool (writes into the cwd).
if (require.main === module) {
  process.on('unhandledRejection', () => { /* puppeteer emits these after SIGKILL; ignore */ });
  const runName = process.argv[2] || 'pilot';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  runSealedReplay({
    runName, pageUrl: process.argv[3] || 'https://example.com/', setName: process.argv[4] || 'pilot', blockedMode: process.argv[5] || 'both',
    profileDir: path.resolve(`sealed_${runName}_${stamp}`), outFile: path.resolve(`run_${runName}_${stamp}.json`), bodiesDir: path.resolve('script_bodies'),
  }).then((out) => {
    console.log(JSON.stringify({ outFile: out.meta.outFile, captures: out.captures.length, net: out.net.length, sealProbes: out.sealProbes, teardown: out.teardown, err: out.meta.error || null }, null, 1));
    process.exit(0);
  });
}

module.exports = { runSealedReplay, killChromeTree, sealedLaunchArgs, SCENARIOS, SETS, SEAL_PROBES, WRAP_CODE, READY_EXPR, DESKTOP_UA, DESKTOP_META, DEFAULT_CHROME };
