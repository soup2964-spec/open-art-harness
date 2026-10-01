// ---------------------------------------------------------------------------------------------
// ATTRIBUTION. Copied from the proven sealed-replay tooling that produced
// research/11_sealed_replay_verification.md (OpenArt tag verification, 2026-09-29):
//   openart_2026-09-29/crawl/sealed_evidence/tools/decode.cjs
//   original SHA-256 a06937bf5b9b78640a207fba6bbf92183b05ced6efe3b6c29f98ae5453c2d48a
// Every change made for the watchdog is marked "[watchdog]". The decoding logic (vendorOf,
// decodeBody, extractFields, describeEme, leak accounting) is unchanged.
//   [watchdog] 1. Markers are parameterised: buildMarkers({email, txnScenario}) builds the same ten
//                 email encodings and plaintext/SHA-256 transaction markers for any synthetic data
//                 set (the watchdog uses WD_TEST_* data; the defaults stay the SEALTEST ones so the
//                 saved 2026-09-29 runs still decode identically).
//   [watchdog] 2. decodeCapture() is the original per-request map callback, extracted so the
//                 watchdog can decode a single intercepted request; analyzeRun() is analyze()
//                 without file I/O. analyze(runFile) keeps its original contract.
//   [watchdog] 3. More helpers are exported (decodeBody, parseParams, extractFields, ...).
// ---------------------------------------------------------------------------------------------
// Decoder / analyzer for sealed-replay captures.
// Usage: node decode.cjs <run_*.json> [more runs...]   -> writes decoded_<run>.json next to each run
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const EMAIL = 'seal.test@example.com';
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// [watchdog] builder for the marker tables (identical encodings to the original constants)
function buildMarkers(o) {
  o = o || {};
  const email = o.email || EMAIL;
  const at = email.indexOf('@');
  const dotless = at > 0 ? email.slice(0, at).replace(/\./g, '') + email.slice(at) : email;
  const emailMarkers = {
    plaintext: email,
    urlencoded: encodeURIComponent(email),
    sha256_hex: sha(email).toString('hex'),
    sha256_b64: sha(email).toString('base64'),
    sha256_b64url: sha(email).toString('base64url'),
    sha256_hex_localpart_dots_removed: sha(dotless).toString('hex'),
    sha256_hex_uppercase_input: sha(email.toUpperCase()).toString('hex'),
    sha256_hex_of_hex: sha(sha(email).toString('hex')).toString('hex'),
    md5_hex: md5(email),
    sha1_hex: sha1(email),
  };
  const txnScenario = o.txnScenario || {
    sub_SEALTEST_C0: 'S3c', sub_SEALTEST_1: 'S3', sub_SEALTEST_2: 'S4', sub_SEALTEST_3: 'S5',
    sub_SEALTEST_4: 'S6a', sub_SEALTEST_5: 'S6b', sub_SEALTEST_6: 'S7',
  };
  const txnMarkers = {};
  for (const t of Object.keys(txnScenario)) { txnMarkers[t] = t; txnMarkers['sha256(' + t + ')'] = sha(t).toString('hex'); }
  return { EMAIL_MARKERS: emailMarkers, TXN_MARKERS: txnMarkers, TXN_SCENARIO: txnScenario };
}

// Every representation of the synthetic email we look for, anywhere in URL or body.
const DEFAULT_MARKERS = buildMarkers(); // [watchdog] same values as the original constants
const EMAIL_MARKERS = DEFAULT_MARKERS.EMAIL_MARKERS;
const TXN_SCENARIO = DEFAULT_MARKERS.TXN_SCENARIO;
const TXN_MARKERS = DEFAULT_MARKERS.TXN_MARKERS;

