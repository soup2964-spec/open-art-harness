// Semantic decoding of attempted collection requests into platform events.
// Byte-level decoding (gzip / base64-gzip bodies, query parsing, the Google EC envelope) reuses the
// proven legacy decoder (src/legacy/decode.cjs); this module adds what the watchdog needs on top:
// event kind (page view / conversion / ...), transport de-duplication keys, dedicated click-ID
// fields and consent signals. Field names are the ones observed on the wire in the saved captures
// (crawl/sealed_evidence/run_*.json, crawl/teardown2/T*.json).
import { decodeBody, describeEme, vendorOf as legacyVendorOf } from '../legacy/decode.cjs';
import type { CapturedRequest, DecodedHit, HitKind, Platform } from '../types.js';
import { decodeConsent } from '../consent/gcd.js';
import { classifyCollection } from '../policy/policy.js';

const META_CONVERSIONS = new Set(['Purchase', 'CompleteRegistration', 'Lead', 'Subscribe', 'StartTrial', 'InitiateCheckout', 'AddPaymentInfo', 'AddToCart', 'Contact', 'SubmitApplication', 'Schedule']);
const TIKTOK_CONVERSIONS = new Set(['CompleteRegistration', 'Purchase', 'CompletePayment', 'Subscribe', 'PlaceAnOrder', 'SubmitForm', 'Contact', 'InitiateCheckout', 'AddPaymentInfo', 'AddToCart', 'StartTrial', 'Lead']);

export const CLICK_ID_FIELDS: Record<string, string[]> = {
  google_ads: ['gclid', 'gclaw', 'gbraid', 'wbraid', 'gclgb', 'gclgs', 'gclag'],
  meta: ['fbc', 'fbcs', 'fb.clickID'],
  tiktok: ['context.ad.callback'],
  reddit: ['click_id'],
  linkedin: ['li_fat_id'],
  x: ['twclid'],
  microsoft_uet: ['msclkid'],
  openai_ads: ['oppref'],
  amplitude: [],
};

function params(u: URL): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (o[k] === undefined) o[k] = v;
  return o;
}
function form(s: string | null | undefined): Record<string, string> {
  if (!s || /^\s*[[{]/.test(s)) return {};
  try {
    const o: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(s)) if (o[k] === undefined) o[k] = v;
    return o;
  } catch {
    return {};
  }
}
function json(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function nonEmpty(o: Record<string, unknown>, keys: string[]): Record<string, string> {
  const r: Record<string, string> = {};
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v) !== '' && String(v) !== 'N') r[k] = String(v);
  }
  return r;
}

export function platformOf(u: URL): Platform {
  const c = classifyCollection(u, 'GET', 'Other');
  const p = c?.platform;
  if (p === 'google_ads' || p === 'ga4' || p === 'meta' || p === 'tiktok' || p === 'reddit' || p === 'linkedin' || p === 'x' || p === 'microsoft_uet' || p === 'openai_ads' || p === 'amplitude') return p;
  return 'other';
}

function base(r: CapturedRequest, u: URL, platform: Platform, kind: HitKind, dedupeKey: string): DecodedHit {
  return {
    requestId: r.id,
    step: r.step,
    t: r.t,
    platform,
    vendor: legacyVendorOf(u),
    endpoint: u.hostname + u.pathname.replace(/\d{9,12}/g, '<id>'),
    transport: `${r.resourceType} ${r.method}`,
    kind,
    dedupeKey,
    clickIds: {},
    fields: {},
  };
}

