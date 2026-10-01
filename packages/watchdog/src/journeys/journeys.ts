// Click-ID journeys under the collection seal. Step logic, CTA candidates, user agents and the
// webview handoff inspection are ported (with attribution) from openart_2026-09-29/crawl/teardown2/
// run.cjs (SHA-256 ed5daa464e24969d…) — the journeys behind research/01 T1/T2/T3/T7/T11 — using the
// watchdog's synthetic WD_TEST_* click ids instead of KJAUDIT_*.
import { clickIdsFromUrl, isAppPath } from '../adapters/legacy.js';
import { buildQuery, type SyntheticData } from '../markers.js';
import type { GenerationObservation, HandoffObservation, JourneyObservation, RouteChange } from '../types.js';
import { jitter, type Device, type SealedSession } from '../browser/harness.js';
import { CLOSE_AUTH_WALL, FIND_PROMPT, INSPECT_HANDOFF, SPA_TARGETS } from '../browser/pagejs.js';

export const O = 'https://openart.ai';

// Verbatim from crawl/teardown2/run.cjs
export const CTA_HOME = [
  { sel: '[data-pageforge-source="start_for_free"]' },
  { sel: '[data-pageforge-source="create_now"]' },
  { sel: '[data-pageforge-source="start_creation_now"]' },
  { text: '^(Start for free|Create now|Start creating|Get started|Try it free|Try for free)$' },
];
export const CTA_ANY = [
  { sel: 'main [data-pageforge-source="start_for_free"]' },
  { sel: 'main [data-pageforge-source="create_now"]' },
  { sel: 'main [data-pageforge-source="start_creation_now"]' },
  { text: '^(Try|Create|Generate|Start|Use).{0,40}$', within: 'main a[href], article a[href]' },
  { sel: '[data-pageforge-source="start_for_free"]' },
  { text: '^(Start for free|Create now|Start creating|Get started)$' },
];

export interface JourneyRunResult {
  landingUrl: string;
  clickIds: Record<string, string>;
  stepsOrder: string[];
  appSteps: string[];
  routeChanges?: RouteChange[];
  hardLoadStep?: string;
  generation?: GenerationObservation;
  handoff?: HandoffObservation;
  notes: string[];
  errors: string[];
}

export interface JourneyDef {
  id: string;
  title: string;
  device: Device;
  ubo?: boolean;
  run(s: SealedSession, d: SyntheticData): Promise<JourneyRunResult>;
}

const all = (d: SyntheticData) => ({ ...d.utm, gclid: d.clickIds.gclid, fbclid: d.clickIds.fbclid, ttclid: d.clickIds.ttclid, msclkid: d.clickIds.msclkid, rdt_cid: d.clickIds.rdt_cid, li_fat_id: d.clickIds.li_fat_id, twclid: d.clickIds.twclid, oppref: d.clickIds.oppref });

function base(landingUrl: string): JourneyRunResult {
  return { landingUrl, clickIds: clickIdsFromUrl(landingUrl), stepsOrder: [], appSteps: [], notes: [], errors: [] };
}

async function land(s: SealedSession, r: JourneyRunResult, url: string, step = 'landing') {
  const nav = await s.goto(url, step);
  if (!nav.ok) r.errors.push(`${step}: navigation failed: ${nav.err}`);
  await s.quiet(5000, 20000, 2500);
  const snap = await s.snapshot(step, { nav });
  r.stepsOrder.push(step);
  if (isAppPath(snap.href)) r.appSteps.push(step);
  return snap;
}

async function clickTo(s: SealedSession, r: JourneyRunResult, cands: Array<{ sel?: string; text?: string; within?: string }>, step: string) {
  await jitter(3000, 6000); // human dwell
  const c = await s.clickCTA(cands, step);
  if (!c.found) r.errors.push(`${step}: CTA not found`);
  else r.notes.push(`${step}: clicked "${c.text}" (${c.href ?? 'no href'}) via ${c.method}; navigated=${c.navigated}`);
  await s.quiet(7000, 25000, 3000);
  if (step !== 'marketing_page2') await s.dismissOverlays();
  const snap = await s.snapshot(step, { click: c });
  r.stepsOrder.push(step);
  if (isAppPath(snap.href)) r.appSteps.push(step);
  return { c, snap };
}

