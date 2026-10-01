// The single Fetch.requestPaused handler used by every watchdog browser (journeys, consent probes,
// pilot, and the replay's pre-seal page load via the legacy harness's preSeal hook).
//
// Request stage : optional uBlock simulation ($removeparam redirect / block), then the collection-
//                 seal policy (src/policy/policy.ts): an allowed FIRST-party request continues through
//                 the proxy tunnel; an allowed THIRD-party request is fetched by the watchdog
//                 (src/browser/nodefetch.ts) and fulfilled — Google loaders from
//                 www.googletagmanager.com are recorded/patched on that path; everything else is
//                 Fetch.failRequest(BlockedByClient).
// Response stage: only for patterns we register — first-party documents (inject-script, edge-sim)
//                 and the first-party gateway loader /4vu8/ (patched container/config, geo rewrite,
//                 body hashing).
// Every paused request is resolved exactly once and recorded; a handler error fails the request.
import type { CDPSession, Protocol } from 'puppeteer-core';
import { createHash } from 'node:crypto';
import { decide, type PolicyContext } from '../policy/policy.js';
import { injectIntoHtml, runEdgeSim, transformGoogleScript, type EdgeSimModule, type PatchSource } from '../patches/patches.js';
import { parseContainerScript } from '../container/parse.js';
import { uboTypeOf, type UboEngine } from '../ubo/engine.js';
import type { CapturedRequest } from '../types.js';
import { nodeFetchGet, ThirdPartyCache, type FetchedResponse } from './nodefetch.js';

export interface PatchSet {
  container?: PatchSource;
  gtagConfig?: PatchSource;
  injectScript?: { path: string; text: string; sha256: string };
  edgeSim?: { path: string; module: EdgeSimModule };
  geo?: { country: string; region: string };
}

export interface LoaderRecord {
  url: string;
  step: string;
  kind: string;
  containerId: string | null;
  version: string | null;
  resourceSha256Live: string | null;
  resourceSha256Served: string | null;
  bodySha256Served: string;
  notes: string[];
}

export interface PatchEvent {
  step: string;
  url: string;
  what: 'inject-script' | 'edge-sim' | 'container' | 'gtag-config' | 'geo' | 'ubo-removeparam';
  detail: string;
}

export interface InterceptState {
  requests: CapturedRequest[];
  loaders: LoaderRecord[];
  patchEvents: PatchEvent[];
  errors: string[];
  /** Current journey step label (set by the harness). */
  step: string;
  /** Top-level URL (uBO source URL). */
  topUrl: string;
  mainFrameIds: Set<string>;
  seq: number;
  t0: number;
  /** Requests the page cancelled while paused (e.g. aborted media range requests): nothing left to resolve. */
  cancelled: number;
}

export interface InterceptOptions {
  policy: PolicyContext;
  patches: PatchSet;
  ubo?: UboEngine;
  /** Hosts whose documents get inject-script / edge-sim (openart.ai in production). */
  isPatchHost: (host: string) => boolean;
  /** Extra request headers passed to edge-sim (e.g. cf-ipcountry). */
  edgeHeaders?: Record<string, string>;
  /** Cookie header provider for edge-sim (Fetch request headers omit cookies). */
  cookieHeader?: (url: string) => Promise<string>;
  /** Third-party transport (tests inject a stub); default: nodeFetchGet. */
  thirdPartyFetch?: (url: string, headers: Record<string, string>) => Promise<FetchedResponse>;
}

export function newInterceptState(): InterceptState {
  return { requests: [], loaders: [], patchEvents: [], errors: [], step: 'init', topUrl: 'about:blank', mainFrameIds: new Set(), seq: 0, t0: Date.now(), cancelled: 0 };
}

