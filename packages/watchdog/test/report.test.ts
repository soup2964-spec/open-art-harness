import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { journeyFromTeardown, replayFromSealed, spaJourneyFromLoggedIn, type LoggedInFixture, type SealedFixture, type TeardownFixture } from '../src/adapters/legacy.js';
import { buildSlackMessage, sendSlack, shouldAlert, slackEscape } from '../src/alert/slack.js';
import { parseArgs } from '../src/cli.js';
import { newInterceptState } from '../src/browser/intercept.js';
import { DEFAULT_CONTRACT_PATH } from '../src/contract.js';
import { renderReport } from '../src/report/html.js';
import type { ReplayBatch, ReplayRun } from '../src/replay/replay.js';
import { assembleResults, firstPartyUnlisted, skipsToErrors, uniqueRequests, type Results } from '../src/run.js';
import { loadContract, evaluateContract } from '../src/contract.js';
import type { Observations } from '../src/types.js';
import { FIXTURES, readJson } from './evidence.js';

const td = (file: string, id: string) => journeyFromTeardown(readJson<TeardownFixture>(path.join(FIXTURES, 'journeys', file + '.json')), id);

function evidenceResults(): Results {
  const obs: Observations = {
    replay: replayFromSealed(readJson<SealedFixture>(path.join(FIXTURES, 'sealed/run_suite.json'))),
    journeys: [
      td('T1a_home_meta', 'meta_one_hop'),
      td('T1f_multipage_meta', 'meta_multi_hop'),
      td('T1g_typed_return_meta', 'meta_return'),
      td('T3a_otherclids', 'oppref_marketing'),
      td('T2c_gbraid_then_app_fbclid', 'gbraid_wbraid'),
      td('T11a_ig_home', 'instagram_webview'),
      { ...td('T7b_ubo_realistic', 'ubo_blocked'), blocker: { engine: 'uBO (T7b)', blocked: 0, strippedParams: [] } },
      spaJourneyFromLoggedIn(readJson<LoggedInFixture>(path.join(FIXTURES, 'loggedin/spa_suite.json')), readJson<LoggedInFixture>(path.join(FIXTURES, 'loggedin/generation.json'))),
    ],
    consentProbes: [],
  };
  return assembleResults({
    target: 'live', startedAt: '2026-09-29T18:00:00.000Z', runTag: 'EVID', chromePath: 'chrome', contractFile: DEFAULT_CONTRACT_PATH, observations: obs, replayRun: null,
    sessions: [], container: { error: 'not fetched in unit test' }, pilot: null, loaders: [], patchEvents: [], patches: {},
    pageLoads: { total: 0, budget: 60, byStage: {} }, journeyRaw: {}, rawRel: 'raw', errors: ['<script>alert(1)</script>'],
  });
}

