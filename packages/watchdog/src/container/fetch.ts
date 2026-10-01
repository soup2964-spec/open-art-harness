// CONTAINER DIFF inputs: plain GETs of the two public container loaders (the same script requests
// any anonymous page load makes; no cookies, no page, no measurement), plus the Google tag config.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_UA } from '../legacy/sealed_replay.cjs';
import { diffResources, diffSummaryLines, type ResourceDiff } from './diff.js';
import { parseContainerScript } from './parse.js';
import type { ContainerSnapshot } from '../types.js';

export const LOADERS = {
  gtm: 'https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K',
  gateway: 'https://openart.ai/4vu8/',
  gtagConfig: 'https://www.googletagmanager.com/gtag/js?id=AW-11252321380',
};

export const BASELINE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'baselines');

export interface Baseline {
  containerId: string;
  version: string;
  resourceSha256: string;
  capturedAt: string;
  resource: any;
}

export function loadBaseline(file: string): Baseline {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
}

/** Hosts a loader request may be redirected to (the /4vu8/ gateway answers with a redirect to gtm.js). */
const LOADER_HOSTS = /^(www\.googletagmanager\.com|openart\.ai)$/;

export async function fetchLoader(url: string, fetchImpl: typeof fetch = fetch): Promise<{ snapshot: ContainerSnapshot; resource: any | null; bodySha256: string | null }> {
  const fail = (status: number | null, error: string) => ({ snapshot: { url, status, bytes: 0, containerId: null, version: null, resourceSha256: null, error }, resource: null, bodySha256: null });
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetchImpl(current, { headers: { 'user-agent': DESKTOP_UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (res.status < 300 || res.status >= 400) break;
      const next = new URL(res.headers.get('location') ?? '', current);
      if (next.protocol !== 'https:' || !LOADER_HOSTS.test(next.hostname)) return fail(res.status, `redirect to ${next.origin} refused (loader hosts only)`);
      current = next.href;
      res = null;
    }
    if (!res) return fail(null, 'too many redirects');
    if (res.status < 200 || res.status >= 300) return fail(res.status, `HTTP ${res.status}`);
    const body = await res.text();
    const p = parseContainerScript(body);
    return {
      snapshot: { url, status: res.status, bytes: body.length, containerId: p?.containerId ?? null, version: p?.version ?? null, resourceSha256: p?.resourceSha256 ?? null, error: p ? undefined : 'no embedded container data (format changed?)' },
      resource: p?.resource ?? null,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    };
  } catch (e) {
    return fail(null, (e as Error).message);
  }
}

export interface LoaderDiff {
  loader: string;
  snapshot: ContainerSnapshot;
  bodySha256: string | null;
  matchesBaseline: boolean | null;
  /** unavailable = not fetched or not parseable: treated as a change (fail-closed), never as "unchanged". */
  status: 'unchanged' | 'changed' | 'unavailable';
  diff: ResourceDiff | null;
  summary: string[];
}

export interface ContainerReport {
  baseline: { containerId: string; version: string; resourceSha256: string; capturedAt: string };
  loaders: LoaderDiff[];
  loadersAgree: boolean | null;
  /** UNCHANGED only when both loaders and the gtag config match their baselines and agree. */
  state: 'UNCHANGED' | 'CHANGED' | 'UNAVAILABLE';
  /** state !== 'UNCHANGED' (fail-closed: an unreadable container alerts like a changed one). */
  changed: boolean;
  problems: string[];
  gtagConfig?: LoaderDiff & { baseline: { version: string; resourceSha256: string } };
  patched?: { source: string; resourceSha256: string; summary: string[]; diff: ResourceDiff };
  executed: Array<{ url: string; kind: string; version: string | null; resourceSha256Served: string | null; resourceSha256Live: string | null }>;
}

function compare(loader: string, r: Awaited<ReturnType<typeof fetchLoader>>, base: Baseline, knownTags?: Record<string, string>): LoaderDiff {
  if (!r.resource) return { loader, snapshot: r.snapshot, bodySha256: r.bodySha256, matchesBaseline: null, status: 'unavailable', diff: null, summary: [r.snapshot.error ?? 'unavailable'] };
  const diff = diffResources(base.resource, r.resource, knownTags);
  const same = r.snapshot.resourceSha256 === base.resourceSha256;
  return { loader, snapshot: r.snapshot, bodySha256: r.bodySha256, matchesBaseline: same, status: same ? 'unchanged' : 'changed', diff, summary: diffSummaryLines(diff) };
}

export async function containerReport(opts: { baselineFile?: string; gtagBaselineFile?: string; patchedResource?: { source: string; resource: any; resourceSha256: string }; fetchImpl?: typeof fetch }): Promise<ContainerReport> {
  const base = loadBaseline(opts.baselineFile ?? path.join(BASELINE_DIR, 'container_v25.json'));
  const [gtm, gw] = [await fetchLoader(LOADERS.gtm, opts.fetchImpl), await fetchLoader(LOADERS.gateway, opts.fetchImpl)];
  const loaders = [compare('www.googletagmanager.com/gtm.js', gtm, base), compare('openart.ai/4vu8/ (Google tag gateway)', gw, base)];
  const hashes = loaders.map((l) => l.snapshot.resourceSha256).filter(Boolean);
  const loadersAgree = hashes.length === 2 ? hashes[0] === hashes[1] : null;
  const report: ContainerReport = {
    baseline: { containerId: base.containerId, version: base.version, resourceSha256: base.resourceSha256, capturedAt: base.capturedAt },
    loaders,
    loadersAgree,
    state: 'UNCHANGED',
    changed: false,
    problems: [],
    executed: [],
  };
  const gb = opts.gtagBaselineFile ?? path.join(BASELINE_DIR, 'gtag_config_AW-11252321380_v4.json');
  if (fs.existsSync(gb)) {
    const cb = loadBaseline(gb);
    const cfg = await fetchLoader(LOADERS.gtagConfig, opts.fetchImpl);
    report.gtagConfig = { ...compare('www.googletagmanager.com/gtag/js?id=AW-11252321380', cfg, cb, {}), baseline: { version: cb.version, resourceSha256: cb.resourceSha256 } };
  }
  const all = [...loaders, ...(report.gtagConfig ? [report.gtagConfig] : [])];
  for (const l of all) if (l.status !== 'unchanged') report.problems.push(`${l.loader}: ${l.status}${l.status === 'unavailable' ? ' (' + l.summary[0] + ')' : ' — ' + l.summary.slice(0, 3).join('; ')}`);
  if (loadersAgree === false) report.problems.push('gtm.js and the /4vu8/ gateway serve DIFFERENT containers');
  report.state = all.some((l) => l.status === 'changed') || loadersAgree === false ? 'CHANGED' : all.some((l) => l.status === 'unavailable') || loadersAgree === null ? 'UNAVAILABLE' : 'UNCHANGED';
  report.changed = report.state !== 'UNCHANGED';
  if (opts.patchedResource) {
    const diff = diffResources(base.resource, opts.patchedResource.resource);
    report.patched = { source: opts.patchedResource.source, resourceSha256: opts.patchedResource.resourceSha256, summary: diffSummaryLines(diff), diff };
  }
  return report;
}