/** Google measurement bodies can batch several events, one URL-encoded line each (GA4 /g/collect). */
function googleEventLines(body: string | null): Array<Record<string, string>> {
  if (!body || /^\s*[[{]/.test(body)) return [];
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => form(l));
  return lines.length > 1 || (lines.length === 1 && lines[0]!.en) ? lines.filter((l) => Object.keys(l).length) : [];
}

function decodeGoogle(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const lines = /\/(g|ccm)\/collect/.test(u.pathname) ? googleEventLines(body) : [];
  if (lines.length) return lines.flatMap((line, i) => decodeGoogleEvent(r, u, { ...params(u), ...line }, i));
  return decodeGoogleEvent(r, u, { ...params(u), ...form(body) }, 0);
}

function decodeGoogleEvent(r: CapturedRequest, u: URL, q: Record<string, string>, lineNo: number): DecodedHit[] {
  const path = u.pathname;
  const acct = /\/(\d{9,12})\/?$/.exec(path)?.[1] ?? /\/(\d{9,12})(?:\/|$)/.exec(path)?.[1];
  // one request can carry several destinations (tids=AW-1~G-2): one hit per destination
  const streams = q.tid ? [q.tid] : q.tids ? q.tids.split('~').filter(Boolean) : acct ? [`AW-${acct}`] : ['google-tag'];
  return streams.map((stream) => decodeGoogleStream(r, u, q, stream, lineNo));
}

function decodeGoogleStream(r: CapturedRequest, u: URL, q: Record<string, string>, stream: string, lineNo: number): DecodedHit {
  const path = u.pathname;
  const en = q.en;
  let kind: HitKind = 'other';
  if (/\/ccm\/s\/collect/.test(path) || /set_partitioned_cookie/.test(path)) kind = 'sync';
  else if (/(pagead\/conversion\/|pagead\/1p-conversion\/|\/as\/p\/c\/|ccm\/conversion\/)/.test(path)) kind = 'conversion';
  else if (/ccm\/form-data/.test(path)) kind = 'conversion_user_data';
  else if (/\/ccm\/collect/.test(path) || /\/g\/collect/.test(path)) kind = en === 'page_view' ? 'page_view' : en === 'conversion' ? 'conversion' : 'event';
  else if (/rmkt\/collect|viewthroughconversion|1p-user-list/.test(path)) kind = !en || en === 'gtag.config' ? 'remarketing' : en === 'page_view' ? 'remarketing' : 'event';
  else if (/^\/4vu8\/a$/.test(path) || /\/td$/.test(path)) kind = 'diagnostic';
  const volatile = (q.random || q.rnd || q.fst || '') + (lineNo ? `#${lineNo}|${q._s || ''}|${q._et || ''}` : '');
  let dedupeKey: string;
  if (kind === 'conversion' || kind === 'conversion_user_data') dedupeKey = `google|${kind}|${stream}|${q.label || ''}|${q.oid || ''}|${volatile}`;
  else dedupeKey = `google|${kind}|${stream}|${en || ''}|${q.dl || q.url || ''}|${volatile}`;
  const hit = base(r, u, stream.startsWith('G-') ? 'ga4' : 'google_ads', kind, dedupeKey);
  hit.stream = stream;
  hit.eventName = en || (kind === 'conversion' ? 'conversion' : undefined);
  hit.pageUrl = q.dl || q.url || undefined;
  hit.clickIds = nonEmpty(q, CLICK_ID_FIELDS.google_ads!);
  hit.fields = {
    en, tid: q.tid, label: q.label, value: q.value, currency_code: q.currency_code, oid: q.oid, oidsrc: q.oidsrc, bttype: q.bttype,
    ec_mode: q.ec_mode, emd: q.emd, em: q.em, eme: q.eme !== undefined ? describeEme(q.eme) : undefined, ecsid: q.ecsid, dl: q.dl, url: q.url,
  };
  hit.consent = decodeConsent({ gcd: q.gcd, gcs: q.gcs, dma: q.dma, npa: q.npa });
  return hit;
}

function decodeMetaPixel(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const q = { ...params(u), ...form(body) };
  const ev = q.ev;
  if (!ev) return [base(r, u, 'meta', 'other', `meta|other|${r.id}`)];
  const kind: HitKind = ev === 'PageView' ? 'page_view' : META_CONVERSIONS.has(ev) ? 'conversion' : 'event';
  // eid when present; otherwise ts (event time) + ec (event counter) — "it" is constant per page load
  const hit = base(r, u, 'meta', kind, `meta|${q.eid || (q.ts || q.ec ? `${ev}|${q.ts || ''}|${q.ec || ''}` : `${ev}|${r.id}`)}`);
  hit.eventName = ev;
  hit.pageUrl = q.dl;
  hit.clickIds = nonEmpty(q, ['fbc', 'fbcs']);
  const cd: Record<string, string> = {};
  for (const k of Object.keys(q)) if (k.startsWith('cd[')) cd[k.slice(3, -1)] = q[k]!;
  hit.fields = { id: q.id, ev, eid: q.eid, fbc: q.fbc, fbp: q.fbp, rl: q.rl, cd, ud: Object.keys(q).filter((k) => k.startsWith('ud[')) };
  return [hit];
}

function decodeMetaCapig(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const j = json(body);
  const list: any[] = (Array.isArray(j) ? j : j ? [j] : []).filter((b) => b && typeof b === 'object');
  if (!list.length) return [base(r, u, 'meta', 'other', `meta|capig|${r.id}`)];
  return list.map((b, i) => {
    const ev = b.event_name;
    const kind: HitKind = ev === 'PageView' ? 'page_view' : META_CONVERSIONS.has(ev) ? 'conversion' : 'event';
    const hit = base(r, u, 'meta', kind, `meta|${b.event_id || `${ev}|${r.id}|${i}`}`);
    hit.transport = 'CAPI Gateway ' + r.method;
    hit.eventName = ev;
    hit.pageUrl = b.website_context?.location;
    hit.clickIds = nonEmpty({ 'fb.clickID': b['fb.clickID'] }, ['fb.clickID']);
    hit.fields = { event_name: ev, event_id: b.event_id, clickID: b['fb.clickID'], fbp: b['fb.fbp'], custom_data: b.custom_data, conversion_value: b.conversion_value };
    return hit;
  });
}

function decodeTikTok(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const parsed = json(body);
  // batch bodies: a JSON array, or {batch: [...]}
  const batch: any[] | null = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.batch) ? parsed.batch : null;
  if (batch) {
    const items = batch.filter((x) => x && typeof x === 'object');
    if (!items.length) return [base(r, u, 'tiktok', 'other', `tiktok|other|${r.id}`)];
    return items.flatMap((item, i) => decodeTikTokEvent(r, u, item, i));
  }
  return decodeTikTokEvent(r, u, parsed, 0);
}

