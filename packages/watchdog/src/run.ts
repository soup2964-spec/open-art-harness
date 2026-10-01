// One watchdog run: seal self-test → container diff → sealed conversion replay → click-ID journeys
// → consent probes → contract evaluation → coverage / consent / zero-leak proof → results.json +
// report.html. Everything live is human-paced and fails every collection request locally.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SealedSession, jitter } from './browser/harness.js';
import type { InterceptOptions, LoaderRecord, PatchEvent, PatchSet } from './browser/intercept.js';
import { GCD_LETTERS, GCD_SOURCE, decodeGcd } from './consent/gcd.js';
import { containerReport, type ContainerReport } from './container/fetch.js';
import { resourceHash } from './container/parse.js';
import { evaluateContract, loadContract, summarize, DEFAULT_CONTRACT_PATH } from './contract.js';
import { JOURNEYS, O, toObservation } from './journeys/journeys.js';
import { containsMarker, makeRunTag, markerNeedles, syntheticData, type SyntheticData } from './markers.js';
import { clickIdPresence, type PlatformClickIdResult } from './observe/clickids.js';
import { coverage, type PlatformCoverage } from './observe/coverage.js';
import { proveAll, type SessionEvidence, type ZeroLeakProof } from './observe/leakproof.js';
import { pageViewReport, type PageViewReport } from './observe/pageviews.js';
import { checkInjectableScript, loadEdgeSim, loadPatchSource } from './patches/patches.js';
import { runPilot } from './pilot.js';
import { allowConnectHost, isFirstPartyHost, type PolicyContext } from './policy/policy.js';
import { runReplay, type ReplayRun } from './replay/replay.js';
import { defaultScenarios, loadScenarios } from './replay/scenarios.js';
import type { CapturedRequest, CheckResult, ConsentProbeObservation, JourneyObservation, Observations, Platform } from './types.js';
import { AD_PLATFORMS } from './types.js';
import { UboEngine } from './ubo/engine.js';
import { decodeAll } from './vendors/decode.js';

export const PACKAGE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DEFAULT_CHROME = process.env.WATCHDOG_CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

export const CONSENT_REGIONS: Record<string, { country: string; region: string; label: string }> = {
  DE: { country: 'DE', region: 'DE-BE', label: 'EEA (Germany)' },
  FR: { country: 'FR', region: 'FR-IDF', label: 'EEA (France)' },
  GB: { country: 'GB', region: 'GB-ENG', label: 'UK' },
  CH: { country: 'CH', region: 'CH-ZH', label: 'Switzerland' },
};

export interface RunOptions {
  target: 'live' | 'patched';
  patchContainer?: string;
  patchGtagConfig?: string;
  injectScript?: string;
  edgeSim?: string;
  journeys?: string[];
  out: string;
  chromePath?: string;
  replay?: boolean;
  replayPage?: string;
  consentRegions?: string[];
  maxPageLoads?: number;
  blocklistsDir?: string;
  scenariosFile?: string;
  contractFile?: string;
  pilot?: boolean;
  log?: (m: string) => void;
}

export interface Results {
  schema: 'openart-signal/watchdog-results@1';
  run: {
    id: string;
    target: 'live' | 'patched';
    startedAt: string;
    finishedAt: string;
    host: string;
    node: string;
    chromePath: string;
    cli: string[];
    runTag: string;
    patches: Record<string, { path: string; sha256: string; resourceSha256?: string } | undefined>;
    pageLoads: { total: number; budget: number; byStage: Record<string, number> };
    contract: string;
    errors: string[];
  };
  summary: { checks: Record<string, number>; containerChanged: boolean; containerState: string; zeroLeak: 'PROVEN' | 'FAILED'; coverage: Record<string, string>; pilot: boolean | null; runErrors: number; firstPartyUnlisted: number };
  /** First-party requests failed because they are not on the allowlist (review: allowlist a read-only API, or add a collection rule). */
  policy: { firstPartyUnlisted: Array<{ host: string; path: string; type: string; count: number; example: string }> };
  checks: CheckResult[];
  coverage: PlatformCoverage[];
  journeys: Array<{
    id: string;
    title: string;
    landingUrl: string;
    clickIds: Record<string, string>;
    stepsOrder: string[];
    appSteps: string[];
    pageLoads: number;
    perPlatform: PlatformClickIdResult[];
    oaAdClidsFinal: unknown;
    pageViews?: PageViewReport;
    generation?: unknown;
    handoff?: unknown;
    blocker?: unknown;
    routeChanges?: unknown;
    notes: string[];
    errors: string[];
    rawFile: string;
    requestCounts: { total: number; allowed: number; failed: number; collection: number };
  }>;
  replay: {
    page: string;
    scenarios: Array<{ id: string; desc: string; source?: string; context: unknown; error?: string; perVendor: Record<string, Array<{ kind: string; event?: string; endpoint: string; transport: string; fields: Record<string, unknown>; clickIds: Record<string, string>; scenarioData: boolean }>> }>;
    loadStatus?: string;
    sealProbes: unknown;
    readiness: unknown;
    rawFile: string;
    accounting: { postSealRecords: number; unaccounted: number; failRequestErrors: number; proxyPostSeal: unknown; attributionDisagreements: number };
  } | null;
  consent: {
    mapping: typeof GCD_LETTERS;
    source: typeof GCD_SOURCE;
    order: string[];
    observed: Array<{ scope: string; hits: number; gcd: Record<string, number>; gcs: Record<string, number>; decoded: unknown; consentCommands: number; geoRewrites?: number }>;
  };
  container: ContainerReport | { error: string };
  patchEvents: PatchEvent[];
  loaders: ExecutedLoader[];
  zeroLeak: ZeroLeakProof;
  pilot: { ok: boolean; expectations: unknown } | null;
}

