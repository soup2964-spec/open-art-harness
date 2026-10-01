import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { journeyFromTeardown, replayFromSealed, spaJourneyFromLoggedIn, type LoggedInFixture, type SealedFixture, type TeardownFixture } from '../src/adapters/legacy.js';
import { distinctEvents } from '../src/vendors/decode.js';
import type { DecodedHit } from '../src/types.js';
import { FIXTURES, readJson } from './evidence.js';

const sealed = replayFromSealed(readJson<SealedFixture>(path.join(FIXTURES, 'sealed/run_suite.json')));
const td = (n: string) => journeyFromTeardown(readJson<TeardownFixture>(path.join(FIXTURES, 'journeys', n + '.json')), n);
const of = (hits: DecodedHit[], step: string, platform: string) => hits.filter((h) => h.step === step && h.platform === platform);

describe('decoder on the sealed replay (research/11 §3 matrix)', () => {
  it('signup: nothing to Google; Reddit/LinkedIn/X/TikTok conversions; TikTok event_id is empty', () => {
    expect(of(sealed.hits, 'signup', 'google_ads')).toHaveLength(0);
    expect(distinctEvents(of(sealed.hits, 'signup', 'reddit')).map((h) => h.eventName)).toEqual(['SignUp']);
    expect(of(sealed.hits, 'signup', 'linkedin')[0]!.fields.conversionId).toBe('29290241');
    const x = distinctEvents(of(sealed.hits, 'signup', 'x'));
    expect(x.map((h) => [h.kind, h.eventName])).toEqual([['conversion', 'tw-qwghh-13vj22']]);
    const tt = of(sealed.hits, 'signup', 'tiktok').filter((h) => h.kind === 'conversion');
    expect(tt).toHaveLength(1);
    expect(tt[0]!.eventName).toBe('CompleteRegistration');
    expect(tt[0]!.fields.event_id).toBe('');
  });

  it('new_user_signed_up: one Google Ads conversion event fanned out over 5 requests, value 0, empty envelope', () => {
    const g = of(sealed.hits, 'new_user_signed_up', 'google_ads');
    expect(g.length).toBe(5);
    const ev = distinctEvents(g.filter((h) => h.kind === 'conversion'));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.fields.label).toBe('rVk2CJ7Ot8EZEOSYw_Up');
    expect(ev[0]!.fields.value).toBe('0');
    expect(String(ev[0]!.fields.oid)).toMatch(/^GG_/);
    expect(ev[0]!.consent?.gcd).toBe('13l3l3l3l1l1');
  });

  it('purchase: both Google Ads accounts with encrypted user data; LinkedIn id-only; X two purchase events', () => {
    const conv = distinctEvents(of(sealed.hits, 'purchase', 'google_ads').filter((h) => h.kind === 'conversion'));
    expect(new Set(conv.map((h) => h.stream))).toEqual(new Set(['AW-11252321380', 'AW-16854695811']));
    expect(conv.every((h) => h.fields.oid === 'sub_SEALTEST_1')).toBe(true);
    // the EC envelope rides on one of the five fan-out copies (research/11 §3.3 #5), so look at all copies
    const allConv = of(sealed.hits, 'purchase', 'google_ads').filter((h) => h.kind === 'conversion');
    expect(allConv.some((h) => h.fields.ec_mode === 'c' && /^encrypted/.test(String(h.fields.eme)))).toBe(true);
    const li = of(sealed.hits, 'purchase', 'linkedin').filter((h) => h.kind === 'conversion');
    expect(li[0]!.fields).toMatchObject({ conversionId: '29290225', eventId: undefined, val: undefined });
    const x = distinctEvents(of(sealed.hits, 'purchase', 'x').filter((h) => h.kind === 'conversion' || h.kind === 'auto_conversion'));
    expect(x.map((h) => h.kind).sort()).toEqual(['auto_conversion', 'conversion']);
    expect(x.find((h) => h.kind === 'conversion')!.fields.conversion_id).toBe('sub_SEALTEST_1');
    expect(x.find((h) => h.kind === 'auto_conversion')!.fields.order_id).toBe('sub_SEALTEST_1');
    const rd = distinctEvents(of(sealed.hits, 'purchase', 'reddit'));
    expect(rd[0]!.fields['m.transactionId']).toBe('sub_SEALTEST_1');
  });

  it('first_purchase reaches TikTok with a deterministic event_id; business_subscription only a diagnostic beacon', () => {
    const tt = of(sealed.hits, 'first_purchase', 'tiktok').filter((h) => h.kind === 'conversion');
    expect(tt[0]!.fields.event_id).toBe('sub_SEALTEST_2');
    const biz = of(sealed.hits, 'business_subscription', 'tiktok');
    expect(biz.length).toBeGreaterThan(0);
    expect(biz.every((h) => h.kind === 'diagnostic')).toBe(true);
    expect(sealed.hits.filter((h) => h.step === 'business_subscription' && h.platform !== 'tiktok' && h.platform !== 'other')).toHaveLength(0);
  });

  it("the app's UET purchase call carries value and transaction id", () => {
    const u = of(sealed.hits, 'uet_purchase', 'microsoft_uet');
    expect(u[0]).toMatchObject({ kind: 'conversion', eventName: 'custom:purchase' });
    expect(u[0]!.fields).toMatchObject({ gv: '56', gc: 'USD', transaction_id: 'sub_SEALTEST_6' });
  });
});