function decodeTikTokEvent(r: CapturedRequest, u: URL, j: any, i: number): DecodedHit[] {
  if (/\/monitor$/.test(u.pathname) || (j && j.metric_name)) {
    const hit = base(r, u, 'tiktok', 'diagnostic', `tiktok|monitor|${r.id}`);
    hit.fields = { custom_name: j?.custom_name, custom_enum: j?.custom_enum, message: j?.ext_json?.message };
    return [hit];
  }
  if (!j) return [base(r, u, 'tiktok', 'other', `tiktok|other|${r.id}`)];
  const ev: string = j.event;
  let kind: HitKind = 'event';
  if (/ipv6/.test(u.hostname + u.pathname) || /^Enrich/.test(ev || '')) kind = 'enrich';
  else if (ev === 'Pageview') kind = 'page_view';
  else if (TIKTOK_CONVERSIONS.has(ev)) kind = 'conversion';
  const hit = base(r, u, 'tiktok', kind, `tiktok|${String(j.message_id || '').replace(/#.*$/, '') || `${ev}|${j.event_id}|${j.timestamp}|${i}`}|${kind}`);
  hit.eventName = ev;
  hit.pageUrl = j.context?.page?.url;
  hit.clickIds = nonEmpty({ 'context.ad.callback': j.context?.ad?.callback }, ['context.ad.callback']);
  hit.fields = {
    event: ev, event_id: j.event_id, message_id: j.message_id, properties: j.properties, user_email: j.context?.user?.email ?? null,
    dynamic_parameter_config: j._inspection?.dynamic_parameter_config,
  };
  return [hit];
}

function decodeReddit(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const q = { ...params(u), ...form(body) };
  const ev = q.event;
  if (!ev) return [base(r, u, 'reddit', 'other', `reddit|other|${r.id}`)];
  const kind: HitKind = ev === 'PageVisit' ? 'page_view' : 'conversion';
  const hit = base(r, u, 'reddit', kind, `reddit|${ev}|${q.ts || ''}|${q.uuid || ''}`);
  hit.eventName = ev;
  hit.pageUrl = q.esurl;
  hit.clickIds = nonEmpty(q, ['click_id']);
  const m: Record<string, string> = {};
  for (const k of Object.keys(q)) if (k.startsWith('m.') && q[k] !== '') m[k] = q[k]!;
  hit.fields = { event: ev, em: q.em || undefined, ...m };
  return [hit];
}