/** Port of run.cjs inspectHandoff() */
async function inspectHandoff(s: SealedSession): Promise<{ href: string; hintCount: number; overlays: Array<{ text: string; spans: string[] }> }> {
  return (await s.evaluate<{ href: string; hintCount: number; overlays: Array<{ text: string; spans: string[] }> }>(INSPECT_HANDOFF)) ?? { href: s.page.url(), hintCount: 0, overlays: [] };
}

function overlayUrl(overlays: Array<{ text: string; spans: string[] }>): string | null {
  for (const o of overlays) {
    if (!/Option 2/i.test(o.text)) continue;
    const span = o.spans.find((x) => /^https?:\/\//.test(x));
    return span ?? (/(https?:\/\/\S+)/.exec(o.text)?.[1] ?? null);
  }
  return null;
}

export const JOURNEYS: JourneyDef[] = [
  {
    id: 'meta_one_hop',
    title: 'Meta ad → / → CTA → /home (one hop)',
    device: 'desktop',
    async run(s, d) {
      const r = base(`${O}/?${buildQuery(all(d))}`);
      await land(s, r, r.landingUrl);
      await clickTo(s, r, CTA_HOME, 'app');
      return r;
    },
  },
  {
    id: 'meta_multi_hop',
    title: 'Meta ad → / → /ai-model/seedance-2-5/ → app (multi hop)',
    device: 'desktop',
    async run(s, d) {
      const r = base(`${O}/?${buildQuery(all(d))}`);
      await land(s, r, r.landingUrl);
      const hop = await clickTo(s, r, [{ sel: 'a[href*="/ai-model/seedance-2-5"]' }, { sel: 'main a[href^="/ai-model/"]' }, { sel: 'a[href^="/ai-model/"]' }], 'marketing_page2');
      if (hop.c.found && !/seedance-2-5/.test(hop.snap.href)) r.notes.push(`deviation: /ai-model/seedance-2-5/ link not found on /, used ${hop.snap.href}`);
      await clickTo(s, r, CTA_ANY, 'app');
      return r;
    },
  },
  {
    id: 'meta_return',
    title: 'Meta ad → /, then a typed /home (return visit)',
    device: 'desktop',
    async run(s, d) {
      const r = base(`${O}/?${buildQuery(all(d))}`);
      await land(s, r, r.landingUrl);
      await jitter(4000, 7000);
      await land(s, r, `${O}/home`, 'app_typed'); // no referrer: typed / bookmarked
      return r;
    },
  },
  {
    id: 'oppref_marketing',
    title: 'ChatGPT ad (oppref) → marketing landing → CTA → app',
    device: 'desktop',
    async run(s, d) {
      const r = base(`${O}/?${buildQuery({ ...d.utm, oppref: d.clickIds.oppref })}`);
      await land(s, r, r.landingUrl);
      await clickTo(s, r, CTA_HOME, 'app');
      return r;
    },
  },
  {
    id: 'gbraid_wbraid',
    title: 'iOS Google ad (gbraid) → / → app, then an app landing with wbraid (+ a later Meta click)',
    device: 'desktop',
    async run(s, d) {
      const r = base(`${O}/?${buildQuery({ ...d.utm, gbraid: d.clickIds.gbraid })}`);
      await land(s, r, r.landingUrl);
      await clickTo(s, r, CTA_HOME, 'app');
      await jitter(4000, 7000);
      const second = `${O}/home?${buildQuery({ ...d.utm, wbraid: d.clickIds.wbraid, fbclid: d.clickIds.fbclid2 })}`;
      await land(s, r, second, 'app_second_click');
      r.clickIds = { ...r.clickIds, wbraid: d.clickIds.wbraid };
      r.notes.push('second landing mirrors research T2c (a later click on another ad rewrites oa_ad_clids)');
      return r;
    },
  },
  {
    id: 'instagram_webview',
    title: 'Instagram in-app browser: / → CTA → /home → sign-in → "Open page in your browser"',
    device: 'instagram',
    async run(s, d) {
      const r = base(`${O}/?${buildQuery({ fbclid: d.clickIds.fbclid, ttclid: d.clickIds.ttclid, utm_source: d.utm.utm_source, utm_campaign: d.utm.utm_campaign })}`);
      await land(s, r, r.landingUrl);
      await clickTo(s, r, CTA_HOME, 'app');
      let h = await inspectHandoff(s);
      for (let attempt = 1; attempt <= 2 && !h.hintCount; attempt++) {
        // open the auth UI only (never submitted); the first click may just dismiss a promo overlay
        await jitter(2000, 4000);
        const c = await s.clickCTA([{ text: '^(Sign up|Sign Up|Sign up for free|Log in|Log In|Login|Sign in|Sign In)$' }], `auth_open_${attempt}`, { expectNavigation: false });
        await s.quiet(3000, 12000, 2000);
        h = await inspectHandoff(s);
        const snap = await s.snapshot(`auth_open_${attempt}`, { click: c, hintCount: h.hintCount });
        r.stepsOrder.push(`auth_open_${attempt}`);
        if (isAppPath(snap.href)) r.appSteps.push(`auth_open_${attempt}`);
      }
      const handoff: HandoffObservation = { hintFound: h.hintCount > 0, overlayOpened: false, overlayUrl: null, locationHref: h.hintCount ? h.href : null, source: 'none' };
      if (h.hintCount) {
        for (const how of [[{ text: '^Open page in your browser', within: 'button span, a span' }, { text: 'Trouble redirecting', within: 'button, a' }], [{ text: 'Trouble redirecting', within: 'button, a' }]]) {
          await jitter(1500, 3000);
          await s.clickCTA(how, 'handoff_overlay', { expectNavigation: false });
          await s.quiet(2000, 6000, 1500);
          const o = await inspectHandoff(s);
          const url = overlayUrl(o.overlays);
          if (url) {
            handoff.overlayOpened = true;
            handoff.overlayUrl = url;
            break;
          }
        }
        await s.snapshot('handoff_overlay', { handoff });
        r.stepsOrder.push('handoff_overlay');
      }
      handoff.source = handoff.overlayUrl ? 'observed-overlay' : handoff.locationHref ? 'inferred-location' : 'none';
      if (!handoff.overlayUrl && handoff.locationHref) handoff.note = 'Overlay did not open; by code Option 2 copies window.location.href (research/01 §T11).';
      r.handoff = handoff;
      return r;
    },
  },
  {
    id: 'ubo_blocked',
    title: 'uBlock Origin defaults: ad URL with every click id → / → CTA → app',
    device: 'desktop',
    ubo: true,
    async run(s, d) {
      const r = base(`${O}/?${buildQuery(all(d))}`);
      await land(s, r, r.landingUrl);
      await clickTo(s, r, CTA_HOME, 'app');
      return r;
    },
  },
  {
    id: 'spa_pageviews',
    title: 'Suite soft navigations (page views per route change) + a generation attempt',
    device: 'desktop',
    async run(s, d) {
      const r = base(`${O}/home?${buildQuery(d.utm)}`);
      r.hardLoadStep = 'hard_load';
      await land(s, r, r.landingUrl, 'hard_load');
      await s.dismissOverlays();
      await s.page.keyboard.press('Escape').catch(() => {});
      const targets = (await s.evaluate<string[]>(SPA_TARGETS)) ?? [];
      const prefer = ['/suite/create-image', '/suite/create-video', '/suite/inspire/feed', '/suite/media', '/suite/brand-kit', '/suite/director/projects'];
      const ordered = [...prefer.filter((p) => targets.some((t) => t === p || t.startsWith(p + '/'))).map((p) => targets.find((t) => t === p) ?? targets.find((t) => t.startsWith(p + '/'))!), ...targets.filter((t) => !prefer.some((p) => t === p || t.startsWith(p + '/')))];
      const picks = Array.from(new Set(ordered)).slice(0, 3);
      r.notes.push(`soft-nav candidates: ${targets.slice(0, 20).join(' ')} → picked ${picks.join(' ')}`);
      r.routeChanges = [];
      for (let i = 0; i < picks.length; i++) {
        const step = `soft${i + 1}`;
        await jitter(3500, 6500);
        const from = s.page.url();
        const navBefore = s.navLog.length;
        const c = await s.clickCTA([{ sel: `a[href="${picks[i]}"]` }], step, { expectNavigation: false });
        await s.quiet(5000, 15000, 2500);
        const events = s.navLog.slice(navBefore).filter((n) => n.step === step);
        const hard = events.filter((e) => e.kind === 'hard');
        const soft = events.filter((e) => e.kind === 'soft');
        const ok = c.found && soft.length > 0 && hard.length === 0;
        r.routeChanges.push({ step, from, to: s.page.url(), method: c.method ?? 'none', historyEvents: events.map((e) => `${e.kind}:${new URL(e.url).pathname}`), ok, note: !c.found ? 'link not found' : hard.length ? 'hard navigation (not a soft route change)' : soft.length ? undefined : 'no history change observed' });
        await s.snapshot(step, { routeChange: r.routeChanges[r.routeChanges.length - 1] });
        r.stepsOrder.push(step);
        r.appSteps.push(step);
      }
      // Generation attempt (anonymous: never reaches a model; any POST is failed by the seal).
      const gen: GenerationObservation = { attempted: false, page: null, typed: false, clicked: false };
      await jitter(3000, 5000);
      if (!/\/suite\/create-image/.test(s.page.url())) {
        const c = await s.clickCTA([{ sel: 'a[href="/suite/create-image"]' }, { sel: 'a[href^="/suite/create-image"]' }], 'to_create', { expectNavigation: false });
        await s.quiet(4000, 12000, 2500);
        if (!c.found) {
          await land(s, r, `${O}/suite/create-image`, 'to_create');
          r.notes.push('create-image link not visible; loaded /suite/create-image directly');
        }
      }
      await s.dismissOverlays();
      s.step = 'generation';
      gen.page = new URL(s.page.url()).pathname;
      // The anonymous sign-up wall sits over the editor: close it (UI only; its fields are never touched).
      const walls: string[] = [];
      for (let i = 0; i < 2; i++) {
        const w = (await s.evaluate<string>(CLOSE_AUTH_WALL)) ?? 'err';
        walls.push(w);
        if (w !== 'closed') break;
        await jitter(800, 1500);
      }
      if (walls[0] === 'no-close-btn') await s.page.keyboard.press('Escape').catch(() => {});
      const prompt = await s.evaluate<{ tag: string; contentEditable: string | null; placeholder: string; inForm: boolean } | null>(FIND_PROMPT);
      if (prompt) {
        try {
          const box = await s.page.$('[data-wd-prompt="1"]');
          await box!.click({ delay: 50 });
          await s.page.keyboard.type('a watercolor fox in the snow', { delay: 70 });
          gen.typed = true;
        } catch (e) {
          gen.note = 'typing failed: ' + (e as Error).message;
        }
        await jitter(1500, 3000);
        const c = await s.clickCTA([{ text: '^Generate\\b', within: 'button' }, { sel: 'form button[type="submit"]' }], 'generation', { expectNavigation: false });
        gen.clicked = c.found;
        gen.attempted = gen.typed || gen.clicked;
        gen.note = `sign-up wall: ${walls.join(' → ')}; prompt ${prompt.tag}${prompt.contentEditable ? '[contenteditable]' : ''} inForm=${prompt.inForm}; Generate ${c.found ? 'clicked via ' + c.method : 'not found'}`;
        await s.quiet(5000, 15000, 2500);
      } else gen.note = `no prompt editor found on ${gen.page} (sign-up wall: ${walls.join(' → ')})`;
      await s.snapshot('generation', { generation: gen });
      r.stepsOrder.push('generation');
      r.appSteps.push('generation');
      r.generation = gen;
      return r;
    },
  },
];

export function toObservation(def: JourneyDef, s: SealedSession, res: JourneyRunResult): Omit<JourneyObservation, 'hits'> {
  return {
    id: def.id,
    title: def.title,
    landingUrl: res.landingUrl,
    clickIds: res.clickIds,
    appSteps: res.appSteps,
    finalStep: res.stepsOrder[res.stepsOrder.length - 1] ?? '',
    stepsOrder: res.stepsOrder,
    requests: s.state.requests,
    snapshots: s.snapshots,
    routeChanges: res.routeChanges,
    hardLoadStep: res.hardLoadStep,
    generation: res.generation,
    handoff: res.handoff,
    pageLoads: s.pageLoads,
    errors: [...res.errors],
    harnessErrors: [...s.state.errors],
    notes: res.notes,
  };
}