describe('decoder on journeys (click-ID fields)', () => {
  it('T1a: first app PageView carries fbc in /tr and fb.clickID in the gateway copy (same eid → 1 event)', () => {
    const j = td('T1a_home_meta');
    const meta = of(j.hits, 'app_after_cta', 'meta').filter((h) => h.kind === 'page_view');
    expect(meta.length).toBeGreaterThanOrEqual(2);
    expect(distinctEvents(meta)).toHaveLength(1);
    expect(meta.some((h) => /KJAUDIT_F/.test(h.clickIds.fbc ?? ''))).toBe(true);
    expect(meta.some((h) => /KJAUDIT_F/.test(h.clickIds['fb.clickID'] ?? ''))).toBe(true);
    const g = of(j.hits, 'app_after_cta', 'google_ads').filter((h) => h.kind === 'page_view');
    expect(g.some((h) => h.clickIds.gclaw === 'KJAUDIT_G')).toBe(true);
    const t = of(j.hits, 'app_after_cta', 'tiktok').filter((h) => h.kind === 'page_view');
    expect(t.some((h) => /^KJAUDIT_T/.test(h.clickIds['context.ad.callback'] ?? ''))).toBe(true);
  });

  it('T3b: dedicated fields for rdt_cid, li_fat_id, twclid, msclkid, oppref', () => {
    const j = td('T3b_ctrl_home_otherclids');
    // substring match: UET appends a suffix (msclkid=KJAUDIT_M-1)
    const has = (p: string, f: string, v: string) => j.hits.some((h) => h.platform === p && (h.clickIds[f] ?? '').includes(v));
    expect(has('reddit', 'click_id', 'KJAUDIT_R')).toBe(true);
    expect(has('linkedin', 'li_fat_id', 'KJAUDIT_L')).toBe(true);
    expect(has('x', 'twclid', 'KJAUDIT_X')).toBe(true);
    expect(has('microsoft_uet', 'msclkid', 'KJAUDIT_M')).toBe(true);
    expect(has('openai_ads', 'oppref', 'KJAUDIT_O')).toBe(true);
  });

  it('T2a: gbraid rides on Google hits as gbraid/gclgb', () => {
    const j = td('T2a_gbraid');
    expect(j.hits.some((h) => h.platform === 'google_ads' && (h.clickIds.gbraid === 'KJAUDIT_GB' || h.clickIds.gclgb === 'KJAUDIT_GB'))).toBe(true);
  });

  it('X page views dedupe across t.co + analytics.twitter.com', () => {
    const j = td('T1a_home_meta');
    const pv = of(j.hits, 'landing', 'x').filter((h) => h.kind === 'page_view');
    expect(pv.length).toBe(2);
    expect(distinctEvents(pv)).toHaveLength(1);
  });

  it('consent: every Google hit in the saved journeys reports gcd 13l3l3l3l1l1 and no gcs', () => {
    const j = td('T6a_country_DE');
    const g = j.hits.filter((h) => h.consent);
    expect(g.length).toBeGreaterThan(5);
    expect(new Set(g.map((h) => h.consent!.gcd))).toEqual(new Set(['13l3l3l3l1l1']));
    expect(g.every((h) => !h.consent!.gcs)).toBe(true);
  });
});