function decodeLinkedIn(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const q = { ...params(u), ...form(body) };
  if (/\/wa\/?$/.test(u.pathname)) {
    const j = json(body);
    const hit = base(r, u, 'linkedin', 'event', `linkedin|wa|${r.id}`);
    hit.eventName = j?.signalType ? String(j.signalType) : 'web-analytics';
    hit.fields = { signalType: j?.signalType };
    return [hit];
  }
  if (/li_sync/.test(u.pathname)) return [base(r, u, 'linkedin', 'sync', `linkedin|sync|${r.id}`)];
  if (/insight_tag_errors/.test(u.pathname)) return [base(r, u, 'linkedin', 'diagnostic', `linkedin|diag|${r.id}`)];
  const conversion = q.conversionId;
  const kind: HitKind = conversion ? 'conversion' : q.liSync ? 'sync' : 'page_view';
  const hit = base(r, u, 'linkedin', kind, `linkedin|${conversion || kind}|${q.time || r.id}`);
  hit.eventName = conversion ? `conversion ${conversion}` : 'page_view';
  hit.pageUrl = q.url;
  hit.clickIds = nonEmpty(q, ['li_fat_id']);
  // insight.beta.min.js maps conversion_value->val, conversion_currency->cur, event_id->eventId, order_id->oid
  hit.fields = { pid: q.pid, conversionId: conversion, eventId: q.eventId, val: q.val ?? q.value, cur: q.cur ?? q.currency, oid: q.oid, tm: q.tm };
  return [hit];
}

function decodeX(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const q = { ...params(u), ...form(body) };
  const txn = q.txn_id || '';
  const eventsRaw = q.events;
  let autoName: string | null = null;
  let autoPayload: any = null;
  if (eventsRaw) {
    const ev = json(eventsRaw);
    if (Array.isArray(ev) && Array.isArray(ev[0])) {
      autoName = String(ev[0][0]);
      autoPayload = ev[0][1];
    } else autoName = String(eventsRaw).slice(0, 60);
  }
  const eventJson = q.event !== undefined ? json(q.event) : null;
  let kind: HitKind;
  let name: string;
  if (/^tw-/.test(txn)) {
    kind = 'conversion';
    name = txn;
  } else if (autoName && /purchase/i.test(autoName)) {
    kind = 'auto_conversion';
    name = autoName;
  } else if (autoName) {
    kind = 'event';
    name = autoName;
  } else {
    kind = 'page_view';
    name = 'pageview';
  }
  const hit = base(r, u, 'x', kind, `x|${q.event_id || `${txn}|${eventsRaw}|${r.id}`}`);
  hit.eventName = name;
  hit.stream = txn || undefined;
  hit.pageUrl = q.tw_document_href;
  hit.clickIds = nonEmpty(q, ['twclid']);
  hit.fields = {
    txn_id: txn, event_id: q.event_id, event: eventJson ?? q.event, events: autoPayload ?? eventsRaw,
    conversion_id: eventJson?.conversion_id ?? autoPayload?.conversion_id, order_id: autoPayload?.order_id ?? eventJson?.order_id,
    value: eventJson?.value ?? autoPayload?.value, currency: eventJson?.currency ?? autoPayload?.currency, email_address: q.email_address,
  };
  return [hit];
}

function decodeUet(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const q = { ...params(u), ...form(body) };
  if (u.hostname === 'c.bing.com') return [base(r, u, 'microsoft_uet', 'sync', `uet|sync|${r.id}`)];
  if (!/^\/action/.test(u.pathname)) {
    const hit = base(r, u, 'microsoft_uet', 'event', `uet|insights|${r.id}`);
    hit.eventName = 'insights';
    return [hit];
  }
  const evt = q.evt;
  const kind: HitKind = evt === 'pageLoad' ? 'page_view' : evt === 'custom' ? (/purchase|subscri|sign/i.test(q.ea || '') ? 'conversion' : 'event') : 'event';
  // /actionp/0 evt=pageHide re-uses the mid of the pageLoad it closes, so evt is part of the key.
  const hit = base(r, u, 'microsoft_uet', kind, `uet|${evt || ''}|${q.mid || r.id}`);
  hit.eventName = evt === 'custom' ? `custom:${q.ea || ''}` : evt;
  hit.pageUrl = q.p;
  hit.clickIds = nonEmpty(q, ['msclkid']);
  hit.fields = { ti: q.ti, evt, ea: q.ea, gv: q.gv, gc: q.gc, transaction_id: q.transaction_id, spa: q.spa };
  return [hit];
}

function decodeOpenAI(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const j = json(body);
  if (!j) return [base(r, u, 'openai_ads', 'other', `openai|other|${r.id}`)];
  const events: any[] = Array.isArray(j.events) ? j.events.filter((e: unknown) => e && typeof e === 'object') : [];
  const topOppref = j.oppref ?? null;
  if (!events.length) {
    const hit = base(r, u, 'openai_ads', 'event', `openai|${r.id}`);
    hit.clickIds = nonEmpty({ oppref: topOppref }, ['oppref']);
    return [hit];
  }
  return events.map((e, i) => {
    const type = String(e.type || '');
    const kind: HitKind = /diagnostic/.test(type) ? 'diagnostic' : /^(openai|oai)::/.test(type) ? 'event' : 'conversion';
    const hit = base(r, u, 'openai_ads', kind, `openai|${e.id || `${r.id}|${i}`}`);
    hit.eventName = type;
    hit.pageUrl = e.source_url;
    hit.clickIds = nonEmpty({ oppref: topOppref ?? e.oppref ?? e.data?.oppref }, ['oppref']);
    hit.fields = { type, event_id: e.event_id ?? e.data?.event_id, obref: j.obref };
    return hit;
  });
}