function vendorOf(u) {
  const h = u.hostname; const p = u.pathname;
  if (h === 'example.com') return 'seal_probe';
  if (h === 'openart.ai' && p.startsWith('/4vu8/')) return 'google';
  if (/(^|\.)googleadservices\.com$|(^|\.)doubleclick\.net$|(^|\.)google\.com$|(^|\.)googletagmanager\.com$|google-analytics\.com$|googlesyndication\.com$/.test(h)) return 'google';
  if (/tiktok\.com$|tiktokw\.us$/.test(h)) return 'tiktok';
  if (/^t\.co$|twitter\.com$|ads-twitter\.com$/.test(h)) return 'x';
  if (/reddit(static)?\.com$/.test(h)) return 'reddit';
  if (/linkedin\.com$|licdn\.com$/.test(h)) return 'linkedin';
  if (/bing\.com$|bing\.net$/.test(h)) return 'microsoft_uet';
  if (/clarity\.ms$/.test(h)) return 'clarity';
  if (/facebook\.(com|net)$|fbcdn\.net$|\.on\.aws$|\.run\.app$/.test(h)) return 'meta';
  if (/amplitude\.com$/.test(h)) return 'amplitude';
  if (/statsig|prodregistryv2\.org$|cloudflare-dns\.com$/.test(h)) return 'statsig';
  if (/openai\.com$/.test(h)) return 'openai_ads';
  if (/hotjar/.test(h)) return 'hotjar';
  if (/openart\.ai$/.test(h)) return 'openart_app';
  return 'other:' + h;
}
const AD_VENDORS = new Set(['google', 'tiktok', 'x', 'reddit', 'linkedin', 'microsoft_uet', 'meta', 'openai_ads']);

function decodeBody(cap) {
  // Prefer raw bytes (Fetch postDataEntries) so binary/gzip bodies decode losslessly.
  let buf = null;
  if (cap.postDataEntriesB64 && cap.postDataEntriesB64.length) buf = Buffer.concat(cap.postDataEntriesB64.map((b) => Buffer.from(b, 'base64')));
  else if (cap.postData) buf = Buffer.from(String(cap.postData), 'utf8');
  if (!buf || !buf.length) return { raw: null, text: null, encoding: null };
  let text = null; let encoding = 'identity';
  // [watchdog] page-controlled bodies: cap the inflated size (a gzip bomb must not exhaust memory)
  const LIMIT = { maxOutputLength: 16 * 1024 * 1024 };
  const tries = [['gzip', (b) => zlib.gunzipSync(b, LIMIT)], ['deflate', (b) => zlib.inflateSync(b, LIMIT)], ['deflate-raw', (b) => zlib.inflateRawSync(b, LIMIT)], ['brotli', (b) => zlib.brotliDecompressSync(b, LIMIT)]];
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { text = zlib.gunzipSync(buf, LIMIT).toString('utf8'); encoding = 'gzip'; } catch (e) {} }
  if (text === null) text = buf.toString('utf8');
  // base64-wrapped gzip (e.g. LinkedIn "H4sI...")
  if (/^H4sI[A-Za-z0-9+/=]+$/.test(text.trim())) { try { text = zlib.gunzipSync(Buffer.from(text.trim(), 'base64'), LIMIT).toString('utf8'); encoding = 'base64+gzip'; } catch (e) {} }
  if (encoding === 'identity' && /[\x00-\x08\x0e-\x1f]/.test(text)) {
    for (const [n, f] of tries) { try { text = f(buf).toString('utf8'); encoding = n; break; } catch (e) {} }
  }
  return { raw: buf.length, text, encoding };
}

function parseParams(u) { const o = {}; for (const [k, v] of u.searchParams) { if (o[k] !== undefined) { o[k] = [].concat(o[k], v); } else o[k] = v; } return o; }
function tryJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function formParse(s) { try { const o = {}; for (const [k, v] of new URLSearchParams(s)) o[k] = v; return o; } catch (e) { return null; } }

function describeEme(eme) {
  if (eme === undefined) return 'absent';
  if (eme === 'tv.1~') return 'empty envelope (tv.1~)';
  const m = /^tv\.1~emkid\.([0-9a-f-]+)~ev\.([A-Za-z0-9_-]+)$/.exec(eme);
  if (m) {
    const bytes = Buffer.from(m[2], 'base64url');
    return `encrypted: emkid=${m[1]}, ev=${bytes.length} bytes (first byte 0x${bytes[0].toString(16)}${bytes[0] === 4 ? ' = uncompressed EC point, i.e. an ephemeral public key prefix' : ''})`;
  }
  return 'other: ' + eme.slice(0, 60);
}

