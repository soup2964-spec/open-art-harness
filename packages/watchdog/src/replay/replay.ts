// CONVERSION CONTRACT REPLAY under a FULL SEAL, via the proven legacy harness
// (src/legacy/sealed_replay.cjs). The page load itself runs under the collection seal through the
// harness's preSeal hook, so not even the ordinary page-view hits are delivered; then the full seal
// (Fetch fail-all on every target + the proxy refusing everything) is in place before the first
// synthetic event.
import path from 'node:path';
import fs from 'node:fs';
import { analyzeRun, buildMarkers } from '../legacy/decode.cjs';
import { runSealedReplay, type SealedRun } from '../legacy/sealed_replay.cjs';
import { fetchPatterns, makePausedHandler, newInterceptState, type InterceptOptions, type InterceptState } from '../browser/intercept.js';
import { IGNORED_DEFAULT_ARGS, QUIET_CHROME_FLAGS, SEALED_PROFILE_PREFS, envChromeArgs } from '../browser/harness.js';
import { SEAL_INIT } from '../browser/pagejs.js';
import { classifyCollection } from '../policy/policy.js';
import type { CapturedRequest, ReplayObservation } from '../types.js';
import { decodeAll } from '../vendors/decode.js';
import type { SyntheticData } from '../markers.js';
import type { ReplayScenario } from './scenarios.js';

export interface ReplayOptions {
  pageUrl: string;
  scenarios: ReplayScenario[];
  data: SyntheticData;
  chromePath: string;
  profileDir: string;
  rawDir: string;
  intercept: InterceptOptions;
  allowConnect: (host: string, port: number) => boolean;
  log: (m: string) => void;
}

export interface ReplayRun {
  observation: ReplayObservation;
  run: SealedRun;
  preSeal: InterceptState;
  accounting: ReturnType<typeof analyzeRun>;
}

export interface ReplayBatch {
  mode: 'parallel-isolated';
  observation: ReplayObservation;
  runs: ReplayRun[];
  rawFile: string;
  startSpreadMs: number | null;
}