describe('decoder on the logged-in SPA + generation captures', () => {
  const spa = spaJourneyFromLoggedIn(readJson<LoggedInFixture>(path.join(FIXTURES, 'loggedin/spa_suite.json')), readJson<LoggedInFixture>(path.join(FIXTURES, 'loggedin/generation.json')));
  it('finds Google automatic form_start/form_submit on the generation click', () => {
    const names = new Set(spa.hits.filter((h) => h.step === 'generation' && h.platform === 'google_ads').map((h) => h.eventName));
    expect(names.has('form_start')).toBe(true);
    expect(names.has('form_submit')).toBe(true);
  });
  it('UET pageHide beacons do not collide with page loads', () => {
    const uet = spa.hits.filter((h) => h.platform === 'microsoft_uet' && h.step === 'soft3_media');
    expect(uet.filter((h) => h.kind === 'page_view')).toHaveLength(1);
  });
});

import { decodeAll, decodeRequest } from '../src/vendors/decode.js';
import type { CapturedRequest } from '../src/types.js';
const cap = (o: Partial<CapturedRequest>): CapturedRequest => ({ id: 'q' + Math.random(), t: 0, step: 's', url: 'https://openart.ai/', method: 'POST', resourceType: 'Fetch', action: 'fail', collection: true, ...o });

describe('decoder robustness (batched bodies, fan-out, malformed input)', () => {
  it('splits a GA4 /g/collect body that batches several events (the URL event is not the only one)', () => {
    const h = decodeRequest(cap({ url: 'https://openart.ai/4vu8/g/collect?v=2&tid=G-ABC&en=page_view&dl=https%3A%2F%2Fopenart.ai%2Fhome', postData: 'en=scroll&epn.percent_scrolled=90&_et=5\nen=user_engagement&_et=900' }));
    expect(h.map((x) => x.eventName)).toEqual(['scroll', 'user_engagement']);
    expect(new Set(h.map((x) => x.dedupeKey)).size).toBe(2);
    expect(decodeRequest(cap({ url: 'https://openart.ai/4vu8/g/collect?v=2&tid=G-ABC&en=page_view', postData: '' })).map((x) => x.eventName)).toEqual(['page_view']);
  });
  it('fans one request out to every destination in tids=A~B', () => {
    const h = decodeRequest(cap({ url: 'https://www.google.com/ccm/collect?en=page_view&tids=AW-111111111~AW-222222222&dl=https%3A%2F%2Fopenart.ai%2F' }));
    expect(h.map((x) => x.stream)).toEqual(['AW-111111111', 'AW-222222222']);
  });
  it('unwraps TikTok batch bodies into one event each', () => {
    const body = JSON.stringify({ batch: [{ event: 'Pageview', message_id: 'm1', context: { page: { url: 'https://openart.ai/home' } } }, { event: 'ClickButton', message_id: 'm2' }, null] });
    const h = decodeRequest(cap({ url: 'https://analytics.tiktok.com/api/v2/pixel/batch', postData: body }));
    expect(h.map((x) => x.eventName)).toEqual(['Pageview', 'ClickButton']);
    expect(new Set(h.map((x) => x.dedupeKey)).size).toBe(2);
  });
  it('keeps two Meta PageViews without eid apart (ts + ec, not the per-load "it")', () => {
    const a = decodeRequest(cap({ url: 'https://www.facebook.com/tr/?id=1&ev=PageView&it=100&ts=200&ec=0', method: 'GET', resourceType: 'Image' }));
    const b = decodeRequest(cap({ url: 'https://www.facebook.com/tr/?id=1&ev=PageView&it=100&ts=900&ec=1', method: 'GET', resourceType: 'Image' }));
    expect(a[0]!.dedupeKey).not.toBe(b[0]!.dedupeKey);
  });
  it('survives null batch elements and malformed bodies without aborting the run', () => {
    const reqs = [
      cap({ url: 'https://m6-x.ecs.us-east-2.on.aws/events', postData: '[null, {"event_name":"PageView","event_id":"e1"}]' }),
      cap({ url: 'https://api2.amplitude.com/2/httpapi', postData: '{"events":[null]}' }),
      cap({ url: 'https://bzr.openai.com/v1/events', postData: '{"events":[null,{"type":"page_view","id":"x"}]}' }),
      cap({ url: 'https://www.google.com/ccm/collect?en=page_view', postData: '%E0%A4%A' }),
    ];
    const h = decodeAll(reqs);
    expect(h.filter((x) => x.platform === 'meta').map((x) => x.eventName)).toEqual(['PageView']);
    expect(h.length).toBeGreaterThanOrEqual(4);
  });
});
