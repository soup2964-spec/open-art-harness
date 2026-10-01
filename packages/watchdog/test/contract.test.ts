import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { journeyFromTeardown, replayFromSealed, spaJourneyFromLoggedIn, type LoggedInFixture, type SealedFixture, type TeardownFixture } from '../src/adapters/legacy.js';
import { evaluateContract, loadContract, resolveTemplate, summarize } from '../src/contract.js';
import type { CheckResult, ConsentProbeObservation, JourneyObservation, Observations } from '../src/types.js';
import { FIXTURES, readJson } from './evidence.js';

const contract = loadContract();
const td = (file: string, id: string) => journeyFromTeardown(readJson<TeardownFixture>(path.join(FIXTURES, 'journeys', file + '.json')), id);
const replay = replayFromSealed(readJson<SealedFixture>(path.join(FIXTURES, 'sealed/run_suite.json')));
const spa = spaJourneyFromLoggedIn(readJson<LoggedInFixture>(path.join(FIXTURES, 'loggedin/spa_suite.json')), readJson<LoggedInFixture>(path.join(FIXTURES, 'loggedin/generation.json')));
const t6a = td('T6a_country_DE', 'consent_de_cookie');
const consentDE: ConsentProbeObservation = { region: 'DE', country: 'DE', subdivision: 'cookie-only (T6a)', page: t6a.landingUrl, hits: t6a.hits, consentCommands: [], geoRewrites: 0, errors: [] };
// Container v25 declares no consent default for ANY region (research/02; G7), so the gcd letters of
// the saved hits are geo-independent: they stand in for geo-rewritten DE/GB/CH probes here. The
// rewrite mechanism itself is verified on Google's own code in consent-geo.int.test.ts.
const probeAs = (region: string): ConsentProbeObservation => ({ ...consentDE, region, country: region, subdivision: region + '-X', geoRewrites: 1 });

/** Today's evidence mapped onto the watchdog journeys (research/01 scenario ids in comments). */
function todaysObservations(): Observations {
  return {
    replay,
    journeys: [
      td('T1f_multipage_meta', 'meta_multi_hop'), // landing -> /ai-model/seedance-2-5/ -> app
      td('T1g_typed_return_meta', 'meta_return'), // landing, then typed /home
      td('T3a_otherclids', 'oppref_marketing'), // Astro landing with oppref -> CTA -> /home
      td('T2c_gbraid_then_app_fbclid', 'gbraid_wbraid'),
      td('T11a_ig_home', 'instagram_webview'),
      spa,
    ],
    consentProbes: [probeAs('DE'), probeAs('GB'), probeAs('CH')],
  };
}

const byId = (rs: CheckResult[]) => Object.fromEntries(rs.map((r) => [r.id, r]));

describe('contract.json', () => {
  it('is well-formed and covers every required behaviour', () => {
    const ids = contract.checks.map((c) => c.id);
    for (const id of ['signup.google_ads.user_data', 'purchase.linkedin.value_and_event_id', 'purchase.x.single_deterministic_event', 'signup.tiktok.event_id', 'business_subscription.consumed', 'generation.google.no_auto_form_events', 'spa.page_views.meta', 'meta.fbc.multi_hop', 'meta.fbc.return', 'openai.oppref.marketing_landing', 'google.gbraid_wbraid.persisted', 'webview.handoff.attribution', 'consent.eea_uk_ch.defaults']) {
      expect(ids).toContain(id);
    }
  });
  it('resolves templates and refuses to guess missing context', () => {
    expect(resolveTemplate('reg_{uid}', { uid: 'WD_TEST_UID_A' })).toBe('reg_WD_TEST_UID_A');
    expect(resolveTemplate('reg_{uid}', {})).toBeNull();
  });
});