/** Prepare one sealed browser per scenario, then release every scenario together. */
export async function runReplay(o: ReplayOptions): Promise<ReplayBatch> {
  if (!o.scenarios.length || new Set(o.scenarios.map((s) => s.id)).size !== o.scenarios.length || o.scenarios.some((s) => !s.id)) {
    throw new Error('replay requires non-empty, unique scenario IDs');
  }
  let arrived = 0;
  let release!: (error: Error | null) => void;
  // Resolve with an error instead of rejecting: a worker can fail before any other worker waits.
  const gate = new Promise<Error | null>((resolve) => { release = resolve; });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const settled = await Promise.allSettled(o.scenarios.map(async (scenario, index) => {
    let reachedBarrier = false;
    try {
      const rr = await runSingleReplay({ ...o, scenarios: [scenario], profileDir: `${o.profileDir}-${index}` }, `replay-${index}`, async () => {
        reachedBarrier = true;
        if (++arrived === o.scenarios.length) release(null);
        const error = await gate;
        if (error) throw error;
      });
      if (!reachedBarrier || rr.run.meta.error) throw new Error(rr.run.meta.error || `scenario ${scenario.id} failed before the launch barrier`);
      return rr;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      release(error);
      throw error;
    }
  }));
  // Every worker tears down its sealed browser before a failed batch is surfaced.
  const failure = settled.find((r) => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const runs = settled.map((r) => (r as PromiseFulfilledResult<ReplayRun>).value);
  const scenarios = runs.flatMap((r) => r.observation.scenarios);
  const starts = scenarios.flatMap((s) => s.start ? [Date.parse(s.start)] : []);
  const startSpreadMs = starts.length === scenarios.length && starts.every(Number.isFinite) ? Math.max(...starts) - Math.min(...starts) : null;
  const observation: ReplayObservation = {
    page: o.pageUrl,
    scenarios,
    requests: runs.flatMap((r) => r.observation.requests),
    hits: runs.flatMap((r) => r.observation.hits),
    source: 'parallel isolated sealed replay',
    loadStatus: runs.every((r) => r.observation.loadStatus === 'load') ? 'load' : 'one or more scenario pages failed to load',
  };
  const rawFile = path.join(o.rawDir, `run_replay_batch_${stamp}.json`);
  fs.mkdirSync(o.rawDir, { recursive: true });
  fs.writeFileSync(rawFile, JSON.stringify({ mode: 'parallel-isolated', startSpreadMs, scenarios: scenarios.map((s, i) => ({ ...s, rawFile: path.relative(o.rawDir, runs[i]!.run.meta.outFile) })) }, null, 2));
  return { mode: 'parallel-isolated', observation, runs, rawFile, startSpreadMs };
}

async function runSingleReplay(o: ReplayOptions, runName: string, beforeReplay: () => Promise<void>): Promise<ReplayRun> {
  const preSeal = newInterceptState();
  preSeal.step = 'LOAD';
  const handler = makePausedHandler(preSeal, o.intercept);
  const scenarios = Object.fromEntries(o.scenarios.map((s) => [s.id, { desc: s.desc, code: s.code }]));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const run = await runSealedReplay({
    runName,
    pageUrl: o.pageUrl,
    setName: 'watchdog',
    blockedMode: 'fetchonly',
    scenarios,
    scenarioList: o.scenarios.map((s) => s.id),
    needles: { email: o.data.email.split('@')[0]!, txn: 'WD_TEST' },
    profileDir: o.profileDir,
    outFile: path.join(o.rawDir, `run_${runName}_${stamp}.json`),
    bodiesDir: path.join(o.rawDir, 'script_bodies'),
    screenshotPath: path.join(o.rawDir, 'screens', `${runName}_${stamp}_preseal.png`),
    beforeReplay,
    scenarioGapMs: 0,
    tailMs: 18000,
    chromePath: o.chromePath,
    extraArgs: [...QUIET_CHROME_FLAGS, ...envChromeArgs()],
    profilePrefs: SEALED_PROFILE_PREFS,
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    allowConnect: o.allowConnect,
    preSeal: {
      patterns: fetchPatterns({ patches: o.intercept.patches, captureLoaders: true }),
      initScript: SEAL_INIT,
      handler: async (session, e, ctx) => {
        if (e.frameId && e.resourceType === 'Document' && !preSeal.mainFrameIds.size) preSeal.mainFrameIds.add(e.frameId);
        await handler(session, e, ctx.layer, ctx.label);
      },
    },
    log: o.log,
  });

  // Post-seal captures (every one was Fetch.failRequest'ed by the legacy seal) + pre-seal decisions.
  const post: CapturedRequest[] = run.captures
    .filter((c: any) => !/^SEALTEST/.test(c.scenario))
    .map((c: any, i: number) => {
      let collection = false;
      try {
        collection = !!classifyCollection(new URL(c.url), c.method, c.resourceType);
      } catch {
        /* unparseable */
      }
      return {
        id: `${runName}#${i}`, t: c.t, step: c.scenario === 'TAIL' ? o.scenarios[0]!.id : c.scenario, url: c.url, method: c.method, resourceType: c.resourceType, postData: c.postData, postDataB64: c.postDataEntriesB64,
        action: 'fail', failResult: c.failRequest, collection, layer: c.layer, networkId: c.networkId,
      } satisfies CapturedRequest;
    });
  const pre = preSeal.requests.map((r) => ({ ...r, id: `${runName}:load:${r.id}`, step: 'LOAD' }));
  const requests = [...pre, ...post];
  const txnScenario: Record<string, string> = {};
  for (const s of o.scenarios) if (s.context.transaction_id) txnScenario[s.context.transaction_id] = s.id;
  const accounting = analyzeRun(run, { markers: buildMarkers({ email: o.data.email, txnScenario }) });
  const observation: ReplayObservation = {
    page: o.pageUrl,
    scenarios: o.scenarios.map((s) => {
      const t = run.timeline.find((x) => x.scenario === s.id);
      return { id: s.id, desc: s.desc, code: s.code, context: s.context, start: t?.start, end: t?.end, loadStatus: String(run.load?.status ?? ''), readiness: run.readiness ?? null, error: t && (t.result as any)?.__exception ? String((t.result as any).__exception).slice(0, 300) : undefined };
    }),
    requests,
    hits: decodeAll(requests),
    source: 'live sealed replay',
    loadStatus: String(run.load?.status ?? ''),
    readiness: (run.readiness as Record<string, unknown> | null) ?? null,
  };
  return { observation, run, preSeal, accounting };
}