const AMP_CLICK_KEYS = ['gclid', 'fbclid', 'ttclid', 'msclkid', 'rdt_cid', 'li_fat_id', 'twclid', 'gbraid', 'wbraid', 'oppref'];
function decodeAmplitude(r: CapturedRequest, u: URL, body: string | null): DecodedHit[] {
  const j = json(body);
  const events: any[] = j && Array.isArray(j.events) ? j.events.filter((e: unknown) => e && typeof e === 'object') : [];
  if (!events.length) return [base(r, u, 'amplitude', 'other', `amp|${r.id}`)];
  return events.map((e, i) => {
    const type = String(e.event_type || '');
    const kind: HitKind = type === '[Amplitude] Page Viewed' ? 'page_view' : 'event';
    const hit = base(r, u, 'amplitude', kind, `amp|${e.insert_id || `${r.id}|${i}`}`);
    hit.eventName = type;
    hit.pageUrl = e.event_properties?.['[Amplitude] Page Location'];
    const ids: Record<string, string> = {};
    const up = e.user_properties || {};
    for (const k of AMP_CLICK_KEYS) {
      const so = up.$setOnce?.[`initial_${k}`];
      if (so && so !== 'EMPTY') ids[`$setOnce.initial_${k}`] = String(so);
      const s = up.$set?.[k];
      if (s && s !== 'EMPTY') ids[`$set.${k}`] = String(s);
      const ep = e.event_properties?.[k];
      if (ep) ids[`event_properties.${k}`] = String(ep);
    }
    hit.clickIds = ids;
    hit.fields = { event_type: type, device_id_present: !!e.device_id };
    return hit;
  });
}

/** Decode one attempted request into zero or more platform events (collection requests only). */
export function decodeRequest(r: CapturedRequest): DecodedHit[] {
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return [];
  }
  const col = classifyCollection(u, r.method, r.resourceType);
  if (!col) return [];
  const body = decodeBody({ postData: r.postData ?? null, postDataEntriesB64: r.postDataB64 ?? null }).text;
  switch (col.platform) {
    case 'google_ads':
    case 'ga4':
      return decodeGoogle(r, u, body);
    case 'meta':
      return /\.on\.aws$|\.run\.app$/.test(u.hostname) ? decodeMetaCapig(r, u, body) : decodeMetaPixel(r, u, body);
    case 'tiktok':
      return decodeTikTok(r, u, body);
    case 'reddit':
      return decodeReddit(r, u, body);
    case 'linkedin':
      return decodeLinkedIn(r, u, body);
    case 'x':
      return decodeX(r, u, body);
    case 'microsoft_uet':
      return decodeUet(r, u, body);
    case 'openai_ads':
      return decodeOpenAI(r, u, body);
    case 'amplitude':
      return decodeAmplitude(r, u, body);
    default: {
      const hit = base(r, u, 'other', 'other', `${col.platform}|${r.id}`);
      hit.vendor = String(col.platform);
      return [hit];
    }
  }
}

/** Decode every request; one malformed body never aborts the run (it becomes an 'other' hit). */
export function decodeAll(requests: CapturedRequest[]): DecodedHit[] {
  const out: DecodedHit[] = [];
  for (const r of requests) {
    try {
      out.push(...decodeRequest(r));
    } catch (e) {
      let u: URL | null = null;
      try {
        u = new URL(r.url);
      } catch {
        /* unparseable */
      }
      if (!u) continue;
      const hit = base(r, u, platformOf(u), 'other', `decode-error|${r.id}`);
      hit.fields = { decodeError: (e as Error).message };
      out.push(hit);
    }
  }
  return out;
}

/** Distinct events after collapsing transport copies. */
export function distinctEvents(hits: DecodedHit[]): DecodedHit[] {
  const seen = new Map<string, DecodedHit>();
  for (const h of hits) if (!seen.has(h.dedupeKey)) seen.set(h.dedupeKey, h);
  return [...seen.values()];
}
