// Page-view attempts per platform per route change (SPA soft navigation), after collapsing
// transport copies of one event (see DecodedHit.dedupeKey).
import type { DecodedHit, JourneyObservation, Platform } from '../types.js';
import { distinctEvents } from '../vendors/decode.js';

export interface StreamCounts {
  total: number;
  streams: Record<string, number>;
  examples: string[];
}

export interface RouteCounts {
  step: string;
  to: string;
  historyEvents: string[];
  /** A clean soft route change (link found, history change, no hard navigation). */
  ok: boolean;
  note?: string;
  counts: Record<string, StreamCounts>;
}

/** Google destinations that count as a page-view stream (tid-less pings such as ae=g do not). */
export const GOOGLE_DESTINATION = /^(AW|G|GT|DC)-[A-Za-z0-9]+$/;

export interface PageViewReport {
  hardLoad: Record<string, StreamCounts> | null;
  routes: RouteCounts[];
}

function count(hits: DecodedHit[], platforms: Platform[]): Record<string, StreamCounts> {
  const out: Record<string, StreamCounts> = {};
  for (const p of platforms) {
    const ev = distinctEvents(hits.filter((h) => h.platform === p && h.kind === 'page_view'));
    const streams: Record<string, number> = {};
    for (const h of ev) {
      const s = p === 'google_ads' ? h.stream ?? 'google-tag' : 'default';
      streams[s] = (streams[s] ?? 0) + 1;
    }
    out[p] = { total: ev.length, streams, examples: ev.slice(0, 4).map((h) => `${h.endpoint} ${h.eventName ?? ''} ${h.pageUrl ? new URL(h.pageUrl, 'https://openart.ai').pathname : ''}`.trim()) };
  }
  return out;
}

export function pageViewReport(j: JourneyObservation, platforms: Platform[]): PageViewReport {
  const hardLoad = j.hardLoadStep ? count(j.hits.filter((h) => h.step === j.hardLoadStep), platforms) : null;
  const routes = (j.routeChanges ?? []).map((rc) => ({
    step: rc.step,
    to: rc.to,
    historyEvents: rc.historyEvents,
    ok: rc.ok,
    note: rc.note,
    counts: count(j.hits.filter((h) => h.step === rc.step), platforms),
  }));
  return { hardLoad, routes };
}

/**
 * Exactly one page view per route change: for Google Ads, per destination stream seen on the hard
 * load (the Google tag sends one page_view per destination); for every other platform, in total.
 * Fail-closed: a route that was not a clean soft navigation is never dropped silently, and without
 * a reference (the platform's tag produced no page view on the hard load) nothing can be certified.
 *   FAIL  when any clean soft route has the wrong count (a definitive finding);
 *   ERROR when no route can be evaluated, the reference is missing, or a route was not clean;
 *   PASS  only when every route was a clean soft navigation with exactly the expected count.
 */
export function exactlyOnePerRoute(report: PageViewReport, platform: Platform, exactly = 1): { status: 'PASS' | 'FAIL' | 'ERROR'; perRoute: Array<{ step: string; observed: string; ok: boolean; invalid?: boolean }>; reason?: string } {
  const ref = report.hardLoad?.[platform];
  const expectedStreams = platform === 'google_ads' ? Object.keys(ref?.streams ?? {}).filter((x) => GOOGLE_DESTINATION.test(x)) : ['default'];
  const perRoute = report.routes.map((r) => {
    const c = r.counts[platform];
    if (!r.ok) return { step: r.step, observed: `not a clean soft navigation (${r.note ?? 'unknown'})`, ok: false, invalid: true };
    if (platform === 'google_ads') {
      const seen = Object.keys(c?.streams ?? {}).filter((x) => GOOGLE_DESTINATION.test(x));
      const ok = expectedStreams.length > 0 && expectedStreams.every((x) => (c?.streams[x] ?? 0) === exactly) && seen.every((x) => expectedStreams.includes(x));
      const observed = [...new Set([...expectedStreams, ...seen])].map((x) => `${x}: ${c?.streams[x] ?? 0}`).join(', ') || '0';
      return { step: r.step, observed, ok };
    }
    const n = c?.total ?? 0;
    return { step: r.step, observed: String(n), ok: n === exactly };
  });
  if (!report.hardLoad) return { status: 'ERROR', perRoute, reason: 'no hard-load reference step' };
  if (platform === 'google_ads' ? !expectedStreams.length : !(ref?.total ?? 0)) return { status: 'ERROR', perRoute, reason: `no ${platform} page view on the hard load (tag not loaded?) — nothing to compare route changes against` };
  const clean = perRoute.filter((x) => !x.invalid);
  if (!clean.length) return { status: 'ERROR', perRoute, reason: 'no clean soft navigation observed' };
  if (clean.some((x) => !x.ok)) return { status: 'FAIL', perRoute };
  if (perRoute.some((x) => x.invalid)) return { status: 'ERROR', perRoute, reason: 'the clean routes pass, but not every route was a clean soft navigation' };
  return { status: 'PASS', perRoute };
}
