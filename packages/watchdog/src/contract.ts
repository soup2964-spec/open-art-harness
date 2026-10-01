// Contract evaluator: turns observations (live watchdog runs, or the saved 2026-09-29 captures via
// src/adapters/legacy.ts) into PASS / FAIL / ERROR / SKIP per check of scenarios/contract.json,
// with evidence per check. Pure function of its inputs.
import fs from 'node:fs';
import path from 'node:path';
import { defaultsSet } from './consent/gcd.js';
import { isAppPath } from './adapters/legacy.js';
import { parseOaAdClids, finalStepsOf } from './observe/clickids.js';
import { exactlyOnePerRoute, pageViewReport } from './observe/pageviews.js';
import type { CheckResult, CheckStatus, DecodedHit, Evidence, JourneyObservation, Observations, Platform, ReplayScenarioContext } from './types.js';
import { AD_PLATFORMS } from './types.js';
import { distinctEvents } from './vendors/decode.js';

export interface ContractCheck {
  id: string;
  title: string;
  claim?: string;
  platform?: string;
  kind: string;
  source: { replay?: string; journey?: string; journeys?: string[]; step?: string; consentProbes?: string[] };
  params?: Record<string, any>;
  rationale?: string;
}

export interface Contract {
  schema: string;
  title: string;
  description?: string;
  checks: ContractCheck[];
}

export const DEFAULT_CONTRACT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scenarios', 'contract.json');

export function loadContract(file = DEFAULT_CONTRACT_PATH): Contract {
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Contract;
  if (!Array.isArray(c.checks)) throw new Error(`${file}: no checks[]`);
  const ids = new Set<string>();
  for (const k of c.checks) {
    if (!k.id || !k.kind || !k.source) throw new Error(`${file}: check without id/kind/source`);
    if (ids.has(k.id)) throw new Error(`${file}: duplicate check id ${k.id}`);
    if (!EVALUATORS[k.kind]) throw new Error(`${file}: unknown check kind ${k.kind}`);
    ids.add(k.id);
  }
  return c;
}

export function resolveTemplate(t: string, ctx: ReplayScenarioContext): string | null {
  let missing = false;
  const out = t.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = (ctx as Record<string, string | undefined>)[k];
    if (v === undefined || v === null || v === '') {
      missing = true;
      return `{${k}}`;
    }
    return v;
  });
  return missing ? null : out;
}

const describe = (h: DecodedHit) => `${h.step} · ${h.endpoint} · ${h.eventName ?? h.kind}`;
const ev = (label: string, detail: string, ref?: string): Evidence => ({ label, detail, ref });

function result(check: ContractCheck, status: CheckStatus, expected: string, observed: string, evidence: Evidence[], confidence: 'observed' | 'inferred' = 'observed'): CheckResult {
  return { id: check.id, title: check.title, claim: check.claim, platform: check.platform, status, expected, observed, evidence, confidence };
}

type Evaluator = (check: ContractCheck, obs: Observations) => CheckResult;

// ------------------------------------------------------------------ replay helpers
/** Tag readiness each replay check depends on (READY_EXPR, taken before the seal). */
const READY: Record<string, (r: Record<string, unknown>) => boolean> = {
  google_ads: (r) => r.hasContainer === true && r.gtag === 'function',
  linkedin: (r) => r.lintrk === 'function',
  x: (r) => r.twqExe === true,
  tiktok: (r) => r.ttqLoaded === true,
  any: (r) => r.hasContainer === true,
};

function replayHits(obs: Observations, scenario: string, platform?: string): { hits: DecodedHit[]; ctx: ReplayScenarioContext; invalid: string | null } {
  const sc = obs.replay?.scenarios.find((s) => s.id === scenario);
  const hits = (obs.replay?.hits ?? []).filter((h) => h.step === scenario);
  let invalid: string | null = null;
  const r = obs.replay;
  if (!sc) invalid = `scenario ${scenario} missing from the replay`;
  else if (!sc.start) invalid = `scenario ${scenario} never executed`;
  else if (sc.error) invalid = `scenario ${scenario} threw in the page: ${sc.error}`;
  else if (r?.loadStatus !== undefined && r.loadStatus !== 'load') invalid = `the replay page did not load (${r.loadStatus})`;
  else if (r?.readiness !== undefined) {
    const probe = READY[platform ?? 'any'] ?? READY.any!;
    if (!r.readiness || !probe(r.readiness)) invalid = `${platform ?? 'GTM'} tag not ready on the replay page (readiness ${JSON.stringify(r.readiness ?? null).slice(0, 160)})`;
  }
  return { hits, ctx: sc?.context ?? {}, invalid };
}