describe("today's saved evidence (2026-09-29) evaluates to the research verdicts", () => {
  const r = byId(evaluateContract(contract, todaysObservations()));

  it('replay checks are red, exactly as research/11 found', () => {
    expect(r['signup.google_ads.user_data']!.status).toBe('FAIL');
    expect(r['signup.google_ads.user_data']!.observed).toMatch(/no Google Ads conversion/);
    expect(r['purchase.linkedin.value_and_event_id']!.status).toBe('FAIL');
    expect(r['purchase.x.single_deterministic_event']!.status).toBe('FAIL');
    expect(r['purchase.x.single_deterministic_event']!.observed).toMatch(/^2 X purchase/);
    expect(r['signup.tiktok.event_id']!.status).toBe('FAIL');
    expect(r['signup.tiktok.event_id']!.observed).toContain('""');
    expect(r['business_subscription.consumed']!.status).toBe('FAIL');
  });

  it('journey checks are red (G4, G5, G6, oppref, G7)', () => {
    expect(r['meta.fbc.multi_hop']!.status).toBe('FAIL');
    expect(r['meta.fbc.return']!.status).toBe('FAIL');
    expect(r['openai.oppref.marketing_landing']!.status).toBe('FAIL');
    expect(r['google.gbraid_wbraid.persisted']!.status).toBe('FAIL');
    expect(r['webview.handoff.attribution']!.status).toBe('FAIL');
    expect(r['webview.handoff.attribution']!.confidence).toBe('inferred');
    expect(r['consent.eea_uk_ch.defaults']!.status).toBe('FAIL');
  });

  it('SPA + generation reproduce G15 and the auto form-event finding', () => {
    expect(r['generation.google.no_auto_form_events']!.status).toBe('FAIL');
    for (const p of ['google_ads', 'reddit', 'linkedin', 'x', 'meta', 'microsoft_uet']) expect(r[`spa.page_views.${p}`]!.status, p).toBe('FAIL');
    expect(r['spa.page_views.tiktok']!.status).toBe('PASS');
    expect(r['spa.page_views.meta']!.observed).toMatch(/3/);
  });

  it('summarises', () => {
    const s = summarize(Object.values(r));
    expect(s.PASS).toBe(1);
    expect(s.FAIL).toBe(contract.checks.length - 1);
  });
});

/** The same journey with the first app page's hits carrying the click id (the fixed behaviour). */
function withAppHits(j: JourneyObservation, platform: string, patch: (h: JourneyObservation['hits'][number]) => void): JourneyObservation {
  const out = structuredClone(j);
  for (const h of out.hits) if (h.platform === platform && out.appSteps.includes(h.step)) patch(h);
  return out;
}