function extractFields(vendor, u, p, bodyText) {
  const f = {};
  const path_ = u.pathname;
  if (vendor === 'google') {
    const idm = /(\d{10,12})\/?$/.exec(path_);
    f.account = idm ? 'AW-' + idm[1] : null;
    f.endpoint = (u.hostname === 'openart.ai' ? 'openart.ai(gateway)' : u.hostname) + path_.replace(/\d{10,12}\/?$/, '<id>');
    for (const k of ['label', 'en', 'value', 'currency_code', 'oid', 'oidsrc', 'bttype', 'ec_mode', 'emd', 'em', 'ecsid', 'ecsid2', 'aecs', 'gcd', 'gcs', 'dma', 'npa', 'cv', 'gtm', 'fmt', 'mt', 'ept', 'evjid', 'gclid', 'gbraid', 'wbraid', 'data']) if (p[k] !== undefined) f[k] = p[k];
    f.eme = describeEme(p.eme);
    if (p.eme) f.eme_raw = p.eme;
    if (bodyText) f.body = bodyText.slice(0, 500);
  } else if (vendor === 'tiktok') {
    f.endpoint = u.hostname + path_;
    const j = tryJSON(bodyText || '');
    if (j) {
      if (j.metric_name) { // monitor/diagnostic beacon
        f.kind = 'monitor/diagnostic'; f.custom_name = j.custom_name; f.custom_enum = j.custom_enum;
        f.message = j.ext_json && j.ext_json.message;
      } else {
        f.kind = 'pixel event'; f.event = j.event; f.event_id = j.event_id;
        f.properties = j.properties;
        const us = (j.context && j.context.user) || {};
        f.user_email = us.email || null; f.user_eb_email = us.eb_email || null;
        f.user_acp = us.acp || null;
        f.dynamic_parameter_config = j._inspection && j._inspection.dynamic_parameter_config;
        f.trigger_source = j._inspection && j._inspection.trigger_source;
        f.email_is_hashed_diag = j._inspection && j._inspection.identity_params && j._inspection.identity_params.email_is_hashed;
      }
    }
  } else if (vendor === 'x') {
    f.endpoint = u.hostname + path_;
    for (const k of ['txn_id', 'event', 'events', 'email_address', 'event_id', 'integration', 'p_user_id', 'tw_sale_amount', 'tw_order_quantity']) if (p[k] !== undefined) f[k] = p[k];
  } else if (vendor === 'reddit') {
    f.endpoint = u.hostname + path_;
    const q = Object.assign({}, p, formParse(bodyText || '') || {});
    for (const k of ['event', 'm.value', 'm.valueDecimal', 'm.currency', 'm.transactionId', 'm.orderId', 'm.conversionId', 'm.itemCount', 'm.products', 'em', 'external_id', 'integration', 'partner_version', 'mthd']) if (q[k] !== undefined && q[k] !== '') f[k] = q[k];
  } else if (vendor === 'linkedin') {
    f.endpoint = u.hostname + path_;
    for (const k of ['pid', 'conversionId', 'eventId', 'tm', 'url']) if (p[k] !== undefined) f[k] = p[k];
    if (bodyText) { const j = tryJSON(bodyText); f.body = j || bodyText.slice(0, 400); }
  } else if (vendor === 'microsoft_uet') {
    f.endpoint = u.hostname + path_;
    for (const k of ['ti', 'evt', 'ea', 'el', 'ec', 'ev', 'gv', 'gc', 'transaction_id', 'pid', 'em']) if (p[k] !== undefined) f[k] = p[k];
    if (bodyText) f.body = bodyText.slice(0, 300);
  } else {
    f.endpoint = u.hostname + path_;
    if (bodyText) f.body = bodyText.slice(0, 200);
  }
  return f;
}