describe('results + report on the saved evidence', () => {
  const r = evidenceResults();

  it('computes per-platform click-ID coverage the research would predict', () => {
    const meta = r.coverage.find((c) => c.platform === 'meta')!;
    // fbc survives only the one-hop journey among the three Meta journeys (research/01 T1)
    expect(meta.standard.journeys.find((j) => j.id === 'meta_one_hop')!.covered).toBe(true);
    expect(meta.standard.journeys.find((j) => j.id === 'meta_multi_hop')!.covered).toBe(false);
    expect(meta.standard.journeys.find((j) => j.id === 'meta_return')!.covered).toBe(false);
    const google = r.coverage.find((c) => c.platform === 'google_ads')!;
    expect(google.standard.journeys.find((j) => j.id === 'meta_multi_hop')!.covered).toBe(true); // gclaw survives (research/01 T1)
    const openai = r.coverage.find((c) => c.platform === 'openai_ads')!;
    expect(openai.standard.journeys.find((j) => j.id === 'oppref_marketing')!.covered).toBe(false);
    expect(r.summary.coverage.meta).toMatch(/%$/);
  });

  it('renders every section, escapes untrusted strings and never embeds external assets', () => {
    const html = renderReport(r);
    for (const h of ['Contract checks', 'Click-ID coverage', 'Page views per route change', 'Consent', 'Container diff', 'Conversion replay', 'Journeys', 'Zero-leak proof']) expect(html).toContain(`<h2>${h}`);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script\b|<link\b[^>]*stylesheet|src="https?:/i);
    expect(html).toContain('pill fail');
  });

  it('alerts on failing checks and posts only to Slack webhooks', async () => {
    const d = shouldAlert(r);
    expect(d.send).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/contract check/);
    const msg = buildSlackMessage(r, 'https://example.com/report');
    expect(msg.text).toMatch(/fail/);
    const calls: any[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendSlack('https://hooks.slack.com/services/T/B/X', msg, fake)).toEqual({ ok: true, status: 200 });
    expect(calls[0].body.blocks.length).toBeGreaterThan(2);
    await expect(sendSlack('https://evil.example/hook', msg, fake)).rejects.toThrow(/refusing/);
  });

  function green(): Results {
    const g = structuredClone(r);
    g.checks = g.checks.map((c) => ({ ...c, status: 'PASS' as const }));
    g.zeroLeak.status = 'PROVEN';
    g.container = { state: 'UNCHANGED', changed: false, problems: [], loaders: [], loadersAgree: true, baseline: { containerId: 'GTM-56CMP8K', version: '25', resourceSha256: 'x', capturedAt: 'x' }, executed: [] } as any;
    g.run.errors = [];
    g.policy = { firstPartyUnlisted: [] };
    return g;
  }

  it('does not alert on an all-green, unchanged, leak-proven run', () => {
    expect(shouldAlert(green()).send).toBe(false);
  });

  it('fails closed: an unreadable container, run errors or unlisted first-party requests all alert', () => {
    const unavailable = green();
    (unavailable.container as any).state = 'UNAVAILABLE';
    expect(shouldAlert(unavailable).reasons.join(' ')).toMatch(/could not read a loader/);
    const errs = green();
    errs.run.errors = ['journey spa_pageviews crashed'];
    expect(shouldAlert(errs).reasons.join(' ')).toMatch(/run error/);
    const unlisted = green();
    unlisted.policy.firstPartyUnlisted = [{ host: 'openart.ai', path: '/api/new', type: 'Fetch', count: 1, example: 'https://openart.ai/api/new' }];
    expect(shouldAlert(unlisted).reasons.join(' ')).toMatch(/not on the allowlist/);
  });

  it('keeps Slack messages inert and within limits', async () => {
    const bad = structuredClone(r);
    bad.checks = bad.checks.map((c) => ({ ...c, status: 'FAIL' as const, title: '<!channel> ' + c.title, observed: '<https://evil.example|click me> ' + 'x'.repeat(400) }));
    const msg = buildSlackMessage(bad, 'https://example.com/report');
    const json = JSON.stringify(msg);
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<https://evil.example|');
    expect(slackEscape('<!here> & <x|y>')).toBe('&lt;!here&gt; &amp; &lt;x|y&gt;');
    for (const b of msg.blocks as any[]) if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    let init: any = null;
    const fake = (async (_u: string, i: any) => ((init = i), new Response('no', { status: 404 }))) as unknown as typeof fetch;
    expect(await sendSlack('https://hooks.slack.com/services/T/B/X', msg, fake)).toEqual({ ok: false, status: 404 });
    expect(init.redirect).toBe('error');
    await expect(sendSlack('https://hooks.slack.com.evil.example/services/x', msg, fake)).rejects.toThrow(/refusing/);
  });

  it('renders a crafted results.json inertly (CSP without script, coerced numbers, relative links only)', () => {
    const evil = structuredClone(r) as any;
    evil.journeys[0].rawFile = 'javascript:alert(1)';
    evil.journeys[0].pageLoads = '<img src=x onerror=alert(1)>';
    evil.coverage[0].standard.covered = '<b>x</b>';
    const html = renderReport(evil);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('fail-closed result assembly', () => {
  it('turns SKIP into ERROR when the source was requested but produced nothing', () => {
    const contract = loadContract();
    const checks = evaluateContract(contract, { journeys: [], consentProbes: [] });
    const out = skipsToErrors(checks, contract, { replay: true, journeys: ['spa_pageviews'], consentRegions: [] }, ['replay: page crashed']);
    const byId = Object.fromEntries(out.map((c) => [c.id, c]));
    expect(byId['signup.tiktok.event_id']!.status).toBe('ERROR');
    expect(byId['signup.tiktok.event_id']!.observed).toMatch(/requested but not observed.*page crashed/);
    expect(byId['spa.page_views.meta']!.status).toBe('ERROR');
    expect(byId['meta.fbc.multi_hop']!.status).toBe('SKIP'); // not requested: a deliberate SKIP stays SKIP
    expect(byId['consent.eea_uk_ch.defaults']!.status).toBe('SKIP');
  });
  it('lists first-party requests the allowlist failed, collapsed to patterns', () => {
    const base = { t: 0, step: 's', method: 'GET', resourceType: 'Fetch', action: 'fail' as const, collection: false, reason: 'first-party-unlisted' };
    const out = firstPartyUnlisted([
      { ...base, id: 'a', url: 'https://openart.ai/suite/api/user/1234/prefs?x=1' },
      { ...base, id: 'b', url: 'https://openart.ai/suite/api/user/9876/prefs' },
      { ...base, id: 'c', url: 'https://openart.ai/suite/api/ip', reason: 'first-party:fp-suite-api', action: 'allow' as const },
    ]);
    expect(out).toEqual([{ host: 'openart.ai', path: '/suite/api/user/<n>/prefs', type: 'Fetch', count: 2, example: 'https://openart.ai/suite/api/user/1234/prefs' }]);
  });
});

describe('isolated replay result assembly', () => {
  function scenarioRun(id: string, index: number): ReplayRun {
    const start = `2026-10-02T12:00:00.00${index}Z`;
    const end = `2026-10-02T12:00:18.00${index}Z`;
    const readiness = { gtag: index === 0 ? 'function' : 'undefined', worker: index };
    return {
      observation: {
        page: 'https://openart.ai/pricing', source: 'unit test', loadStatus: 'load', readiness,
        scenarios: [{ id, desc: id, code: '', context: {}, start, end, loadStatus: 'load', readiness }],
        requests: [], hits: [],
      },
      run: {
        meta: { runName: `replay-${index}`, outFile: `/private/captures/run_replay-${index}_UNIT.json` },
        load: { status: 'load' }, versions: {}, readiness, seal: {},
        sealProbes: [{ phase: 'before-replay', at: start, result: { worker: index, blocked: true } }],
        wrap: {}, timeline: [], captures: [], net: [], jsTrace: [], console: [], targets: [], final: {}, proxy: {}, teardown: {},
      },
      preSeal: newInterceptState(),
      accounting: {
        summary: {}, decoded: [],
        accounting: Array.from({ length: index + 1 }, () => ({ t: 0, scenario: id, sess: id, type: 'Fetch', method: 'POST', url: 'https://example.invalid/collect', outcome: 'failed', gotNetworkResponse: false })),
        unaccounted: index ? [{ scenario: id }] : [],
        failErrors: index ? [{ url: 'https://example.invalid/collect', err: 'test error' }] : [],
        proxyPostSeal: [{ iso: start, kind: 'CONNECT', target: `${id}.invalid:443`, action: 'deny', class: 'test' }],
        attribution: [{ i: 0, vendor: 'test', hostPath: 'example.invalid/collect', window: id, marker: [id], agree: index === 0 }],
        jsTrace: [], timeline: [], sealProbes: [], markers: { EMAIL_MARKERS: {}, TXN_MARKERS: {} },
      },
    };
  }

  function assemble(replayRun: ReplayRun | ReplayBatch): Results {
    return assembleResults({
      target: 'live', startedAt: '2026-10-02T12:00:00.000Z', runTag: 'UNIT', chromePath: 'chrome', contractFile: DEFAULT_CONTRACT_PATH,
      observations: { replay: replayRun.observation, journeys: [], consentProbes: [] }, replayRun,
      sessions: [], container: { error: 'not fetched in unit test' }, pilot: null, loaders: [], patchEvents: [], patches: {},
      pageLoads: { total: 2, budget: 60, byStage: { replay: 2 } }, journeyRaw: {}, rawRel: 'raw', errors: [],
    });
  }

  it('aggregates all workers, preserves scenario readiness/probes and renders timing with the batch manifest', () => {
    const runs = [scenarioRun('signup', 0), scenarioRun('purchase', 1)];
    const batch: ReplayBatch = {
      mode: 'parallel-isolated', startSpreadMs: 1, runs, rawFile: '/private/captures/run_replay_batch_UNIT.json',
      observation: { ...runs[0]!.observation, scenarios: runs.flatMap((r) => r.observation.scenarios) },
    };
    const results = assemble(batch);
    expect(results.replay).toMatchObject({
      mode: 'parallel-isolated', startSpreadMs: 1, rawFile: 'raw/run_replay_batch_UNIT.json',
      accounting: { postSealRecords: 3, unaccounted: 1, failRequestErrors: 1, attributionDisagreements: 1 },
      readiness: { signup: runs[0]!.run.readiness, purchase: runs[1]!.run.readiness },
      sealProbes: { signup: runs[0]!.run.sealProbes, purchase: runs[1]!.run.sealProbes },
    });
    expect(results.replay!.accounting.proxyPostSeal).toEqual({ signup: runs[0]!.accounting.proxyPostSeal, purchase: runs[1]!.accounting.proxyPostSeal });
    expect(results.replay!.scenarios.map(({ id, start, end }) => ({ id, start, end }))).toEqual(runs.map((r) => {
      const { id, start, end } = r.observation.scenarios[0]!;
      return { id, start, end };
    }));
    const html = renderReport(results);
    expect(html).toContain('All scenarios launch together from a shared barrier');
    expect(html).toContain('Measured spread between the first and last scenario start: 1 ms');
    expect(html).toContain('href="raw/run_replay_batch_UNIT.json"');
    expect(html).not.toContain('/private/captures');
    expect(html).not.toContain('href="raw/run_replay-0_UNIT.json"');
    for (const run of runs) {
      const scenario = run.observation.scenarios[0]!;
      expect(html).toContain(`Started: ${scenario.start}`);
      expect(html).toContain(`Ended: ${scenario.end}`);
    }
  });

  it('keeps historical single-session summaries and reports compatible', () => {
    const run = scenarioRun('signup', 0);
    const results = assemble(run);
    expect(results.replay).not.toHaveProperty('mode');
    expect(results.replay).not.toHaveProperty('startSpreadMs');
    expect(results.replay!.rawFile).toBe('raw/run_replay-0_UNIT.json');
    expect(results.replay!.readiness).toEqual(run.run.readiness);
    expect(results.replay!.sealProbes).toEqual(run.run.sealProbes);
    const html = renderReport(results);
    expect(html).toContain('href="raw/run_replay-0_UNIT.json"');
    expect(html).not.toContain('All scenarios launch together');
    expect(html).not.toContain('Measured spread');
  });
});

describe('cli argument parsing', () => {
  it('parses the documented run command', () => {
    const a = parseArgs(['run', '--target', 'patched', '--patch-container', 'c.json', '--journeys', 'meta_one_hop,spa_pageviews', '--no-replay', '--out=reports/x']);
    expect(a.cmd).toBe('run');
    expect(a.flags).toEqual({ target: 'patched', 'patch-container': 'c.json', journeys: 'meta_one_hop,spa_pageviews', 'no-replay': true, out: 'reports/x' });
  });
  it('rejects malformed input', () => {
    expect(() => parseArgs(['run', '--target'])).toThrow(/needs a value/);
    expect(() => parseArgs(['run', 'stray'])).toThrow(/unexpected/);
  });
});

describe('uniqueRequests', () => {
  it('keeps the target-layer record when the browser layer re-paused the same request', () => {
    const base = { t: 0, step: 's', url: 'u', method: 'GET', resourceType: 'Script', action: 'allow' as const, collection: false };
    const out = uniqueRequests([{ ...base, id: 'a', networkId: '1', layer: 'fetch-target' }, { ...base, id: 'b', networkId: '1', layer: 'fetch-browser' }, { ...base, id: 'c', networkId: null }]);
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