describe('positive controls: every check can go green', () => {
  it('fbc passes on the real multi-hop and return journeys once the app hits carry fbc', () => {
    const multi = td('T1f_multipage_meta', 'meta_multi_hop');
    const ret = td('T1g_typed_return_meta', 'meta_return');
    const fixedMulti = withAppHits(multi, 'meta', (h) => (h.clickIds.fbc = `fb.1.1790000000000.${multi.clickIds.fbclid}`));
    const fixedRet = withAppHits(ret, 'meta', (h) => (h.clickIds['fb.clickID'] = `fb.1.1790000000000.${ret.clickIds.fbclid}`));
    const r = byId(evaluateContract(contract, { journeys: [fixedMulti, fixedRet], consentProbes: [] }));
    expect(r['meta.fbc.multi_hop']!.status).toBe('PASS');
    expect(r['meta.fbc.return']!.status).toBe('PASS');
  });

  it('a one-hop journey cannot stand in for the multi-hop check (deviation → ERROR, not PASS)', () => {
    const r = byId(evaluateContract(contract, { journeys: [td('T1a_home_meta', 'meta_multi_hop')], consentProbes: [] }));
    expect(r['meta.fbc.multi_hop']!.status).toBe('ERROR');
    expect(r['meta.fbc.multi_hop']!.observed).toMatch(/marketing_page2/);
  });

  it('oppref passes when the SDK on the app page sends the ref; an app landing is not a marketing landing', () => {
    const t3a = td('T3a_otherclids', 'oppref_marketing');
    const fixed = withAppHits(t3a, 'openai_ads', (h) => (h.clickIds.oppref = t3a.clickIds.oppref!));
    expect(byId(evaluateContract(contract, { journeys: [fixed], consentProbes: [] }))['openai.oppref.marketing_landing']!.status).toBe('PASS');
    expect(byId(evaluateContract(contract, { journeys: [td('T3b_ctrl_home_otherclids', 'oppref_marketing')], consentProbes: [] }))['openai.oppref.marketing_landing']!.status).toBe('ERROR');
  });

  it('handoff passes when the overlay URL still carries the click ids (T11b)', () => {
    const r = byId(evaluateContract(contract, { journeys: [td('T11b_ig_suitevideo', 'instagram_webview')], consentProbes: [] }));
    expect(r['webview.handoff.attribution']!.status).toBe('PASS');
    expect(r['webview.handoff.attribution']!.confidence).toBe('observed');
  });

  it('gbraid/wbraid pass when both keys persist', () => {
    const j: JourneyObservation = td('T2a_gbraid', 'gbraid_wbraid');
    const last = j.snapshots[j.snapshots.length - 1]!;
    last.localStorage = { oa_ad_clids: JSON.stringify({ gbraid: { v: 'KJAUDIT_GB', ts: 1 }, wbraid: { v: 'WB', ts: 2 } }) };
    j.clickIds.wbraid = 'WB';
    const r = byId(evaluateContract(contract, { journeys: [j], consentProbes: [] }));
    expect(r['google.gbraid_wbraid.persisted']!.status).toBe('PASS');
  });

  it('replay checks pass on hits shaped like the fixed behaviour', () => {
    const fixed = structuredClone(replay);
    // signup: the signup conversion (label rVk2, today only fired by new_user_signed_up) fired by the
    // real signup push, with the encrypted user-data envelope on one fan-out copy
    const rvk2 = fixed.hits.filter((h) => h.step === 'new_user_signed_up' && h.platform === 'google_ads' && h.kind === 'conversion');
    fixed.hits.push(...rvk2.map((h, i) => ({ ...h, step: 'signup', fields: { ...h.fields, eme: i === 0 ? 'encrypted: emkid=test' : h.fields.eme } })));
    // linkedin: value + event id
    for (const h of fixed.hits) if (h.step === 'purchase' && h.platform === 'linkedin' && h.kind === 'conversion') Object.assign(h.fields, { val: '56', eventId: 'purchase_SEALTEST_1' });
    // x: drop the automatic gtm_purchase
    fixed.hits = fixed.hits.filter((h) => !(h.step === 'purchase' && h.platform === 'x' && h.kind === 'auto_conversion'));
    // tiktok: reg_<uid>
    const sc = fixed.scenarios.find((s) => s.id === 'signup')!;
    sc.context.uid = 'U1';
    for (const h of fixed.hits) if (h.step === 'signup' && h.platform === 'tiktok' && h.eventName === 'CompleteRegistration') h.fields.event_id = 'reg_U1';
    // business_subscription: consumed by TikTok as a Purchase
    const ttPurchase = fixed.hits.find((h) => h.step === 'first_purchase' && h.platform === 'tiktok' && h.kind === 'conversion')!;
    fixed.hits.push({ ...ttPurchase, step: 'business_subscription', dedupeKey: 'tiktok|biz' });
    const r = byId(evaluateContract(contract, { replay: fixed, journeys: [], consentProbes: [] }));
    for (const id of ['signup.google_ads.user_data', 'purchase.linkedin.value_and_event_id', 'purchase.x.single_deterministic_event', 'signup.tiktok.event_id', 'business_subscription.consumed']) expect(r[id]!.status, id).toBe('PASS');
  });

  it('consent passes when every probed region reports default-denied signals', () => {
    const probe = (region: string): ConsentProbeObservation => ({
      ...consentDE,
      region,
      hits: consentDE.hits.map((h) => (h.consent ? { ...h, consent: { ...h.consent, gcd: '13p3p3p3p1l1', decoded: { ad_storage: { letter: 'p', default: 'denied', update: 'none', effective: 'denied' }, analytics_storage: { letter: 'p', default: 'denied', update: 'none', effective: 'denied' }, ad_user_data: { letter: 'p', default: 'denied', update: 'none', effective: 'denied' }, ad_personalization: { letter: 'p', default: 'denied', update: 'none', effective: 'denied' } } } } : h)),
    });
    const denied = (region: string) => ({ ad_storage: { region, default: false }, analytics_storage: { region, default: false }, ad_user_data: { region, default: false }, ad_personalization: { region, default: false } });
    const withState = (region: string, stateRegion: string) => ({ ...probe(region), country: region, subdivision: region + '-X', geoRewrites: 2, googleConsentState: denied(stateRegion) });
    const r = byId(evaluateContract(contract, { journeys: [], consentProbes: [withState('DE', 'DE'), withState('GB', 'GB'), withState('CH', 'CH')] }));
    expect(r['consent.eea_uk_ch.defaults']!.status).toBe('PASS');
    // another region's default leaking through (e.g. a broken geo) is not a pass
    const leak = byId(evaluateContract(contract, { journeys: [], consentProbes: [withState('DE', 'DE'), withState('GB', 'DE'), withState('CH', 'CH')] }));
    expect(leak['consent.eea_uk_ch.defaults']!.status).toBe('FAIL');
    expect(leak['consent.eea_uk_ch.defaults']!.observed).toMatch(/not declared for GB/);
    // a probe whose loaders were not rewritten, or that fell back to the ccm/geo fetch, is invalid
    const invalid = byId(evaluateContract(contract, { journeys: [], consentProbes: [{ ...withState('DE', 'DE'), geoFetchAttempted: true }, withState('GB', 'GB'), { ...withState('CH', 'CH'), geoRewrites: 0 }] }));
    expect(invalid['consent.eea_uk_ch.defaults']!.observed).toMatch(/ccm\/geo.*probe invalid.*no Google loader was geo-rewritten/s);
  });

  it('another conversion firing on signup does not satisfy the pinned signup label', () => {
    const fixed = structuredClone(replay);
    const purchaseGoogle = fixed.hits.filter((h) => h.step === 'purchase' && h.platform === 'google_ads' && (h.kind === 'conversion' || h.kind === 'conversion_user_data'));
    fixed.hits.push(...purchaseGoogle.map((h) => ({ ...h, step: 'signup' })));
    const r = byId(evaluateContract(contract, { replay: fixed, journeys: [], consentProbes: [] }));
    expect(r['signup.google_ads.user_data']!.status).toBe('FAIL');
    expect(r['signup.google_ads.user_data']!.observed).toMatch(/no conversion with the contract label/);
  });

  it('missing sources are SKIP, not PASS', () => {
    const r = byId(evaluateContract(contract, { journeys: [], consentProbes: [] }));
    expect(Object.values(r).every((x) => x.status === 'SKIP')).toBe(true);
  });
});