// ------------------------------------------------------------------ journey helpers
function journey(obs: Observations, id: string | undefined): JourneyObservation | undefined {
  return obs.journeys.find((j) => j.id === id);
}

function pathOf(href: string | undefined): string {
  try {
    return new URL(href ?? '').pathname;
  } catch {
    return '';
  }
}

/**
 * Preconditions that make a journey check meaningful. A journey whose steps failed, that never
 * reached an app page, or that deviated from the path the contract names is ERROR, never PASS/FAIL.
 */
function journeyGate(j: JourneyObservation, check: ContractCheck, needsApp: boolean): string | null {
  if (j.errors.length) return `journey did not run as specified: ${j.errors.slice(0, 2).join('; ')}`;
  if (needsApp) {
    const app = finalStepsOf(j);
    if (!app.length) return 'journey never reached an app page';
    const last = [...j.snapshots].reverse().find((x) => app.includes(x.step));
    if (j.snapshots.length && (!last || !isAppPath(last.href))) return `last app step is not on an app page (${last?.href ?? 'no snapshot'})`;
  }
  for (const [step, re] of Object.entries((check.params?.stepPaths as Record<string, string>) ?? {})) {
    const snap = j.snapshots.find((x) => x.step === step);
    if (!snap) return `required step "${step}" missing`;
    if (!new RegExp(re).test(pathOf(snap.href))) return `step "${step}" is on ${pathOf(snap.href)}, not ${re}`;
  }
  return null;
}

const lastAppSnapshot = (j: JourneyObservation) => {
  const app = finalStepsOf(j);
  return [...j.snapshots].reverse().find((x) => app.includes(x.step));
};

const hasUserData = (h: DecodedHit) => h.kind === 'conversion_user_data' || !!(h.fields.em && String(h.fields.em).length) || /^encrypted/.test(String(h.fields.eme ?? ''));