function classifyProxyTarget(t) {
  const host = t.replace(/^https?:\/\//, '').split(/[/:]/)[0];
  if (host === 'example.com') return 'seal probe (WebSocket handshake / navigation preconnect; bypasses CDP by design)';
  if (/^(mtalk|android\.clients|clients\d?|update|accounts|edgedl\.me|www\.gstatic|optimizationguide-pa|safebrowsing|content-autofill)\./.test(host) || /googleapis\.com$|gvt1\.com$/.test(host)) return 'Chrome-internal service (GCM / component updater / sync infra)';
  if (/gvt2\.com$/.test(host)) return 'Chrome-internal: Domain Reliability monitor upload (browser process; invisible to CDP)';
  if (host === 'www.google.com') return 'Google host: Chrome-internal (follows a blocked navigation), no ad path visible at CONNECT level';
  return 'UNEXPECTED — escaped CDP interception (refused by proxy)';
}

// [watchdog] the original per-capture decode (was the body of decoded = sources.map(...))
function decodeCapture(c, i, markers) {
  const mk = markers || DEFAULT_MARKERS;
  let u; try { u = new URL(c.url); } catch (e) { return { i, url: c.url, vendor: 'unparseable' }; }
  const vendor = vendorOf(u);
  const p = parseParams(u);
  const body = decodeBody(c);
  let hay = c.url + '\n';
  try { hay += decodeURIComponent(c.url) + '\n'; } catch (e) {}
  if (body.text) { hay += body.text + '\n'; try { hay += decodeURIComponent(body.text); } catch (e) {} }
  const emailHits = Object.entries(mk.EMAIL_MARKERS).filter(([, m]) => hay.toLowerCase().includes(m.toLowerCase())).map(([k]) => k);
  const txnHits = Object.entries(mk.TXN_MARKERS).filter(([, m]) => hay.includes(m)).map(([k]) => k);
  const markerScenarios = Array.from(new Set(txnHits.map((k) => mk.TXN_SCENARIO[k.replace(/^sha256\((.*)\)$/, '$1')])));
  const fields = extractFields(vendor, u, p, body.text);
  return {
    i, t: c.t, iso: c.iso, windowScenario: c.scenario, markerScenarios, layer: c.layer, sess: c.sess,
    vendor, adVendor: AD_VENDORS.has(vendor), resourceType: c.resourceType, method: c.method,
    hostPath: u.hostname + u.pathname, failRequest: c.failRequest, bodyEncoding: body.encoding, bodyBytes: body.raw,
    emailHits, txnHits, fields, url: c.url,
    bodyText: body.text, // [watchdog] keep the decoded body for the watchdog's semantic decoders
  };
}

// [watchdog] analyze() without file I/O; opts.markers overrides the SEALTEST defaults
function analyzeRun(run, opts) {
  const markers = (opts && opts.markers) || DEFAULT_MARKERS;
  const sealIso = run.seal.startedAt;
  // --- sources: Fetch captures, plus (literal-method runs) requests blocked inside the renderer by Network.setBlockedURLs ---
  const netBlocked = run.net.filter((r) => r.phase === 'post' && r.blockedReason === 'inspector' && !run.captures.some((c) => c.networkId === r.requestId) && /^https?:/.test(r.url || ''))
    .map((r) => ({ t: r.t, iso: r.iso, scenario: r.scenario, layer: 'renderer-block(setBlockedURLs)', sess: r.sess, resourceType: r.type, method: r.method, url: r.url, postData: r.postData, postDataEntriesB64: null, failRequest: 'n/a (blocked before Fetch)' }));
  const sources = run.captures.concat(netBlocked);
  // --- decode every captured request (the authoritative list of what would have left the browser) ---
  const decoded = sources.map((c, i) => decodeCapture(c, i, markers));

  // --- leak accounting: every post-seal network record must end blocked / non-network ---
  const capByNet = new Map(run.captures.filter((c) => c.networkId).map((c) => [c.networkId, c]));
  const post = run.net.filter((r) => r.phase === 'post');
  const pausedPreflights = run.captures.filter((c) => c.method === 'OPTIONS');
  const accounting = post.map((r) => {
    const scheme = (r.url || '').split(':')[0];
    const cap = capByNet.get(r.requestId);
    let outcome;
    if (cap) outcome = 'Fetch.requestPaused -> Fetch.failRequest(BlockedByClient): ' + cap.failRequest;
    else if (['data', 'blob', 'about', 'chrome-extension'].includes(scheme)) outcome = 'non-network scheme (' + scheme + ')';
    else if (/^WebSocket/.test(r.type || '')) outcome = 'WebSocket (not a Fetch-interceptable request; see proxy log)';
    else if (r.blockedReason && pausedPreflights.some((c) => c.url === r.url && Math.abs(c.t - r.t) < 100)) outcome = 'never sent: its CORS preflight (OPTIONS) was paused+failed by Fetch';
    else if (r.blockedReason) outcome = 'blocked in renderer (' + r.blockedReason + ')';
    else if (r.failed) outcome = 'failed: ' + r.failed;
    else if (r.servedFromCache) outcome = 'served from memory cache (no network)';
    else outcome = 'UNACCOUNTED';
    const gotResponse = !!(r.responseAfterSeal && !cap && !['data', 'blob'].includes(scheme));
    return { t: r.t, scenario: r.scenario, sess: r.sess, type: r.type, method: r.method, url: (r.url || '').slice(0, 160), outcome, gotNetworkResponse: gotResponse };
  });
  const unaccounted = accounting.filter((a) => a.outcome === 'UNACCOUNTED' || a.gotNetworkResponse);
  const failErrors = run.captures.filter((c) => c.failRequest !== 'ok');
  const proxyPost = (run.proxy.log || []).filter((e) => e.t >= Date.parse(run.proxy.sealedAt));
  const proxyClass = proxyPost.map((e) => ({ iso: e.iso, kind: e.kind, target: e.target, action: e.action, class: classifyProxyTarget(e.target) }));

  // --- attribution consistency: marker scenario vs time window ---
  const attribution = decoded.filter((d) => d.markerScenarios.length).map((d) => ({ i: d.i, vendor: d.vendor, hostPath: d.hostPath, window: d.windowScenario, marker: d.markerScenarios, agree: d.markerScenarios.includes(d.windowScenario) }));

  const summary = {
    run: run.meta.outFile ? path.basename(run.meta.outFile) : run.meta.runName, page: run.meta.pageUrl, chrome: run.meta.chromeVersion, set: run.meta.setName, blockedMode: run.meta.blockedMode,
    sealAt: sealIso, captures: run.captures.length, postSealNetRecords: post.length,
    unaccounted: unaccounted.length, failRequestErrors: failErrors.length,
    proxy: { postSealAttempts: run.proxy.postSealAttempts, postSealAllowed: run.proxy.postSealAllowed, tunnelsDestroyedAtSeal: run.proxy.tunnelsDestroyedAtSeal, bytesDroppedUpstreamAfterSeal: run.proxy.bytesDroppedUpstreamAfterSeal },
    teardown: run.teardown, readiness: run.readiness, wrap: run.wrap, versions: run.versions,
  };
  return { summary, decoded, accounting, unaccounted, failErrors: failErrors.map((c) => ({ url: c.url, err: c.failRequest })), proxyPostSeal: proxyClass, attribution, jsTrace: run.jsTrace, timeline: run.timeline, sealProbes: run.sealProbes, markers: { EMAIL_MARKERS: markers.EMAIL_MARKERS, TXN_MARKERS: markers.TXN_MARKERS } };
}

function analyze(runFile, opts) {
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const out = analyzeRun(run, opts);
  out.summary.run = path.basename(runFile);
  const outFile = path.join(path.dirname(runFile), 'decoded_' + path.basename(runFile).replace(/^run_/, ''));
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  return { outFile, out };
}

if (require.main === module) {
  for (const f of process.argv.slice(2)) {
    const { outFile, out } = analyze(path.resolve(f));
    console.log('wrote', outFile);
    console.log(JSON.stringify({ summary: Object.assign({}, out.summary, { versions: undefined, readiness: undefined, wrap: undefined }), unaccounted: out.unaccounted, failErrors: out.failErrors, proxyPostSeal: out.proxyPostSeal, attributionDisagreements: out.attribution.filter((a) => !a.agree) }, null, 1));
  }
}
module.exports = {
  analyze, analyzeRun, decodeCapture, buildMarkers, EMAIL_MARKERS, TXN_MARKERS, TXN_SCENARIO, vendorOf, AD_VENDORS,
  decodeBody, parseParams, tryJSON, formParse, describeEme, extractFields, classifyProxyTarget,
};