/** Fetch.enable patterns: every request at Request stage + the responses we may transform. */
export function fetchPatterns(opts: { patches: PatchSet; captureLoaders: boolean }): Protocol.Fetch.RequestPattern[] {
  const p: Protocol.Fetch.RequestPattern[] = [{ urlPattern: '*', requestStage: 'Request' }];
  if (opts.patches.injectScript || opts.patches.edgeSim) p.push({ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' });
  // (www.googletagmanager.com loaders are third-party: fetched and patched at the request stage.)
  if (opts.patches.container || opts.patches.gtagConfig || opts.patches.geo || opts.captureLoaders) {
    p.push({ urlPattern: '*://openart.ai/4vu8/*', resourceType: 'Script', requestStage: 'Response' });
  }
  return p;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const isGoogleLoader = (u: URL) => (u.hostname === 'www.googletagmanager.com' && /^\/(gtm\.js|gtag\/js)$/.test(u.pathname)) || (u.hostname === 'openart.ai' && /^\/4vu8\/(|[A-Za-z0-9_-]{20,})$/.test(u.pathname));

function headerValue(headers: Record<string, string> | Protocol.Fetch.HeaderEntry[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (Array.isArray(headers)) return headers.find((h) => h.name.toLowerCase() === name)?.value;
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return k ? headers[k] : undefined;
}

export function makePausedHandler(state: InterceptState, opts: InterceptOptions) {
  const recByInterception = new Map<string, CapturedRequest>();
  const cache = new ThirdPartyCache();
  const thirdPartyFetch = opts.thirdPartyFetch ?? ((url: string, headers: Record<string, string>) => nodeFetchGet(url, headers));
  return async function onPaused(session: CDPSession, e: Protocol.Fetch.RequestPausedEvent, layer: string, label: string): Promise<void> {
    const isResponse = e.responseStatusCode !== undefined || e.responseErrorReason !== undefined;
    try {
      if (!isResponse) await onRequest(session, e, layer, label);
      else await onResponse(session, e, layer);
    } catch (err) {
      if (/Invalid InterceptionId/i.test((err as Error).message)) {
        // The page cancelled the request while it was paused (e.g. an aborted media range request):
        // it no longer exists, so it can neither be continued nor sent.
        state.cancelled++;
        const rec = recByInterception.get(e.requestId);
        if (rec && !isResponse) {
          rec.action = 'fail';
          rec.failResult = 'cancelled-by-page';
        }
        return;
      }
      state.errors.push(`${isResponse ? 'response' : 'request'} handler: ${(err as Error).message} (${e.request.url.slice(0, 120)})`);
      try {
        if (isResponse) await session.send('Fetch.continueRequest', { requestId: e.requestId });
        else await session.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
      } catch {
        /* target gone: the request dies with it */
      }
    }
  };

  async function onRequest(session: CDPSession, e: Protocol.Fetch.RequestPausedEvent, layer: string, label: string) {
    const q = e.request;
    const isNavigation = e.resourceType === 'Document';
    const isMain = isNavigation && !!e.frameId && state.mainFrameIds.has(e.frameId);
    const rec: CapturedRequest = {
      id: `${label}#${++state.seq}`,
      t: Date.now() - state.t0,
      step: state.step,
      url: q.url,
      method: q.method,
      resourceType: e.resourceType,
      postData: q.postData ?? null,
      postDataB64: Array.isArray(q.postDataEntries) ? q.postDataEntries.map((x) => x.bytes ?? '') : null,
      action: 'fail',
      collection: false,
      layer,
      frameId: e.frameId ?? null,
      networkId: e.networkId ?? null,
      referer: headerValue(q.headers, 'referer') ?? null,
    };
    state.requests.push(rec);
    recByInterception.set(e.requestId, rec);

    // 1. uBlock Origin simulation (ubo_blocked journey only)
    if (opts.ubo) {
      if (isNavigation) {
        const rp = opts.ubo.removeParams(q.url, isMain ? q.url : state.topUrl, isMain ? 'document' : 'subdocument');
        if (rp.removed.length) {
          await session.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 302, responseHeaders: [{ name: 'Location', value: rp.url }, { name: 'Cache-Control', value: 'no-store' }], body: '' });
          rec.action = 'redirect';
          rec.reason = `ubo:removeparam ${rp.removed.join(',')}`;
          state.patchEvents.push({ step: state.step, url: q.url, what: 'ubo-removeparam', detail: `${rp.removed.join(', ')} stripped by ${rp.filters.join(' | ')}` });
          return;
        }
      }
      const m = opts.ubo.match({ url: q.url, type: uboTypeOf(e.resourceType, isMain), sourceUrl: isMain ? q.url : state.topUrl, method: q.method });
      if (m.blocked) {
        const d = decide({ url: q.url, method: q.method, resourceType: e.resourceType, headers: q.headers, isNavigation }, opts.policy);
        await fail(session, e, rec);
        rec.reason = `ubo:${m.filter}`;
        rec.collection = d.collection;
        rec.rule = d.rule;
        return;
      }
    }

    // 2. the collection seal
    const d = decide({ url: q.url, method: q.method, resourceType: e.resourceType, headers: q.headers, isNavigation }, opts.policy);
    rec.reason = d.reason;
    rec.collection = d.collection;
    rec.rule = d.rule;
    if (d.action === 'fail') {
      await fail(session, e, rec);
      return;
    }
    if (isMain) state.topUrl = q.url;
    if (d.transport === 'node') {
      await fulfilThirdParty(session, e, rec);
      return;
    }
    await session.send('Fetch.continueRequest', { requestId: e.requestId });
    rec.action = 'allow';
    rec.via = 'tunnel';
  }

  /** Third-party GET: fetched by the watchdog (no browser route to the host exists), then fulfilled. */
  async function fulfilThirdParty(session: CDPSession, e: Protocol.Fetch.RequestPausedEvent, rec: CapturedRequest) {
    const url = e.request.url;
    let r = cache.get(url);
    rec.fromCache = !!r;
    if (!r) {
      try {
        r = await thirdPartyFetch(url, e.request.headers as Record<string, string>);
      } catch (err) {
        rec.reason = `${rec.reason} (third-party fetch failed: ${(err as Error).message.slice(0, 120)})`;
        rec.action = 'fail';
        await session.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' });
        rec.failResult = 'ok';
        return;
      }
      cache.put(url, e.resourceType, r);
    }
    let body: Buffer = r.body;
    if (e.resourceType === 'Script' && r.status >= 200 && r.status < 300 && isGoogleLoader(new URL(url))) {
      const t = transformLoader(url, body.toString('utf8'));
      if (t.changed) body = Buffer.from(t.body, 'utf8');
    }
    await session.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: r.status, responseHeaders: r.headers, body: body.toString('base64') });
    rec.action = 'allow';
    rec.via = 'node';
    rec.status = r.status;
  }

  /** Record a Google loader body (live resource hash) and apply the patch set; used by both transports. */
  function transformLoader(url: string, body: string): { body: string; changed: boolean } {
    const live = parseContainerScript(body);
    const t = transformGoogleScript(body, { container: opts.patches.container, gtagConfig: opts.patches.gtagConfig, geo: opts.patches.geo });
    state.loaders.push({
      url, step: state.step, kind: t.kind, containerId: live?.containerId ?? null, version: live?.version ?? null,
      resourceSha256Live: t.resourceSha256Before, resourceSha256Served: t.resourceSha256After, bodySha256Served: sha256(t.body), notes: t.notes,
    });
    for (const n of t.notes) state.patchEvents.push({ step: state.step, url, what: n.startsWith('geo') ? 'geo' : t.kind === 'config' ? 'gtag-config' : 'container', detail: n });
    return { body: t.body, changed: t.changed };
  }

  async function fail(session: CDPSession, e: Protocol.Fetch.RequestPausedEvent, rec: CapturedRequest) {
    rec.action = 'fail';
    try {
      await session.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
      rec.failResult = 'ok';
    } catch (err) {
      rec.failResult = 'err: ' + (err as Error).message;
    }
  }

  async function onResponse(session: CDPSession, e: Protocol.Fetch.RequestPausedEvent, layer: string) {
    const url = new URL(e.request.url);
    const status = e.responseStatusCode ?? 0;
    // Only the target layer transforms; the browser layer passes responses through untouched.
    if (layer !== 'fetch-target' || e.responseErrorReason) {
      await session.send('Fetch.continueRequest', { requestId: e.requestId });
      return;
    }
    const headers = (e.responseHeaders ?? []).slice();
    if (e.resourceType === 'Document' && opts.isPatchHost(url.hostname)) {
      const extraCookies: string[] = [];
      if (opts.patches.edgeSim) {
        const reqHeaders: Record<string, string> = { ...(e.request.headers as Record<string, string>), ...(opts.edgeHeaders ?? {}) };
        if (opts.cookieHeader) {
          const c = await opts.cookieHeader(e.request.url);
          if (c) reqHeaders.cookie = c;
        }
        const r = await runEdgeSim(opts.patches.edgeSim.module, e.request.url, reqHeaders, 2500, { country: opts.patches.geo?.country ?? 'US' });
        extraCookies.push(...r.setCookies);
        if (r.setCookies.length) state.patchEvents.push({ step: state.step, url: e.request.url, what: 'edge-sim', detail: r.setCookies.map((c) => c.split(';')[0]).join(' | ') });
        for (const rj of r.rejected) state.errors.push(`edge-sim cookie rejected (${rj.reason}): ${rj.line}`);
      }
      const isHtml = /text\/html/i.test(headerValue(headers, 'content-type') ?? '') && status >= 200 && status < 300;
      if (isHtml && opts.patches.injectScript) {
        const b = await session.send('Fetch.getResponseBody', { requestId: e.requestId });
        const html = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        const r = injectIntoHtml(html, opts.patches.injectScript.text, opts.patches.injectScript.sha256);
        if (r.injected) state.patchEvents.push({ step: state.step, url: e.request.url, what: 'inject-script', detail: `inserted at ${r.position} (${opts.patches.injectScript.sha256.slice(0, 12)})` });
        await fulfill(session, e, status, headers, extraCookies, r.html);
        return;
      }
      if (extraCookies.length) {
        if (status >= 300 && status < 400) await fulfill(session, e, status, headers, extraCookies, '');
        else {
          const b = await session.send('Fetch.getResponseBody', { requestId: e.requestId });
          await fulfill(session, e, status, headers, extraCookies, b.base64Encoded ? Buffer.from(b.body, 'base64') : b.body);
        }
        return;
      }
      await session.send('Fetch.continueRequest', { requestId: e.requestId });
      return;
    }
    if (e.resourceType === 'Script' && isGoogleLoader(url) && status >= 200 && status < 300) {
      const b = await session.send('Fetch.getResponseBody', { requestId: e.requestId });
      const body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
      const t = transformLoader(e.request.url, body);
      if (t.changed) await fulfill(session, e, status, headers, [], t.body);
      else await session.send('Fetch.continueRequest', { requestId: e.requestId });
      return;
    }
    await session.send('Fetch.continueRequest', { requestId: e.requestId });
  }

  async function fulfill(session: CDPSession, e: Protocol.Fetch.RequestPausedEvent, status: number, headers: Protocol.Fetch.HeaderEntry[], extraCookies: string[], body: string | Buffer) {
    const kept = headers.filter((h) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(h.name));
    for (const c of extraCookies) kept.push({ name: 'Set-Cookie', value: c });
    await session.send('Fetch.fulfillRequest', {
      requestId: e.requestId,
      responseCode: status,
      responseHeaders: kept,
      body: Buffer.isBuffer(body) ? body.toString('base64') : Buffer.from(body, 'utf8').toString('base64'),
    });
  }
}
