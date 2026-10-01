// Adapters from the saved 2026-09-29 capture formats to the watchdog observation model, so the
// contract evaluator can be tested against real evidence (crawl/sealed_evidence, crawl/teardown2,
// crawl/loggedin) and so historical runs can be re-scored with today's contract.
import { decodeAll } from '../vendors/decode.js';
import type {
  CapturedRequest,
  CookieLite,
  HandoffObservation,
  JourneyObservation,
  ReplayObservation,
  ReplayScenarioObservation,
  RouteChange,
  StepSnapshot,
} from '../types.js';

const CLICK_PARAMS = ['gclid', 'fbclid', 'ttclid', 'msclkid', 'rdt_cid', 'li_fat_id', 'twclid', 'oppref', 'gbraid', 'wbraid'];

/**
 * The app front-ends (research/02 §1): Suite (/home, /pricing, /director, /suite/*, /subscriptions,
 * /signin) and legacy Next.js (/image/create, /video, /story, /presets, /promptbook, /tutorials,
 * /models, /legacy/*). Whole path segments only: /homepage or /image-to-video/ are marketing pages.
 */
export function isAppPath(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const u = new URL(href);
    if (!/(^|\.)openart\.ai$/.test(u.hostname) && u.hostname !== '127.0.0.1') return false;
    return /^\/(home|suite|pricing|director|subscriptions|signin|sign-in|image|video|story|create|presets|promptbook|tutorials|models|legacy)(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

export function clickIdsFromUrl(href: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(href);
    for (const k of CLICK_PARAMS) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

// ---------------------------------------------------------------- teardown2 journeys
export interface TeardownFixture {
  meta: { scenario: string; source: string; opts?: Record<string, unknown> };
  steps: Array<{
    label: string;
    href: string | null;
    referrer: string | null;
    cookies: Array<{ name: string; value: string; domain: string }>;
    ls: Record<string, string>;
    overlay: any;
    handoff: { hintCount: number; href: string } | null;
    click?: any;
  }>;
  requests: Array<{ step: string; t: number; url: string; method: string; type: string; postData: string | null; postDataB64Raw: string | null }>;
}

export function requestsFromTeardown(f: TeardownFixture): CapturedRequest[] {
  return f.requests.map((r, i) => ({
    id: `${f.meta.scenario}#${i}`,
    t: r.t ?? i,
    step: r.step,
    url: r.url,
    method: r.method,
    resourceType: r.type,
    postData: r.postDataB64Raw ? null : r.postData,
    postDataB64: r.postDataB64Raw ? [r.postDataB64Raw] : null,
    action: 'observed',
    collection: true,
  }));
}

function handoffFrom(f: TeardownFixture): HandoffObservation | undefined {
  const hintStep = f.steps.find((s) => s.handoff && s.handoff.hintCount > 0);
  const overlayStep = f.steps.find((s) => s.label === 'handoff_overlay');
  if (!hintStep && !overlayStep) return undefined;
  let overlayUrl: string | null = null;
  for (const o of overlayStep?.overlay?.overlays || []) {
    if (!/Option 2/i.test(o.text || '')) continue;
    const span = (o.spans || []).find((x: string) => /^https?:\/\//.test(x));
    overlayUrl = span || (/(https?:\/\/\S+)/.exec(o.text || '')?.[1] ?? null);
  }
  const locationHref = hintStep?.handoff?.href ?? overlayStep?.href ?? null;
  return {
    hintFound: !!hintStep,
    overlayOpened: !!overlayUrl,
    overlayUrl,
    locationHref,
    source: overlayUrl ? 'observed-overlay' : locationHref ? 'inferred-location' : 'none',
    note: overlayUrl ? undefined : 'Overlay did not open; by code Option 2 copies window.location.href (research/01 §T11).',
  };
}

export function journeyFromTeardown(f: TeardownFixture, id: string, title = f.meta.scenario): JourneyObservation {
  const requests = requestsFromTeardown(f);
  const landing = f.steps[0]?.href || '';
  const clickIds: Record<string, string> = {};
  for (const s of f.steps) if (s.href) Object.assign(clickIds, { ...clickIdsFromUrl(s.href), ...clickIds });
  const snapshots: StepSnapshot[] = f.steps.map((s) => ({
    step: s.label,
    href: s.href || '',
    referrer: s.referrer || '',
    cookies: s.cookies.map((c): CookieLite => ({ name: c.name, value: c.value, domain: c.domain })),
    localStorage: s.ls || {},
    extra: { overlay: s.overlay, handoff: s.handoff },
  }));
  const appSteps = f.steps.filter((s) => isAppPath(s.href)).map((s) => s.label);
  return {
    id,
    title,
    landingUrl: landing,
    clickIds,
    appSteps,
    finalStep: f.steps[f.steps.length - 1]?.label || '',
    stepsOrder: f.steps.map((s) => s.label),
    requests,
    hits: decodeAll(requests),
    snapshots,
    handoff: handoffFrom(f),
    pageLoads: 0,
    errors: [],
    notes: [`adapted from ${f.meta.source}`],
  };
}

// ---------------------------------------------------------------- sealed replay runs
export interface SealedFixture {
  meta: { runName: string; pageUrl: string; setName: string; source: string };
  timeline: Array<{ scenario: string; desc: string; start: string; end: string }>;
  captures: Array<{ scenario: string; t: number; url: string; method: string; resourceType: string; postData: string | null; postDataEntriesB64: string[] | null; failRequest?: string }>;
}

/** The 2026-09-29 scenario ids -> the app actions the watchdog contract talks about. */
export const LEGACY_SCENARIO_MAP: Record<string, { id: string; context: ReplayScenarioObservation['context'] }> = {
  S1: { id: 'signup', context: { email: 'seal.test@example.com' } },
  S2: { id: 'new_user_signed_up', context: {} },
  S3: { id: 'purchase', context: { email: 'seal.test@example.com', transaction_id: 'sub_SEALTEST_1', invoice_id: 'SEALTEST_1' } },
  S3c: { id: 'purchase_without_user_data', context: { transaction_id: 'sub_SEALTEST_C0', invoice_id: 'SEALTEST_C0' } },
  S4: { id: 'first_purchase', context: { email: 'seal.test@example.com', transaction_id: 'sub_SEALTEST_2', invoice_id: 'SEALTEST_2' } },
  S5: { id: 'business_subscription', context: { email: 'seal.test@example.com', transaction_id: 'sub_SEALTEST_3', invoice_id: 'SEALTEST_3' } },
  S6a: { id: 'purchase_first', context: { transaction_id: 'sub_SEALTEST_4', invoice_id: 'SEALTEST_4' } },
  S6b: { id: 'conversion_event_purchase', context: { transaction_id: 'sub_SEALTEST_5', invoice_id: 'SEALTEST_5' } },
  S7: { id: 'uet_purchase', context: { transaction_id: 'sub_SEALTEST_6', invoice_id: 'SEALTEST_6' } },
};

export function replayFromSealed(f: SealedFixture): ReplayObservation {
  const map = (s: string) => LEGACY_SCENARIO_MAP[s]?.id ?? s;
  const requests: CapturedRequest[] = f.captures.map((c, i) => ({
    id: `${f.meta.runName}#${i}`,
    t: c.t,
    step: map(c.scenario),
    url: c.url,
    method: c.method,
    resourceType: c.resourceType,
    postData: c.postData,
    postDataB64: c.postDataEntriesB64,
    action: 'fail',
    failResult: c.failRequest,
    collection: true,
  }));
  const scenarios: ReplayScenarioObservation[] = f.timeline.map((t) => ({
    id: map(t.scenario),
    desc: t.desc,
    code: t.desc,
    context: LEGACY_SCENARIO_MAP[t.scenario]?.context ?? {},
    start: t.start,
    end: t.end,
  }));
  return { page: f.meta.pageUrl, scenarios, requests, hits: decodeAll(requests), source: f.meta.source };
}

// ---------------------------------------------------------------- logged-in SPA + generation
export interface LoggedInFixture {
  meta: { source: string };
  navLog?: Array<{ step: string; kind: string; path: string }>;
  requests: Array<{ step: string; t: number; url: string; method: string; type: string; postData: string | null }>;
}

export function spaJourneyFromLoggedIn(spa: LoggedInFixture, generation?: LoggedInFixture): JourneyObservation {
  const reqs = spa.requests.map((r, i): CapturedRequest => ({ id: `spa#${i}`, t: r.t ?? i, step: r.step, url: r.url, method: r.method, resourceType: r.type, postData: r.postData, action: 'observed', collection: true }));
  const gen = (generation?.requests || []).map((r, i): CapturedRequest => ({ id: `gen#${i}`, t: r.t ?? i, step: 'generation', url: r.url, method: r.method, resourceType: r.type, postData: r.postData, action: 'observed', collection: true }));
  const steps: string[] = [];
  for (const n of spa.navLog || []) if (!steps.includes(n.step)) steps.push(n.step);
  const routeChanges: RouteChange[] = steps
    .filter((s) => s !== 'load')
    .map((s) => {
      const hist = (spa.navLog || []).filter((n) => n.step === s).map((n) => n.path);
      return { step: s, from: '', to: hist[0] || '', method: 'mouse', historyEvents: hist, ok: hist.length > 0 };
    });
  const requests = reqs.concat(gen);
  return {
    id: 'spa_pageviews',
    title: 'Suite soft navigations (logged-in capture, 2026-09-29)',
    landingUrl: 'https://openart.ai/suite/home',
    clickIds: {},
    appSteps: steps.concat(gen.length ? ['generation'] : []),
    finalStep: steps[steps.length - 1] || 'load',
    stepsOrder: steps.concat(gen.length ? ['generation'] : []),
    requests,
    hits: decodeAll(requests),
    snapshots: [],
    routeChanges,
    hardLoadStep: 'load',
    generation: gen.length ? { attempted: true, page: '/suite/create-image/openart-sdxl', typed: true, clicked: true, note: 'logged-in live generation (research FINAL VERDICTS, NEW)' } : undefined,
    pageLoads: 0,
    errors: [],
    notes: [`adapted from ${spa.meta.source}`, generation ? `generation hits from ${generation.meta.source}` : ''].filter(Boolean),
  };
}