const sha256File = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export function resolveBlocklists(explicit?: string): string | null {
  const evidenceBlocklists = process.env.OPENART_EVIDENCE_DIR ? path.join(process.env.OPENART_EVIDENCE_DIR, 'crawl', 'teardown2', 'blocklists') : undefined;
  const candidates = [explicit, process.env.WATCHDOG_BLOCKLISTS, path.join(PACKAGE_DIR, 'blocklists'), evidenceBlocklists].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, 'ubo_privacy.txt'))) ?? null;
}

export async function run(o: RunOptions): Promise<Results> {
  const log = o.log ?? ((m: string) => console.log(m));
  const startedAt = new Date().toISOString();
  const outDir = path.resolve(o.out);
  const rawDir = path.join(outDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const chromePath = o.chromePath ?? DEFAULT_CHROME;
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath} (set --chrome or WATCHDOG_CHROME)`);
  const hasPatch = !!(o.patchContainer || o.patchGtagConfig || o.injectScript || o.edgeSim);
  if (o.target === 'live' && hasPatch) throw new Error('--target live cannot take patches; use --target patched');
  if (o.target === 'patched' && !hasPatch) throw new Error('--target patched needs at least one of --patch-container, --patch-gtag-config, --inject-script, --edge-sim');
  // validate everything BEFORE any browser starts (a typo must not cost live page loads)
  const unknownJourneys = (o.journeys ?? []).filter((id) => !JOURNEYS.some((j) => j.id === id));
  if (unknownJourneys.length) throw new Error(`unknown journey(s): ${unknownJourneys.join(', ')} (known: ${JOURNEYS.map((j) => j.id).join(', ')})`);
  const unknownRegions = (o.consentRegions ?? []).filter((r) => !CONSENT_REGIONS[r]);
  if (unknownRegions.length) throw new Error(`unknown consent region(s): ${unknownRegions.join(', ')} (known: ${Object.keys(CONSENT_REGIONS).join(', ')})`);
  if (o.maxPageLoads !== undefined && !(Number.isInteger(o.maxPageLoads) && o.maxPageLoads >= 1 && o.maxPageLoads <= 200)) throw new Error('--max-page-loads must be an integer between 1 and 200');
  for (const f of [o.patchContainer, o.patchGtagConfig, o.injectScript, o.edgeSim, o.scenariosFile, o.contractFile]) if (f && !fs.existsSync(f)) throw new Error(`file not found: ${f}`);
  loadContract(o.contractFile ?? DEFAULT_CONTRACT_PATH);

  // ---- patches (stand-ins for the web-fixes / edge-attribution packages)
  const patches: PatchSet = {};
  if (o.patchContainer) patches.container = loadPatchSource(o.patchContainer);
  if (o.patchGtagConfig) patches.gtagConfig = loadPatchSource(o.patchGtagConfig);
  if (o.injectScript) {
    const text = fs.readFileSync(o.injectScript, 'utf8');
    checkInjectableScript(text);
    patches.injectScript = { path: path.resolve(o.injectScript), text, sha256: createHash('sha256').update(text).digest('hex') };
  }
  if (o.edgeSim) patches.edgeSim = { path: path.resolve(o.edgeSim), module: await loadEdgeSim(o.edgeSim) };
  try {
    return await runSessions(o, { log, startedAt, outDir, rawDir, chromePath, patches });
  } finally {
    await patches.edgeSim?.module.close?.();
  }
}

async function runSessions(o: RunOptions, c: { log: (m: string) => void; startedAt: string; outDir: string; rawDir: string; chromePath: string; patches: PatchSet }): Promise<Results> {
  const { log, startedAt, outDir, rawDir, chromePath, patches } = c;
  const profilesDir = path.join(PACKAGE_DIR, '.profiles');
  const runTag = makeRunTag();
  const data: SyntheticData = syntheticData(runTag);
  const markers = markerNeedles(data);
  const errors: string[] = [];
  const budget = { max: o.maxPageLoads ?? 60, used: 0, byStage: {} as Record<string, number> };
  const spend = (stage: string, n: number) => {
    budget.used += n;
    budget.byStage[stage] = (budget.byStage[stage] ?? 0) + n;
  };

  const policy: PolicyContext = { markers };
  const allowConnect = (h: string, p: number) => allowConnectHost(h, p);
  const intercept = (extra: Partial<PatchSet> = {}, ubo?: UboEngine, cookieHeader?: (url: string) => Promise<string>): InterceptOptions => ({
    policy,
    patches: { ...patches, ...extra },
    ubo,
    isPatchHost: (h) => isFirstPartyHost(h),
    edgeHeaders: { 'cf-ipcountry': 'US', 'cf-connecting-ip': '192.0.2.1' },
    cookieHeader,
  });
  const sessions: SessionEvidence[] = [];
  const loaders: LoaderRecord[] = [];
  const patchEvents: PatchEvent[] = [];
  const observations: Observations = { journeys: [], consentProbes: [] };
  let replayRun: ReplayRun | null = null;

  // ---- 1. seal self-test against a loopback server (nothing leaves the machine)
  let pilot: Results['pilot'] = null;
  if (o.pilot !== false) {
    log('pilot: seal self-test (loopback)');
    const p = await runPilot({ chromePath, profilesDir, log });
    pilot = { ok: p.ok, expectations: p.expectations };
    sessions.push(p.session.evidence('pilot', 'pilot', markers, [/^127\.0\.0\.1$/]));
    if (!p.ok) throw new Error('seal self-test failed — refusing to touch openart.ai: ' + JSON.stringify(p.expectations.filter((e) => !e.ok)));
  }

  // ---- 2. container diff (two script GETs from Node)
  log('container: fetching both loaders');
  let container: Results['container'];
  try {
    const patchedResource = patches.container?.kind === 'resource' ? { source: patches.container.path, resource: patches.container.json.resource ?? patches.container.json, resourceSha256: patches.container.resourceSha256! } : undefined;
    container = await containerReport({ patchedResource });
  } catch (e) {
    container = { error: (e as Error).message };
    errors.push('container: ' + (e as Error).message);
  }
  await jitter(2000, 4000);

  // ---- 3. conversion contract replay under a FULL seal
  if (o.replay !== false) {
    log('replay: sealed conversion replay');
    const scenarios = o.scenariosFile ? loadScenarios(o.scenariosFile) : defaultScenarios(data);
    const rr = await runReplay({
      pageUrl: o.replayPage ?? `${O}/pricing`,
      scenarios,
      data,
      chromePath,
      profileDir: path.join(profilesDir, `replay-${Date.now().toString(36)}`),
      rawDir,
      intercept: intercept(),
      allowConnect,
      log,
    });
    spend('replay', 1);
    observations.replay = rr.observation;
    loaders.push(...rr.preSeal.loaders);
    patchEvents.push(...rr.preSeal.patchEvents);
    errors.push(...rr.preSeal.errors.map((e) => 'replay: ' + e));
    if (rr.run.meta.error) errors.push('replay: ' + String(rr.run.meta.error).split('\n')[0]);
    sessions.push(...replayEvidence(rr, markers));
    replayRun = rr;
    await jitter(5000, 9000);
  }

  // ---- 4. click-ID journeys under the collection seal
  const selected = o.journeys?.length ? JOURNEYS.filter((j) => o.journeys!.includes(j.id)) : JOURNEYS;
  const blocklists = resolveBlocklists(o.blocklistsDir);
  let ubo: UboEngine | undefined;
  const journeyRaw: Record<string, string> = {};
  for (const def of selected) {
    if (budget.used + 3 > budget.max) {
      errors.push(`page-load budget (${budget.max}) reached before journey ${def.id}`);
      break;
    }
    if (def.ubo && !blocklists) {
      errors.push('ubo_blocked skipped: no blocklists (use --blocklists or run scripts/fetch-blocklists.sh)');
      continue;
    }
    if (def.ubo && !ubo) ubo = UboEngine.fromDirectory(blocklists!);
    log(`journey: ${def.id}`);
    let cookieProvider: ((u: string) => Promise<string>) | undefined;
    const s = await SealedSession.launch({
      name: def.id,
      profilesDir,
      chromePath,
      device: def.device,
      captureLoaders: true,
      allowConnect,
      intercept: intercept({}, def.ubo ? ubo : undefined, (u) => cookieProvider?.(u) ?? Promise.resolve('')),
      screenshotsDir: path.join(rawDir, 'screens'),
      log,
    });
    cookieProvider = (u) => s.cookieHeaderFor(u);
    let res;
    try {
      res = await def.run(s, data);
    } catch (e) {
      res = { landingUrl: '', clickIds: {}, stepsOrder: [], appSteps: [], notes: [], errors: [`journey crashed: ${(e as Error).message}`] };
    } finally {
      await s.close();
    }
    const obs: JourneyObservation = { ...toObservation(def, s, res), hits: [] };
    // requests uBlock blocked never leave a real browser: they are not attempted hits
    obs.hits = decodeAll(uniqueRequests(obs.requests).filter((r) => !(r.reason ?? '').startsWith('ubo:')));
    if (def.ubo) obs.blocker = { engine: `uBlock Origin default lists (${path.basename(blocklists!)})`, blocked: s.state.requests.filter((r) => (r.reason ?? '').startsWith('ubo:')).length, strippedParams: s.state.patchEvents.filter((p) => p.what === 'ubo-removeparam').map((p) => p.detail) };
    observations.journeys.push(obs);
    if (patches.injectScript) {
      // the injected block sets a sentinel when it RUNS: a CSP (or a changed page) would block it silently
      const notRun = s.snapshots.filter((x) => isFirstPartyHost(safeHostname(x.href)) && !x.injectSentinel).map((x) => `${x.step} ${safeHostname(x.href)}${new URL(x.href).pathname}`);
      if (notRun.length) errors.push(`${def.id}: --inject-script did not execute on ${notRun.join(', ')} (CSP or injection failure)`);
    }
    spend(def.id, s.pageLoads);
    loaders.push(...s.state.loaders);
    patchEvents.push(...s.state.patchEvents);
    sessions.push(s.evidence(def.id, 'journey', markers));
    const rawFile = path.join(rawDir, `journey_${def.id}.json`);
    fs.writeFileSync(rawFile, JSON.stringify({ journey: obs, navLog: s.navLog, sessions: s.sessionsInfo, net: s.net, heldTargets: s.heldTargets, sealLog: s.sealLog, serviceWorkerVersions: s.serviceWorkerVersions, extraPages: s.extraPages, reportingReports: s.reportingReports, proxy: s.proxySummary, teardown: s.teardown, consoleErrors: s.consoleErrors }, null, 1));
    journeyRaw[def.id] = path.relative(outDir, rawFile);
    await jitter(5000, 10000);
  }

  // ---- 5. consent probes: live Google scripts with the visitor geo rewritten locally
  for (const region of o.consentRegions ?? ['DE', 'GB', 'CH']) {
    const g = CONSENT_REGIONS[region]!;
    if (budget.used + 1 > budget.max) {
      errors.push(`page-load budget reached before consent probe ${region}`);
      break;
    }
    log(`consent probe: ${region}`);
    const s = await SealedSession.launch({ name: `consent_${region}`, profilesDir, chromePath, device: 'desktop', captureLoaders: true, allowConnect, intercept: intercept({ geo: { country: g.country, region: g.region } }), log });
    try {
      await s.goto(`${O}/`, 'landing');
      await s.quiet(6000, 20000, 2500);
      await s.snapshot('landing');
    } finally {
      await s.close();
    }
    const hits = decodeAll(uniqueRequests(s.state.requests));
    const snap = s.snapshots[s.snapshots.length - 1];
    observations.consentProbes.push({ region, country: g.country, subdivision: g.region, page: `${O}/`, hits, consentCommands: snap?.consentCommands ?? [], googleConsentState: snap?.googleConsentState, geoRewrites: s.state.patchEvents.filter((p) => p.what === 'geo').length, geoFetchAttempted: s.state.requests.some((r) => /^https:\/\/www\.google\.com\/ccm\/geo/.test(r.url)), errors: s.state.errors });
    spend(`consent_${region}`, s.pageLoads);
    loaders.push(...s.state.loaders);
    patchEvents.push(...s.state.patchEvents);
    sessions.push(s.evidence(`consent_${region}`, 'consent-probe', markers));
    fs.writeFileSync(path.join(rawDir, `consent_${region}.json`), JSON.stringify({ requests: s.state.requests, net: s.net, snapshots: s.snapshots, loaders: s.state.loaders, patchEvents: s.state.patchEvents, sealLog: s.sealLog, proxy: s.proxySummary, teardown: s.teardown }, null, 1));
    await jitter(4000, 8000);
  }

  // ---- 6. evaluate
  const profilesLeft = fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir) : [];
  if (profilesLeft.length) errors.push(`profiles left behind: ${profilesLeft.join(', ')}`);
  return assembleResults({
    target: o.target,
    startedAt,
    runTag,
    chromePath,
    contractFile: o.contractFile ?? DEFAULT_CONTRACT_PATH,
    observations,
    replayRun,
    sessions,
    container,
    pilot,
    loaders,
    patchEvents,
    patches: {
      container: patches.container && { path: patches.container.path, sha256: patches.container.sha256, resourceSha256: patches.container.resourceSha256 },
      gtagConfig: patches.gtagConfig && { path: patches.gtagConfig.path, sha256: patches.gtagConfig.sha256, resourceSha256: patches.gtagConfig.resourceSha256 },
      injectScript: patches.injectScript && { path: patches.injectScript.path, sha256: patches.injectScript.sha256 },
      edgeSim: patches.edgeSim && { path: patches.edgeSim.path, sha256: sha256File(patches.edgeSim.path) },
    },
    pageLoads: { total: budget.used, budget: budget.max, byStage: budget.byStage },
    journeyRaw,
    rawRel: rawDirRel(outDir, rawDir),
    errors,
    requested: { replay: o.replay !== false, journeys: selected.map((j) => j.id), consentRegions: o.consentRegions ?? ['DE', 'GB', 'CH'] },
  });
}

/** Zero-leak evidence for the replay: the pre-seal page load (collection seal) and the full-seal phase. */
export function replayEvidence(rr: ReplayRun, markers: string[]): SessionEvidence[] {
  const seal = rr.run.seal as Record<string, any>;
  const pre = rr.run.net.filter((n: any) => n.phase === 'pre');
  const preNet = pre
    .filter((n: any) => !/^WebSocket/.test(n.type))
    .map((n: any) => ({ requestId: n.requestId, url: n.url, type: n.type, method: n.method, sess: n.sess, responseReceived: !!n.responseReceived, failed: n.failed, blockedReason: n.blockedReason, servedFromCache: !!n.servedFromCache || !!n.fromDiskCache, fromServiceWorker: !!n.fromSW, initiatorType: n.initiator?.type, initiatorRequestId: n.initiator?.requestId }));
  const preSessions: Array<{ label: string; kind: string; fetch: string }> = seal.preSealSessions ?? [];
  const fetchLayers = {
    browser: seal.preSealBrowserFetch === 'enabled',
    page: preSessions.some((x) => x.label === 'page' && x.fetch === 'enabled'),
    failed: preSessions.filter((x) => x.fetch !== 'enabled' && !(x.kind === 'worker' && /wasn't found/.test(x.fetch))).map((x) => `${x.label}: ${x.fetch}`),
  };
  const teardown = { stillAlive: rr.run.teardown.stillAlive, profileDeleted: rr.run.teardown.profileDeleted, pgrepProfile: rr.run.teardown.pgrepProfile, proxySealedBeforeKill: rr.run.teardown.proxySealedBeforeKill };
  const common = { markers, heldTargets: seal.heldTargets ?? [], serviceWorkerVersions: seal.swVersions ?? [], extraPages: seal.extraPages ?? [], reportingReports: seal.reportingReports ?? [] };
  const responsesAfterSeal = rr.run.net.filter((n: any) => n.phase === 'post' && n.responseAfterSeal && !/^(data|blob):/.test(n.url)).length;
  return [
    {
      id: 'replay-load', kind: 'replay (pre-seal page load)', requests: rr.preSeal.requests, net: preNet, proxy: { ...rr.run.proxy, postSealAllowed: 0 }, teardown, fetchLayers,
      webSockets: pre.filter((n: any) => n.type === 'WebSocket(created)').map((n: any) => ({ url: n.url })), ...common,
    },
    {
      id: 'replay-sealed', kind: 'replay (full seal)', requests: rr.observation.requests.filter((r) => r.step !== 'LOAD'), net: [], netNotApplicable: true, proxy: { ...rr.run.proxy, tunnelledHosts: [] }, teardown,
      fetchLayers: {
        browser: seal.browserFetch === 'enabled',
        page: (seal.sessions ?? []).some((x: any) => x.label === 'page' && x.fetch === 'enabled'),
        failed: (seal.sessions ?? []).filter((x: any) => x.fetch && x.fetch !== 'enabled' && !/wasn't found/.test(x.fetch)).map((x: any) => `${x.label}: ${x.fetch}`),
      },
      webSockets: rr.run.net.filter((n: any) => n.phase === 'post' && n.type === 'WebSocket(created)').map((n: any) => ({ url: n.url })), ...common,
      legacy: { unaccounted: rr.accounting.unaccounted.length, failRequestErrors: rr.accounting.failErrors.length, postSealAllowed: rr.run.proxy.postSealAllowed, responsesAfterSeal },
    },
  ];
}

export interface AssembleInput {
  target: 'live' | 'patched';
  startedAt: string;
  runTag: string;
  chromePath: string;
  contractFile: string;
  observations: Observations;
  replayRun: ReplayRun | null;
  sessions: SessionEvidence[];
  container: Results['container'];
  pilot: Results['pilot'];
  loaders: LoaderRecord[];
  patchEvents: PatchEvent[];
  patches: Results['run']['patches'];
  pageLoads: Results['run']['pageLoads'];
  journeyRaw: Record<string, string>;
  rawRel: string;
  errors: string[];
  /** What the run was asked to observe: a check whose requested source produced nothing is ERROR, not SKIP. */
  requested?: { replay: boolean; journeys: string[]; consentRegions: string[] };
}

/** SKIP is only legitimate for sources the run was not asked to observe. */
export function skipsToErrors(checks: CheckResult[], contract: { checks: Array<{ id: string; source: { replay?: string; journey?: string; consentProbes?: string[] } }> }, requested: NonNullable<AssembleInput['requested']>, errors: string[]): CheckResult[] {
  return checks.map((c) => {
    if (c.status !== 'SKIP') return c;
    const src = contract.checks.find((k) => k.id === c.id)?.source;
    const wanted = (src?.replay && requested.replay) || (src?.journey && requested.journeys.includes(src.journey)) || (src?.consentProbes ?? []).some((r) => requested.consentRegions.includes(r));
    if (!wanted) return c;
    const why = errors.find((e) => (src?.replay && /^replay/.test(e)) || (src?.journey && e.includes(src.journey)) || (src?.consentProbes && /consent/.test(e)));
    return { ...c, status: 'ERROR', observed: `requested but not observed (${c.observed}${why ? '; ' + why : ''})` };
  });
}

/** Distinct first-party request patterns the allowlist failed (IDs collapsed, no query strings). */
export function firstPartyUnlisted(requests: CapturedRequest[]): Results['policy']['firstPartyUnlisted'] {
  const m = new Map<string, Results['policy']['firstPartyUnlisted'][number]>();
  for (const r of requests) {
    if (r.reason !== 'first-party-unlisted') continue;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    const pattern = u.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/<id>').replace(/\/\d+(?=\/|$)/g, '/<n>');
    const key = `${u.hostname} ${r.resourceType} ${pattern}`;
    const e = m.get(key) ?? { host: u.hostname, path: pattern, type: r.resourceType, count: 0, example: u.origin + u.pathname };
    e.count++;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** Pure: observations + evidence -> results.json (used by run() and by the unit tests). */
export function assembleResults(a: AssembleInput): Results {
  const contract = loadContract(a.contractFile);
  const evaluated = evaluateContract(contract, a.observations);
  const checks = a.requested ? skipsToErrors(evaluated, contract, a.requested, a.errors) : evaluated;
  const unlisted = firstPartyUnlisted(a.sessions.flatMap((x) => x.requests));
  const cov = coverage(a.observations.journeys);
  const zeroLeak = proveAll(a.sessions);
  const container = a.container;
  if (container && 'loaders' in container) container.executed = dedupeLoaders(a.loaders);
  const results: Results = {
    schema: 'openart-signal/watchdog-results@1',
    run: {
      id: `${a.startedAt.replace(/[:.]/g, '-')}-${a.runTag}`,
      target: a.target,
      startedAt: a.startedAt,
      finishedAt: new Date().toISOString(),
      host: process.env.WATCHDOG_RECORD_HOST === '1' ? os.hostname() : 'not recorded',
      node: process.version,
      chromePath: path.basename(a.chromePath),
      cli: process.argv.slice(2),
      runTag: a.runTag,
      patches: Object.fromEntries(Object.entries(a.patches).map(([k, v]) => [k, v && { ...v, path: repoRelative(v.path) }])),
      pageLoads: a.pageLoads,
      contract: path.relative(PACKAGE_DIR, a.contractFile),
      errors: a.errors,
    },
    summary: {
      checks: summarize(checks),
      containerChanged: container && 'changed' in container ? container.changed : true,
      containerState: container && 'state' in container ? container.state : 'ERROR',
      zeroLeak: zeroLeak.status,
      coverage: Object.fromEntries(cov.map((c) => [c.platform, c.standard.pct === null ? 'n/a' : `${c.standard.pct}%`])),
      pilot: a.pilot ? a.pilot.ok : null,
      runErrors: a.errors.length,
      firstPartyUnlisted: unlisted.length,
    },
    policy: { firstPartyUnlisted: unlisted },
    checks,
    coverage: cov,
    journeys: a.observations.journeys.map((j) => journeySummary(j, a.journeyRaw[j.id] ?? '')),
    replay: replaySummary(a.observations, a.replayRun, a.rawRel),
    consent: consentSummary(a.observations),
    container,
    patchEvents: a.patchEvents,
    loaders: dedupeLoaders(a.loaders),
    zeroLeak,
    pilot: a.pilot,
  };
  return results;
}

export interface ExecutedLoader {
  url: string;
  kind: string;
  version: string | null;
  resourceSha256Served: string | null;
  resourceSha256Live: string | null;
}

/** Allowed requests are paused twice (target layer, then browser layer): keep one record per network id. */
export function uniqueRequests<T extends { networkId?: string | null; layer?: string; id: string }>(reqs: T[]): T[] {
  const byNet = new Map<string, T>();
  const out: T[] = [];
  for (const r of reqs) {
    if (!r.networkId) {
      out.push(r);
      continue;
    }
    const prev = byNet.get(r.networkId);
    if (!prev) {
      byNet.set(r.networkId, r);
      out.push(r);
    } else if (prev.layer === 'fetch-browser' && r.layer === 'fetch-target') {
      out[out.indexOf(prev)] = r;
      byNet.set(r.networkId, r);
    }
  }
  return out;
}

function safeHostname(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

/** Paths in results.json are repository-relative (no user names / home directories). */
function repoRelative(p: string): string {
  const repo = path.resolve(PACKAGE_DIR, '..', '..');
  const abs = path.resolve(p);
  return abs.startsWith(repo + path.sep) ? path.relative(repo, abs) : path.basename(abs);
}

function rawDirRel(outDir: string, rawDir: string) {
  return path.relative(outDir, rawDir);
}

function dedupeLoaders(ls: LoaderRecord[]): ExecutedLoader[] {
  const seen = new Map<string, LoaderRecord>();
  for (const l of ls) {
    const k = `${l.url.split('?')[0]}|${l.resourceSha256Served}`;
    if (!seen.has(k)) seen.set(k, l);
  }
  return [...seen.values()].map((l) => ({ url: l.url, kind: l.kind, version: l.version, resourceSha256Served: l.resourceSha256Served, resourceSha256Live: l.resourceSha256Live }));
}

function journeySummary(j: JourneyObservation, rawFile: string): Results['journeys'][number] {
  const last = j.snapshots[j.snapshots.length - 1];
  let oa: unknown = null;
  try {
    oa = last?.localStorage?.oa_ad_clids ? JSON.parse(last.localStorage.oa_ad_clids) : null;
  } catch {
    oa = last?.localStorage?.oa_ad_clids ?? null;
  }
  const req = uniqueRequests(j.requests);
  return {
    id: j.id,
    title: j.title,
    landingUrl: j.landingUrl,
    clickIds: j.clickIds,
    stepsOrder: j.stepsOrder,
    appSteps: j.appSteps,
    pageLoads: j.pageLoads,
    perPlatform: clickIdPresence(j),
    oaAdClidsFinal: oa,
    pageViews: j.routeChanges ? pageViewReport(j, [...AD_PLATFORMS.filter((p) => p !== 'openai_ads'), 'amplitude'] as Platform[]) : undefined,
    generation: j.generation,
    handoff: j.handoff,
    blocker: j.blocker,
    routeChanges: j.routeChanges,
    notes: j.notes,
    errors: j.errors,
    rawFile,
    requestCounts: { total: req.length, allowed: req.filter((r) => r.action === 'allow').length, failed: req.filter((r) => r.action === 'fail').length, collection: req.filter((r) => r.collection).length },
  };
}

function replaySummary(obs: Observations, rr: ReplayRun | null, rawRel: string): Results['replay'] {
  if (!obs.replay || !rr) return null;
  const byScenario = obs.replay.scenarios.map((s) => {
    const perVendor: Record<string, any[]> = {};
    const reqById = new Map(obs.replay!.requests.map((q) => [q.id, q]));
    const needles = Object.values(s.context).filter((v): v is string => typeof v === 'string' && v.length >= 6);
    for (const h of obs.replay!.hits.filter((x) => x.step === s.id)) {
      const q = reqById.get(h.requestId);
      // scenarioData: the request carried this scenario's synthetic values (vs. background SDK traffic in the same window)
      const scenarioData = !!q && needles.length > 0 && (containsMarker(q.url, needles) || containsMarker(q.postData ?? '', needles) || (q.postDataB64 ?? []).some((b) => containsMarker(Buffer.from(b, 'base64').toString('latin1'), needles)));
      (perVendor[h.platform === 'other' ? h.vendor : h.platform] ??= []).push({ kind: h.kind, event: h.eventName, endpoint: h.endpoint, transport: h.transport, fields: h.fields, clickIds: h.clickIds, scenarioData });
    }
    return { id: s.id, desc: s.desc, context: s.context, error: s.error, perVendor };
  });
  return {
    page: obs.replay.page,
    loadStatus: obs.replay.loadStatus,
    scenarios: byScenario,
    sealProbes: rr.run.sealProbes,
    readiness: rr.run.readiness,
    rawFile: path.join(rawRel, path.basename(rr.run.meta.outFile)),
    accounting: {
      postSealRecords: rr.accounting.accounting.length,
      unaccounted: rr.accounting.unaccounted.length,
      failRequestErrors: rr.accounting.failErrors.length,
      proxyPostSeal: rr.accounting.proxyPostSeal,
      attributionDisagreements: rr.accounting.attribution.filter((a: any) => !a.agree).length,
    },
  };
}

function consentSummary(obs: Observations): Results['consent'] {
  const scopes: Array<{ scope: string; hits: any[]; commands: number; geo?: number }> = [];
  const journeyHits = obs.journeys.flatMap((j) => j.hits);
  scopes.push({ scope: 'journeys (US vantage, live geo)', hits: journeyHits, commands: obs.journeys.reduce((n, j) => n + j.snapshots.reduce((m, s) => m + (s.consentCommands?.length ?? 0), 0), 0) });
  if (obs.replay) scopes.push({ scope: 'replay page load + scenarios', hits: obs.replay.hits, commands: 0 });
  for (const p of obs.consentProbes) scopes.push({ scope: `probe ${p.region} (${p.country}/${p.subdivision}, geo rewritten locally)`, hits: p.hits, commands: p.consentCommands.length, geo: p.geoRewrites });
  return {
    mapping: GCD_LETTERS,
    source: GCD_SOURCE,
    order: ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'],
    observed: scopes.map((s) => {
      const g = s.hits.filter((h: any) => h.consent);
      const gcd: Record<string, number> = {};
      const gcs: Record<string, number> = {};
      for (const h of g) {
        gcd[h.consent.gcd ?? '(none)'] = (gcd[h.consent.gcd ?? '(none)'] ?? 0) + 1;
        gcs[h.consent.gcs ?? '(absent)'] = (gcs[h.consent.gcs ?? '(absent)'] ?? 0) + 1;
      }
      const top = Object.entries(gcd).sort((a, b) => b[1] - a[1])[0]?.[0];
      return { scope: s.scope, hits: g.length, gcd, gcs, decoded: top && top !== '(none)' ? decodeGcd(top) : null, consentCommands: s.commands, geoRewrites: s.geo };
    }),
  };
}

export { resourceHash };