describe('validity gates: a source that did not run as specified is ERROR, never PASS/FAIL', () => {
  const byIdOf = (obs: Observations) => byId(evaluateContract(contract, obs));
  it('replay: scenario never executed, threw, or the tag was not ready', () => {
    const notRun = structuredClone(replay);
    notRun.scenarios.find((x) => x.id === 'signup')!.start = undefined;
    expect(byIdOf({ replay: notRun, journeys: [], consentProbes: [] })['signup.tiktok.event_id']!.status).toBe('ERROR');
    const threw = structuredClone(replay);
    threw.scenarios.find((x) => x.id === 'purchase')!.error = 'ReferenceError: K is not defined';
    expect(byIdOf({ replay: threw, journeys: [], consentProbes: [] })['purchase.x.single_deterministic_event']!.observed).toMatch(/threw in the page/);
    const notReady = { ...structuredClone(replay), loadStatus: 'load', readiness: { hasContainer: true, gtag: 'function', ttqLoaded: false, twqExe: true, lintrk: 'function' } };
    const r = byIdOf({ replay: notReady, journeys: [], consentProbes: [] });
    expect(r['signup.tiktok.event_id']!.status).toBe('ERROR');
    expect(r['purchase.x.single_deterministic_event']!.status).toBe('FAIL'); // X was ready: a real finding
    expect(byIdOf({ replay: { ...structuredClone(replay), loadStatus: 'goto-err: timeout', readiness: null }, journeys: [], consentProbes: [] })['business_subscription.consumed']!.status).toBe('ERROR');
  });
  it('journeys: step failures and journeys that never reached the app', () => {
    const failed = td('T1f_multipage_meta', 'meta_multi_hop');
    failed.errors = ['marketing_page2: CTA not found'];
    expect(byIdOf({ journeys: [failed], consentProbes: [] })['meta.fbc.multi_hop']!.status).toBe('ERROR');
    const noApp = td('T1g_typed_return_meta', 'meta_return');
    noApp.appSteps = [];
    expect(byIdOf({ journeys: [noApp], consentProbes: [] })['meta.fbc.return']!.observed).toMatch(/never reached an app page/);
  });
  it('oppref: an SDK that sent nothing is not evidence of preservation', () => {
    const t3a = td('T3a_otherclids', 'oppref_marketing');
    t3a.hits = t3a.hits.filter((h) => h.platform !== 'openai_ads');
    expect(byIdOf({ journeys: [t3a], consentProbes: [] })['openai.oppref.marketing_landing']!.status).toBe('ERROR');
  });
  it('handoff: an empty UTM value cannot "match" the handoff URL', () => {
    const ig = td('T11a_ig_home', 'instagram_webview');
    ig.landingUrl = 'https://openart.ai/?utm_term=&utm_source=ig';
    expect(byIdOf({ journeys: [ig], consentProbes: [] })['webview.handoff.attribution']!.status).toBe('FAIL');
  });
  it('generation: typed but not clicked, or no Google tag running, is ERROR', () => {
    const typedOnly = structuredClone(spa);
    typedOnly.generation = { ...typedOnly.generation!, clicked: false };
    expect(byIdOf({ journeys: [typedOnly], consentProbes: [] })['generation.google.no_auto_form_events']!.status).toBe('ERROR');
    const noTag = structuredClone(spa);
    noTag.hits = noTag.hits.filter((h) => !(h.step === noTag.hardLoadStep && (h.platform === 'google_ads' || h.platform === 'ga4')));
    noTag.hits = noTag.hits.filter((h) => !['form_start', 'form_submit'].includes(String(h.eventName)));
    expect(byIdOf({ journeys: [noTag], consentProbes: [] })['generation.google.no_auto_form_events']!.observed).toMatch(/Google tag was not running/);
  });
  it('page views: a non-soft route is never silently dropped, and an empty reference is ERROR', () => {
    const hardRoute = structuredClone(spa);
    hardRoute.routeChanges![0]!.ok = false;
    hardRoute.routeChanges![0]!.note = 'hard navigation (not a soft route change)';
    const r = byIdOf({ journeys: [hardRoute], consentProbes: [] });
    expect(r['spa.page_views.google_ads']!.status).toBe('FAIL'); // the clean routes still show the real bug
    expect(r['spa.page_views.tiktok']!.status).toBe('ERROR'); // clean routes pass, but not every route was clean
    const noRef = structuredClone(spa);
    noRef.hits = noRef.hits.filter((h) => !(h.step === noRef.hardLoadStep && h.platform === 'tiktok'));
    expect(byIdOf({ journeys: [noRef], consentProbes: [] })['spa.page_views.tiktok']!.observed).toMatch(/no tiktok page view on the hard load/);
  });
  it('consent: no Google hit plus a default for another region is not a pass', () => {
    const noHits = (region: string): ConsentProbeObservation => ({ ...probeAs(region), hits: [], consentCommands: [['consent', 'default', { ad_storage: 'granted', region: ['US'] }]] });
    const r = byIdOf({ journeys: [], consentProbes: [noHits('DE'), noHits('GB'), noHits('CH')] });
    expect(r['consent.eea_uk_ch.defaults']!.status).toBe('ERROR');
    expect(r['consent.eea_uk_ch.defaults']!.observed).toMatch(/cannot evaluate/);
    const partial = byIdOf({ journeys: [], consentProbes: [{ ...probeAs('DE'), hits: [], googleConsentState: { ad_storage: { region: 'DE', default: false }, ad_user_data: { region: 'DE', default: false }, ad_personalization: { region: 'DE', default: false } } }] });
    expect(partial['consent.eea_uk_ch.defaults']!.status).toBe('ERROR'); // GB/CH not probed
  });
});
