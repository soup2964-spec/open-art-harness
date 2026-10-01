// CONVERSION CONTRACT REPLAY under a FULL SEAL, via the proven legacy harness
// (src/legacy/sealed_replay.cjs). The page load itself runs under the collection seal through the
// harness's preSeal hook, so not even the ordinary page-view hits are delivered; then the full seal
// (Fetch fail-all on every target + the proxy refusing everything) is in place before the first
// synthetic event.
import path from 'node:path';
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

export async function runReplay(o: ReplayOptions): Promise<ReplayRun> {
  const preSeal = newInterceptState();
  preSeal.step = 'LOAD';
  const handler = makePausedHandler(preSeal, o.intercept);
  const scenarios = Object.fromEntries(o.scenarios.map((s) => [s.id, { desc: s.desc, code: s.code }]));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const run = await runSealedReplay({
    runName: 'replay',
    pageUrl: o.pageUrl,
    setName: 'watchdog',
    blockedMode: 'fetchonly',
    scenarios,
    scenarioList: o.scenarios.map((s) => s.id),
    needles: { email: o.data.email.split('@')[0]!, txn: 'WD_TEST' },
    profileDir: o.profileDir,
    outFile: path.join(o.rawDir, `run_replay_${stamp}.json`),
    bodiesDir: path.join(o.rawDir, 'script_bodies'),
    screenshotPath: path.join(o.rawDir, 'screens', `replay_${stamp}_preseal.png`),
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
        id: `replay#${i}`, t: c.t, step: c.scenario, url: c.url, method: c.method, resourceType: c.resourceType, postData: c.postData, postDataB64: c.postDataEntriesB64,
        action: 'fail', failResult: c.failRequest, collection, layer: c.layer, networkId: c.networkId,
      } satisfies CapturedRequest;
    });
  const pre = preSeal.requests.map((r) => ({ ...r, step: 'LOAD' }));
  const requests = [...pre, ...post];
  const txnScenario: Record<string, string> = {};
  for (const s of o.scenarios) if (s.context.transaction_id) txnScenario[s.context.transaction_id] = s.id;
  const accounting = analyzeRun(run, { markers: buildMarkers({ email: o.data.email, txnScenario }) });
  const observation: ReplayObservation = {
    page: o.pageUrl,
    scenarios: o.scenarios.map((s) => {
      const t = run.timeline.find((x) => x.scenario === s.id);
      return { id: s.id, desc: s.desc, code: s.code, context: s.context, start: t?.start, end: t?.end, error: t && (t.result as any)?.__exception ? String((t.result as any).__exception).slice(0, 300) : undefined };
    }),
    requests,
    hits: decodeAll(requests),
    source: 'live sealed replay',
    loadStatus: String(run.load?.status ?? ''),
    readiness: (run.readiness as Record<string, unknown> | null) ?? null,
  };
  return { observation, run, preSeal, accounting };
}