const EVALUATORS: Record<string, Evaluator> = {
  'replay.google_ads_conversion'(check, obs) {
    const labels = (check.params?.labels as string[] | undefined) ?? null;
    const expected = `≥1 Google Ads conversion${labels ? ` with label ${labels.join(' / ')}` : ''} for "${check.source.replay}"${check.params?.requireUserData ? ' carrying user-provided data (EC envelope / em) on the same conversion' : ''}`;
    if (!obs.replay) return result(check, 'SKIP', expected, 'replay not run', []);
    const { hits, invalid } = replayHits(obs, check.source.replay!, 'google_ads');
    if (invalid) return result(check, 'ERROR', expected, invalid, []);
    const g = hits.filter((h) => h.platform === 'google_ads');
    const conv = g.filter((h) => h.kind === 'conversion' && (!labels || labels.includes(String(h.fields.label ?? ''))));
    const events = distinctEvents(conv);
    const streams = new Set(conv.map((h) => h.stream));
    // user data must belong to THIS conversion: a labelled conversion copy with em/eme, or form-data for the same account
    const withUd = [...conv.filter(hasUserData), ...g.filter((h) => h.kind === 'conversion_user_data' && streams.has(h.stream))];
    const others = distinctEvents(g.filter((h) => h.kind === 'conversion' && !conv.includes(h)));
    const evidence = [
      ev('Google requests caused by the scenario', String(g.length)),
      ...events.slice(0, 4).map((h) => ev('conversion event', `${h.stream} label=${h.fields.label} value=${h.fields.value ?? '—'} oid=${h.fields.oid ?? '—'} ec_mode=${h.fields.ec_mode ?? '—'}`, h.requestId)),
      ...others.slice(0, 2).map((h) => ev('other conversion (not the contract label)', `${h.stream} label=${h.fields.label}`, h.requestId)),
      ev('hits with user data on this conversion', String(withUd.length), withUd[0]?.requestId),
    ];
    const ok = events.length > 0 && (!check.params?.requireUserData || withUd.length > 0);
    const observed = events.length ? `${events.length} conversion event(s) (${[...streams].join(', ')}); user data on ${withUd.length} hit(s)` : others.length ? `no conversion with the contract label (${others.length} other conversion event(s))` : 'no Google Ads conversion request at all';
    return result(check, ok ? 'PASS' : 'FAIL', expected, observed, evidence);
  },

  'replay.linkedin_conversion_fields'(check, obs) {
    const expected = 'every LinkedIn conversion hit carries val (value) and a non-empty eventId';
    if (!obs.replay) return result(check, 'SKIP', expected, 'replay not run', []);
    const { hits, invalid } = replayHits(obs, check.source.replay!, 'linkedin');
    if (invalid) return result(check, 'ERROR', expected, invalid, []);
    const conv = hits.filter((h) => h.platform === 'linkedin' && h.kind === 'conversion');
    if (!conv.length) return result(check, 'FAIL', expected, 'no LinkedIn conversion hit', []);
    const bad = conv.filter((h) => (check.params?.value && !h.fields.val) || (check.params?.eventId && !h.fields.eventId));
    const evidence = conv.slice(0, 3).map((h) => ev('conversion hit', `conversionId=${h.fields.conversionId} val=${h.fields.val ?? '—'} cur=${h.fields.cur ?? '—'} eventId=${h.fields.eventId || '—'}`, h.requestId));
    return result(check, bad.length ? 'FAIL' : 'PASS', expected, bad.length ? `${bad.length}/${conv.length} conversion hit(s) missing value or event id` : `${conv.length} hit(s) with value and event id`, evidence);
  },

  'replay.x_single_purchase'(check, obs) {
    if (!obs.replay) return result(check, 'SKIP', 'exactly 1 X purchase event with a deterministic id', 'replay not run', []);
    const { hits, ctx, invalid } = replayHits(obs, check.source.replay!, 'x');
    const ids = ((check.params?.idEqualsOneOf as string[]) ?? []).map((t) => resolveTemplate(t, ctx)).filter((x): x is string => !!x);
    const expected = `exactly 1 X purchase event whose id ∈ {${ids.join(', ')}}`;
    if (invalid) return result(check, 'ERROR', expected, invalid, []);
    const events = distinctEvents(hits.filter((h) => h.platform === 'x' && (h.kind === 'conversion' || h.kind === 'auto_conversion')));
    const evidence = events.map((h) => ev(h.kind === 'auto_conversion' ? 'automatic event' : 'conversion event', `${h.eventName} event_id=${h.fields.event_id} conversion_id=${h.fields.conversion_id ?? '—'} order_id=${h.fields.order_id ?? '—'}`, h.requestId));
    const idOf = (h: DecodedHit) => [h.fields.conversion_id, h.fields.order_id, h.fields.event_id].map((x) => (x == null ? '' : String(x)));
    const ok = events.length === 1 && idOf(events[0]!).some((x) => ids.includes(x));
    return result(check, ok ? 'PASS' : 'FAIL', expected, `${events.length} X purchase event(s)${events.length === 1 ? ` (ids ${idOf(events[0]!).filter(Boolean).join(' / ')})` : ''}`, evidence);
  },

  'replay.tiktok_event_id'(check, obs) {
    if (!obs.replay) return result(check, 'SKIP', `TikTok ${check.params?.event} with event_id = ${check.params?.eventId}`, 'replay not run', []);
    const { hits, ctx, invalid } = replayHits(obs, check.source.replay!, 'tiktok');
    const want = resolveTemplate(String(check.params?.eventId), ctx);
    const expected = `TikTok ${check.params?.event} with event_id = ${want ?? check.params?.eventId}`;
    if (invalid) return result(check, 'ERROR', expected, invalid, []);
    const ttev = hits.filter((h) => h.platform === 'tiktok' && h.eventName === check.params?.event);
    if (!ttev.length) return result(check, 'FAIL', expected, `no TikTok ${check.params?.event} hit`, []);
    const got = [...new Set(ttev.map((h) => String(h.fields.event_id ?? '')))];
    const evidence = ttev.slice(0, 2).map((h) => ev('pixel event', `${h.eventName} event_id=${JSON.stringify(h.fields.event_id)}`, h.requestId));
    if (!want) evidence.push(ev('note', 'the capture has no synthetic uid, so reg_<uid> cannot be resolved; any non-reg_ id fails'));
    const ok = !!want && got.length === 1 && got[0] === want;
    return result(check, ok ? 'PASS' : 'FAIL', expected, `event_id ${got.map((g) => JSON.stringify(g)).join(', ')}`, evidence);
  },

  'replay.scenario_consumed'(check, obs) {
    const expected = `≥${check.params?.minConversionEvents ?? 1} ad-platform conversion event(s) caused by "${check.source.replay}"`;
    if (!obs.replay) return result(check, 'SKIP', expected, 'replay not run', []);
    const { hits, invalid } = replayHits(obs, check.source.replay!, 'any');
    if (invalid) return result(check, 'ERROR', expected, invalid, []);
    const conv = distinctEvents(hits.filter((h) => (AD_PLATFORMS as string[]).includes(h.platform) && (h.kind === 'conversion' || h.kind === 'auto_conversion')));
    const other = hits.filter((h) => !(h.kind === 'conversion' || h.kind === 'auto_conversion'));
    const evidence = [...conv.slice(0, 5).map((h) => ev('conversion', `${h.platform} ${h.eventName}`, h.requestId)), ...other.slice(0, 3).map((h) => ev('non-conversion effect', `${h.platform} ${h.kind} ${h.endpoint}`, h.requestId))];
    const ok = conv.length >= (check.params?.minConversionEvents ?? 1);
    return result(check, ok ? 'PASS' : 'FAIL', expected, ok ? `${conv.length} conversion event(s): ${[...new Set(conv.map((h) => h.platform))].join(', ')}` : `no conversion; only ${other.length} diagnostic/other hit(s)`, evidence);
  },

  'journey.google_auto_form_events'(check, obs) {
    const j = journey(obs, check.source.journey);
    const names = (check.params?.events as string[]) ?? ['form_start', 'form_submit'];
    const expected = `≤${check.params?.max ?? 0} Google ${names.join('/')} events on generation`;
    if (!j) return result(check, 'SKIP', expected, `journey ${check.source.journey} not run`, []);
    const gate = journeyGate(j, check, false);
    if (gate) return result(check, 'ERROR', expected, gate, []);
    const gen = j.generation;
    if (!gen?.clicked) return result(check, 'ERROR', expected, `Generate was not clicked${gen?.note ? ': ' + gen.note : ''}`, gen ? [ev('generation', `${gen.page} typed=${gen.typed} clicked=${gen.clicked}`)] : []);
    const tagLoaded = j.hits.some((h) => h.step === j.hardLoadStep && (h.platform === 'google_ads' || h.platform === 'ga4') && h.kind === 'page_view');
    if (!tagLoaded) return result(check, 'ERROR', expected, 'no Google page_view on the hard load: the Google tag was not running, so the absence of form events proves nothing', [ev('generation', gen.note ?? '')]);
    const g = distinctEvents(j.hits.filter((h) => h.step === check.source.step && (h.platform === 'google_ads' || h.platform === 'ga4') && names.includes(String(h.eventName))));
    const byName = names.map((n) => `${n}: ${g.filter((h) => h.eventName === n).length}`).join(', ');
    const evidence = [ev('generation', `${gen.page} typed=${gen.typed} clicked=${gen.clicked}${gen.note ? ' — ' + gen.note : ''}`), ...g.slice(0, 4).map((h) => ev('Google event', describe(h), h.requestId))];
    return result(check, g.length <= (check.params?.max ?? 0) ? 'PASS' : 'FAIL', expected, `${g.length} distinct event(s) (${byName})`, evidence);
  },

  'journey.page_views_per_route_change'(check, obs) {
    const j = journey(obs, check.source.journey);
    const platform = check.params?.platform as Platform;
    const exactly = check.params?.exactly ?? 1;
    const expected = `exactly ${exactly} ${platform} page view per route change`;
    if (!j) return result(check, 'SKIP', expected, `journey ${check.source.journey} not run`, []);
    const gate = journeyGate(j, check, true);
    if (gate) return result(check, 'ERROR', expected, gate, []);
    const rep = pageViewReport(j, [platform]);
    const r = exactlyOnePerRoute(rep, platform, exactly);
    const hard = rep.hardLoad?.[platform];
    const evidence = [ev('hard load (reference)', hard ? `${hard.total} (${Object.entries(hard.streams).map(([s, n]) => `${s}: ${n}`).join(', ') || '—'})` : '—'), ...r.perRoute.map((x) => ev(`route ${x.step}`, `${x.observed}${x.invalid ? ' (not evaluable)' : x.ok ? '' : ' ✗'}`))];
    const observed = r.perRoute.map((x) => x.observed).join(' | ') || 'no route change';
    return result(check, r.status, expected, r.reason ? `${r.reason}; ${observed}` : observed, evidence);
  },

  'journey.meta_fbc'(check, obs) {
    const j = journey(obs, check.source.journey);
    const expected = 'the first app page view sent to Meta (/tr or CAPI Gateway) carries fbc built from the ad fbclid';
    if (!j) return result(check, 'SKIP', expected, `journey ${check.source.journey} not run`, []);
    const fbclid = j.clickIds.fbclid;
    if (!fbclid) return result(check, 'ERROR', expected, 'journey had no fbclid', []);
    const gate = journeyGate(j, check, true);
    if (gate) return result(check, 'ERROR', expected, gate, []);
    const app = finalStepsOf(j);
    const meta = j.hits.filter((h) => h.platform === 'meta' && app.includes(h.step));
    const first = app.find((s) => meta.some((h) => h.step === s));
    const onFirst = meta.filter((h) => h.step === first && (h.kind === 'page_view' || h.kind === 'event' || h.kind === 'conversion'));
    const carrying = onFirst.filter((h) => Object.values(h.clickIds).some((v) => v.includes(fbclid)));
    const lastSnap = lastAppSnapshot(j);
    const fbc = lastSnap?.cookies.find((c) => c.name === '_fbc');
    const evidence = [
      ev('app steps', app.join(', ')),
      ...onFirst.slice(0, 3).map((h) => ev(h.transport.startsWith('CAPI') ? 'CAPI Gateway' : '/tr', `${h.eventName} fbc=${h.clickIds.fbc ?? h.clickIds['fb.clickID'] ?? '—'}`, h.requestId)),
      ev('_fbc cookie', fbc ? fbc.value : 'absent'),
      ev('shim fbclid cookie', lastSnap?.cookies.find((c) => c.name === 'fbclid')?.value ?? 'absent'),
    ];
    if (!onFirst.length) return result(check, 'FAIL', expected, 'no Meta hit on the app page', evidence);
    return result(check, carrying.length ? 'PASS' : 'FAIL', expected, carrying.length ? `${carrying.length}/${onFirst.length} Meta hit(s) on ${first} carry fbc` : `0/${onFirst.length} Meta hit(s) on ${first} carry fbc; _fbc ${fbc ? 'set' : 'absent'}`, evidence);
  },

  'journey.oppref_preserved'(check, obs) {
    const j = journey(obs, check.source.journey);
    const expected = 'the OpenAI Ads SDK on the app page sends the oppref from the marketing landing URL';
    if (!j) return result(check, 'SKIP', expected, `journey ${check.source.journey} not run`, []);
    const oppref = j.clickIds.oppref;
    if (!oppref) return result(check, 'ERROR', expected, 'journey had no oppref', []);
    const gate = journeyGate(j, check, true);
    if (gate) return result(check, 'ERROR', expected, gate, []);
    const app = finalStepsOf(j);
    const oa = j.hits.filter((h) => h.platform === 'openai_ads' && app.includes(h.step));
    const carrying = oa.filter((h) => (h.clickIds.oppref ?? '').includes(oppref));
    const cookie = lastAppSnapshot(j)?.cookies.find((c) => c.name === '__oppref');
    const evidence = [ev('OpenAI SDK hits on app', String(oa.length)), ...carrying.slice(0, 2).map((h) => ev('hit with oppref', describe(h), h.requestId)), ev('__oppref cookie', cookie ? cookie.value : 'absent')];
    if (!oa.length) return result(check, 'ERROR', expected, `the OpenAI Ads SDK sent nothing on the app page, so oppref propagation cannot be observed (__oppref ${cookie ? 'set' : 'absent'})`, evidence);
    if (carrying.length) return result(check, 'PASS', expected, `${carrying.length} SDK hit(s) carry oppref`, evidence);
    return result(check, 'FAIL', expected, `${oa.length} SDK hit(s), none with oppref; __oppref ${cookie ? 'set' : 'absent'}`, evidence);
  },

  'journey.oa_ad_clids_keys'(check, obs) {
    const j = journey(obs, check.source.journey);
    const keys = (check.params?.keys as string[]) ?? [];
    const expected = `oa_ad_clids holds ${keys.join(' + ')} at the end of the journey`;
    if (!j) return result(check, 'SKIP', expected, `journey ${check.source.journey} not run`, []);
    const gate = journeyGate(j, check, true);
    if (gate) return result(check, 'ERROR', expected, gate, []);
    const evidence: Evidence[] = j.snapshots.map((s) => ev(`oa_ad_clids @ ${s.step}`, JSON.stringify(parseOaAdClids(s))));
    const oa = parseOaAdClids(lastAppSnapshot(j));
    const missing = keys.filter((k) => !(oa[k]?.v && (!j.clickIds[k] || oa[k]!.v.includes(j.clickIds[k]!))));
    return result(check, missing.length ? 'FAIL' : 'PASS', expected, missing.length ? `missing ${missing.join(', ')} (has ${Object.keys(oa).join(', ') || 'nothing'})` : `has ${Object.keys(oa).join(', ')}`, evidence);
  },

  'journey.handoff_attribution'(check, obs) {
    const j = journey(obs, check.source.journey);
    const expected = 'the "Open page in your browser" handoff URL carries a click id / UTM from the ad, or a token';
    if (!j) return result(check, 'SKIP', expected, `journey ${check.source.journey} not run`, []);
    const gate = journeyGate(j, check, false);
    if (gate) return result(check, 'ERROR', expected, gate, []);
    const h = j.handoff;
    if (!h || (!h.overlayUrl && !h.locationHref)) return result(check, 'ERROR', expected, 'handoff hint/overlay not found', h ? [ev('note', h.note ?? '')] : []);
    const url = h.overlayUrl ?? h.locationHref!;
    let utm: string[] = [];
    try {
      utm = [...new URL(j.landingUrl).searchParams.entries()].filter(([k]) => k.startsWith('utm_')).map(([, v]) => v);
    } catch {
      /* ignore */
    }
    const tokenParams = (check.params?.tokenParams as string[]) ?? [];
    let tokens: string[] = [];
    try {
      tokens = [...new URL(url).searchParams.entries()].filter(([k, v]) => tokenParams.includes(k) && v.length >= 8).map(([k]) => k);
    } catch {
      /* ignore */
    }
    // only distinctive values count (an empty or 1-3 character value would "match" any URL)
    const carried = [...Object.values(j.clickIds), ...utm].filter((v) => v.length >= 4 && url.includes(v));
    const ok = carried.length > 0 || tokens.length > 0;
    const evidence = [ev('handoff URL', url), ev('source', h.source), ev('hint shown', String(h.hintFound)), ...(h.note ? [ev('note', h.note)] : [])];
    return result(check, ok ? 'PASS' : 'FAIL', expected, ok ? `carries ${[...carried, ...tokens].join(', ')}` : `no click id, UTM or token in ${url}`, evidence, h.source === 'observed-overlay' ? 'observed' : 'inferred');
  },

  'consent.region_defaults'(check, obs) {
    const regions = check.source.consentProbes ?? [];
    const denied = (check.params?.defaultDenied as string[]) ?? [];
    const expected = `Google hits in ${regions.join('/')} carry consent defaults (${denied.join(', ')} denied by default) declared for that region`;
    const probes = obs.consentProbes.filter((p) => regions.includes(p.region));
    if (!probes.length) return result(check, 'SKIP', expected, 'consent probes not run', []);
    const evidence: Evidence[] = [];
    const verdicts: Array<{ region: string; status: 'pass' | 'fail' | 'invalid'; detail: string; inferred?: boolean }> = [];
    for (const r of regions) {
      const p = probes.find((x) => x.region === r);
      if (!p) {
        verdicts.push({ region: r, status: 'invalid', detail: `${r}: not probed` });
        continue;
      }
      const g = p.hits.filter((h) => h.consent?.decoded);
      const gcds = [...new Set(g.map((h) => h.consent!.gcd))];
      const applied = appliedDefaultRegions(p.googleConsentState);
      evidence.push(ev(`${r} (${p.country}/${p.subdivision})`, `${g.length} Google hit(s); gcd ${gcds.join(', ') || '—'}; geo rewrites ${p.geoRewrites}; consent commands ${p.consentCommands.length}; tag consent state ${applied.length ? applied.join(', ') : 'no defaults'}`));
      if (p.geoFetchAttempted) verdicts.push({ region: r, status: 'invalid', detail: `${r}: the tag fell back to https://www.google.com/ccm/geo (geo unknown) — probe invalid` });
      else if (!p.geoRewrites) verdicts.push({ region: r, status: 'invalid', detail: `${r}: no Google loader was geo-rewritten — probe invalid` });
      else if (!g.length) {
        // no hit to decode: only the tag's own consent state (or a denied default command) can certify the region
        if (coversRegion(p.googleConsentState, p.consentCommands, p.country, p.subdivision)) verdicts.push({ region: r, status: 'pass', detail: `${r}: no Google hit; denied defaults declared for the region`, inferred: true });
        else verdicts.push({ region: r, status: 'invalid', detail: `${r}: no Google hit and no denied default covering ${p.country} — cannot evaluate` });
      } else {
        const bad = g.filter((h) => {
          const d = h.consent!.decoded!;
          if (!defaultsSet(d)) return true;
          return denied.some((s) => (d as any)[s]?.default !== 'denied');
        });
        if (bad.length) verdicts.push({ region: r, status: 'fail', detail: `${r}: ${bad.length}/${g.length} hit(s) without the required defaults (e.g. gcd=${bad[0]!.consent!.gcd})` });
        // The defaults must be the ones declared for THIS region (or global), per the tag's own state or
        // the dataLayer commands — never another region's default leaking through.
        else if (!coversRegion(p.googleConsentState, p.consentCommands, p.country, p.subdivision)) verdicts.push({ region: r, status: 'fail', detail: `${r}: defaults present but not declared for ${p.country} (tag state: ${applied.join(', ') || 'none'})` });
        else verdicts.push({ region: r, status: 'pass', detail: `${r}: ok` });
      }
    }
    const fails = verdicts.filter((v) => v.status === 'fail');
    const invalid = verdicts.filter((v) => v.status === 'invalid');
    const status: CheckStatus = fails.length ? 'FAIL' : invalid.length ? 'ERROR' : 'PASS';
    const observed = fails.length || invalid.length ? [...fails, ...invalid].map((v) => v.detail).join('; ') : 'defaults present in every probed region';
    return result(check, status, expected, observed, evidence, verdicts.some((v) => v.inferred) ? 'inferred' : 'observed');
  },
};

/** Regions of the ad_storage/ad_user_data/ad_personalization defaults the tag actually applied (google_tag_data.ics). */
export function appliedDefaultRegions(state: unknown): string[] {
  const s = state as Record<string, { region?: string; default?: boolean }> | null | undefined;
  if (!s || typeof s !== 'object') return [];
  return [...new Set(['ad_storage', 'ad_user_data', 'ad_personalization'].filter((k) => s[k] && s[k]!.default !== undefined).map((k) => `${k}=${s[k]!.default ? 'granted' : 'denied'}@${s[k]!.region ?? 'global'}`))];
}

export function coversRegion(state: unknown, commands: unknown[], country: string, subdivision: string): boolean {
  const s = state as Record<string, { region?: string; default?: boolean }> | null | undefined;
  const ok = (region: string | undefined) => !region || region.toUpperCase() === country || region.toUpperCase() === subdivision;
  if (s && typeof s === 'object') {
    const keys = ['ad_storage', 'ad_user_data', 'ad_personalization'];
    if (keys.every((k) => s[k] && s[k]!.default === false && ok(s[k]!.region))) return true;
  }
  // Fallback: a dataLayer consent default covering the region (or with no region = global).
  return (commands ?? []).some((c) => {
    const a = c as unknown[];
    if (!Array.isArray(a) || a[0] !== 'consent' || a[1] !== 'default' || !a[2] || typeof a[2] !== 'object') return false;
    const o = a[2] as Record<string, unknown>;
    const regions = Array.isArray(o.region) ? (o.region as string[]).map((x) => String(x).toUpperCase()) : [];
    return o.ad_storage === 'denied' && o.ad_user_data === 'denied' && o.ad_personalization === 'denied' && (!regions.length || regions.includes(country) || regions.includes(subdivision));
  });
}

export function evaluateContract(contract: Contract, obs: Observations): CheckResult[] {
  return contract.checks.map((c) => {
    try {
      return EVALUATORS[c.kind]!(c, obs);
    } catch (e) {
      return result(c, 'ERROR', c.title, `evaluator error: ${(e as Error).message}`, []);
    }
  });
}

export function summarize(results: CheckResult[]): Record<CheckStatus, number> {
  const s: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, ERROR: 0, SKIP: 0 };
  for (const r of results) s[r.status]++;
  return s;
}
