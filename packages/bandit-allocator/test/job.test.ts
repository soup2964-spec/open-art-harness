import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AllocationLog, constantAllocationLog, type AllocationLogRow } from '../src/allocation-log.js';
import {
  BigQueryRowSource,
  buildComment,
  demoAllocationLog,
  demoRows,
  JsonlRowSource,
  loadAllocatorConfig,
  loadFlagSnapshots,
  main,
  runAllocation,
  validateAllocatorConfig,
  type AllocatorConfig,
  type TargetResult,
} from '../src/job.js';
import { applySemanticPatch, rolloutUnitsByArm, type LdFlag, type LdHttpRequest, type SemanticInstruction } from '../src/launchdarkly.js';
import type { ExperimentProfitByArmRow } from '../src/warehouse.js';

const IMG = 'suite-default-model-create-image';
const VID = 'suite-default-model-create-video';
const HOLDOUT_RULE: Record<string, string> = { [IMG]: '9d7c1a20-0b4e-4f6a-8c11-1a0000000001', [VID]: '8e6b2c31-1c5f-4a7b-9d22-2a0000000001' };
const SEGMENT_RULES = new Set([
  '9d7c1a20-0b4e-4f6a-8c11-1a0000000002',
  '9d7c1a20-0b4e-4f6a-8c11-1a0000000003',
  '8e6b2c31-1c5f-4a7b-9d22-2a0000000002',
  '8e6b2c31-1c5f-4a7b-9d22-2a0000000003',
]);
const RUN_DATE = '2026-08-01'; // the fixture cohort signs up 2026-06-01 .. 2026-07-31

let rows: ExperimentProfitByArmRow[];
let flags: Record<string, LdFlag>;
let config: AllocatorConfig;
let log: AllocationLog;

/** The fixture cohort is small (2,000 users), so the test config lowers the sample minimums. */
function smallCohortConfig(over: Partial<AllocatorConfig> = {}): AllocatorConfig {
  return {
    ...config,
    guardrails: {
      ...config.guardrails,
      minSamplesPerArm: 50,
      minimumDetectableEffect: 100, // the MDE requirement falls below the 50-user floor
      minExpectedLossToMove: 0,
      stopLoss: { ...config.guardrails.stopLoss, minControlSamples: 30, minArmSamples: 30 },
    },
    guardrailMetrics: { ...config.guardrailMetrics, minTreatmentN: 30, minControlN: 30 },
    ...over,
  };
}
const DIRECT: AllocatorConfig['approvals'] = { mode: 'direct', notifyMemberIds: [], notifyTeamKeys: [] };

beforeAll(() => {
  flags = loadFlagSnapshots(new URL('../fixtures/flags/', import.meta.url));
  config = loadAllocatorConfig(new URL('../fixtures/allocator.config.json', import.meta.url));
  rows = demoRows();
  log = demoAllocationLog(config, rows);
});

function instructionsOf(run: ReturnType<typeof runAllocation>, flagKey: string): SemanticInstruction[] {
  const f = run.flags.find((x) => x.flagKey === flagKey)!;
  const body = f.request?.body as { instructions: SemanticInstruction[] } | undefined;
  return body?.instructions ?? [];
}

const scale = (r: ExperimentProfitByArmRow, k: number): ExperimentProfitByArmRow => {
  const out: Record<string, unknown> = { ...r };
  for (const [key, v] of Object.entries(r)) if (typeof v === 'number' && key !== 'exposure_date') out[key] = v * k;
  return out as unknown as ExperimentProfitByArmRow;
};

describe('runAllocation on the fixture cohort', () => {
  it('patches the existing segment rules of both flags, never the holdout rule', () => {
    const run = runAllocation({ rows, flags, config: smallCohortConfig({ approvals: DIRECT }), runDate: RUN_DATE, allocationLog: log });
    for (const flagKey of [IMG, VID]) {
      const f = run.flags.find((x) => x.flagKey === flagKey)!;
      expect(f.status, f.reasons.join('; ')).toBe('patch');
      expect(f.request!.method).toBe('PATCH');
      const ins = instructionsOf(run, flagKey);
      expect(ins.length).toBeGreaterThan(0);
      for (const i of ins) {
        expect(['updateFallthroughVariationOrRollout', 'updateRuleVariationOrRollout']).toContain(i.kind);
        if (i.kind === 'updateRuleVariationOrRollout') {
          expect(SEGMENT_RULES.has(i.ruleId)).toBe(true);
          expect(i.ruleId).not.toBe(HOLDOUT_RULE[flagKey]);
        }
        if ('rolloutWeights' in i) expect(Object.values(i.rolloutWeights).reduce((a, b) => a + b, 0)).toBe(100_000);
      }
      const after = applySemanticPatch(flags[flagKey]!, 'production', ins);
      for (const t of f.targets.filter((x) => x.instruction)) {
        const where = t.ruleId ? after.environments.production!.rules.find((r) => r._id === t.ruleId)! : after.environments.production!.fallthrough;
        expect([...rolloutUnitsByArm(after, where, t.arms).units.values()]).toEqual(t.proposedUnits);
      }
      expect(after.environments.production!.rules[0]).toEqual(flags[flagKey]!.environments.production!.rules[0]);
    }
  });

  it('routes segments like LaunchDarkly does: first matching rule, the rest to the fallthrough', () => {
    const run = runAllocation({ rows, flags, config: smallCohortConfig(), runDate: RUN_DATE, allocationLog: log });
    const f = run.flags.find((x) => x.flagKey === IMG)!;
    const byName = new Map(f.targets.map((t) => [t.name, t]));
    expect(byName.get('us')!.segments.every((s) => s.startsWith('us|'))).toBe(true);
    expect(byName.get('tier1')!.segments.every((s) => s.startsWith('tier1|'))).toBe(true);
    expect(byName.get('fallthrough')!.segments.every((s) => s.startsWith('rest|') || s.startsWith('unknown|'))).toBe(true);
    expect(byName.get('fallthrough')!.segments.length).toBeGreaterThan(0);
  });

  it('uses the flag-specific approval endpoint when approvals are on (the default config)', () => {
    const direct = runAllocation({ rows, flags, config: smallCohortConfig({ approvals: DIRECT }), runDate: RUN_DATE, allocationLog: log });
    const approval = runAllocation({ rows, flags, config: smallCohortConfig(), runDate: RUN_DATE, allocationLog: log });
    const f = approval.flags.find((x) => x.flagKey === IMG)!;
    expect(f.request!.method).toBe('POST');
    expect(f.request!.url).toBe(`https://app.launchdarkly.com/api/v2/projects/default/flags/${IMG}/environments/production/approval-requests`);
    const body = f.request!.body as { description: string; instructions: SemanticInstruction[]; notifyTeamKeys: string[] };
    expect(body.instructions).toEqual(instructionsOf(direct, IMG));
    expect(body.notifyTeamKeys).toEqual(['growth-data']);
    expect(body.description).toContain(RUN_DATE);
  });

  it('writes a comment that explains the change and stays short', () => {
    const run = runAllocation({ rows, flags, config: smallCohortConfig({ approvals: DIRECT }), runDate: RUN_DATE, allocationLog: log });
    const comment = (run.flags.find((x) => x.flagKey === IMG)!.request!.body as { comment: string }).comment;
    expect(comment).toContain('openart-signal bandit-allocator');
    expect(comment).toContain(RUN_DATE);
    expect(comment).toContain('reward=decomposed_profit');
    expect(comment).toContain('holdout rule untouched');
    expect(comment).toContain('env version 28');
    expect(comment).toMatch(/always-valid stop-loss/);
    expect(comment).toMatch(/->/);
    expect(comment.length).toBeLessThanOrEqual(1000);
  });

  it('explains every weight, the SRM checks and the value per conversion in the report', () => {
    const run = runAllocation({ rows, flags, config: smallCohortConfig(), runDate: RUN_DATE, allocationLog: log });
    for (const flagKey of [IMG, VID]) expect(run.report).toContain(`## ${flagKey}`);
    for (const arm of ['nano-banana-pro', 'gpt-image-2-5', 'byte-plus-seedance-2-5', 'wan3-0']) expect(run.report).toContain(arm);
    expect(run.report).toMatch(/P\(best\)/);
    expect(run.report).toMatch(/Expected loss/);
    expect(run.report).toMatch(/re-bucketed/);
    expect(run.report).toMatch(/SRM fallthrough vs logged weights/);
    expect(run.report).toMatch(/Holdout share of exposures: \d+\.\d% vs expected 9\.7%/);
    expect(run.report).toMatch(/Value per conversion V: \$\d+/);
    expect(run.report).toMatch(/Guardrail vs holdout/);
  });

  it('with production settings (MDE $2) nothing on 2,000 users reaches the minimum sample, and the report says so', () => {
    const run = runAllocation({ rows, flags, config, runDate: RUN_DATE, allocationLog: log });
    for (const flagKey of [IMG, VID]) {
      const f = run.flags.find((x) => x.flagKey === flagKey)!;
      expect(f.status).toBe('no_change');
      expect(f.request).toBeNull();
      for (const t of f.targets) {
        expect(t.decision.status).toBe('held');
        expect(t.decision.requiredN).toBeGreaterThan(1000);
      }
    }
    expect(run.report).toMatch(/minimum sample size not met: nano-banana-pro has \d+ effective users < \d{4}/);
    expect(run.alerts).toEqual([]);
  });

  it('is deterministic for a run date and seed', () => {
    const a = runAllocation({ rows, flags, config: smallCohortConfig(), runDate: RUN_DATE, allocationLog: log });
    const b = runAllocation({ rows, flags, config: smallCohortConfig(), runDate: RUN_DATE, allocationLog: log });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('flag-level safety checks', () => {
  const withEnv = (flag: LdFlag, mutate: (env: LdFlag['environments'][string], flag: LdFlag) => void): LdFlag => {
    const copy = structuredClone(flag);
    mutate(copy.environments.production!, copy);
    return copy;
  };
  const one = (over: { flags?: Record<string, LdFlag>; rows?: ExperimentProfitByArmRow[]; config?: AllocatorConfig; log?: AllocationLog | null }, flagKey = IMG) =>
    runAllocation({ rows: over.rows ?? rows, flags: over.flags ?? flags, config: over.config ?? smallCohortConfig(), runDate: RUN_DATE, allocationLog: over.log === undefined ? log : over.log }).flags.find((x) => x.flagKey === flagKey)!;

  it('holds a flag whose holdout rule is missing and emits the one-time setup instead', () => {
    const f = one({ flags: { ...flags, [IMG]: withEnv(flags[IMG]!, (env) => env.rules.shift()) } });
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/holdout rule/);
    expect(f.setupInstructions[0]!.kind).toBe('addRule');
    expect(f.request).toBeNull();
  });

  it('refuses a rollout that is a LaunchDarkly Experimentation rollout', () => {
    const f = one({ flags: { ...flags, [IMG]: withEnv(flags[IMG]!, (env) => void (env.fallthrough.rollout!.seed = 42)) } });
    expect(f.status).toBe('error');
    expect(f.reasons.join(' ')).toMatch(/Experimentation/);
  });

  it('refuses when a variation the allocator does not manage still has traffic', () => {
    const extra = withEnv(flags[IMG]!, (env, flag) => {
      flag.variations.push({ _id: '5b1e0c3a-6f2d-4c1b-9e7a-0a0000000009', value: 'legacy-model', name: 'Legacy' });
      env.fallthrough.rollout!.variations = [
        { variation: 0, weight: 40_000 },
        { variation: 1, weight: 20_000 },
        { variation: 2, weight: 20_000 },
        { variation: 3, weight: 10_000 },
        { variation: 4, weight: 10_000 },
      ];
    });
    const f = one({ flags: { ...flags, [IMG]: extra } });
    expect(f.status).toBe('error');
    expect(f.reasons.join(' ')).toMatch(/not managed/);
  });

  it('refuses a segment rule that sits above the holdout rule (it would bypass the holdout)', () => {
    const swapped = withEnv(flags[IMG]!, (env) => {
      const [holdout, us, ...rest] = env.rules;
      env.rules = [us!, holdout!, ...rest];
    });
    const f = one({ flags: { ...flags, [IMG]: swapped } });
    expect(f.status).toBe('error');
    expect(f.reasons.join(' ')).toMatch(/above the holdout/);
  });

  it('holds a flag that is switched off', () => {
    const f = one({ flags: { ...flags, [IMG]: withEnv(flags[IMG]!, (env) => void (env.on = false)) } });
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/off/);
  });

  it('differential scoring coverage across arms holds the flag (fail closed, alert)', () => {
    const partial = rows.map((r) => (r.flag_key === VID && r.arm === 'wan3-0' && r.exposed_users >= 2 ? { ...r, exposed_users: r.exposed_users * 2 } : r));
    const f = one({ rows: partial }, VID);
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/scoring coverage/);
    expect(f.alerts.join(' ')).toMatch(/scoring coverage/);
  });
});

describe('finding 2: SRM fails CLOSED, on every slice, against the LOGGED weights', () => {
  const one = (over: { rows?: ExperimentProfitByArmRow[]; config?: AllocatorConfig; log?: AllocationLog | null }, flagKey = IMG) => {
    const run = runAllocation({ rows: over.rows ?? rows, flags, config: over.config ?? smallCohortConfig(), runDate: RUN_DATE, allocationLog: over.log === undefined ? log : over.log });
    return { run, f: run.flags.find((x) => x.flagKey === flagKey)! };
  };

  it('a sample-ratio mismatch in the holdout holds the flag, with no patch and an alert', () => {
    const skewed = rows.map((r) => (r.flag_key === IMG && r.allocation_slice === 'holdout' && r.arm === 'nano-banana-pro' ? scale(r, 3) : r));
    const { run, f } = one({ rows: skewed });
    expect(f.status).toBe('held');
    expect(f.request).toBeNull();
    expect(f.reasons.join(' ')).toMatch(/sample-ratio mismatch in the holdout/);
    expect(f.checks.srm!.targets.find((t) => t.target === 'holdout')!.pValue).toBeLessThan(0.001);
    expect(run.alerts.join(' ')).toMatch(/SRM alarm/);
  });

  it('a sample-ratio mismatch in a BANDIT target is caught too (not just the holdout)', () => {
    const skewed = rows.map((r) => (r.flag_key === IMG && r.allocation_slice === 'bandit' && r.country_bucket === 'us' && r.arm === 'gpt-image-2' ? scale(r, 3) : r));
    const { f } = one({ rows: skewed });
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/sample-ratio mismatch in target "us" vs the logged weights/);
  });

  it('compares against the weights that were LOGGED on each exposure day, not the current flag snapshot', () => {
    // The snapshot's fallthrough is 40/20/20/20 while the cohort was served 25% each: no alarm.
    expect(one({}).f.checks.srm!.alarms).toEqual([]);
    // A log that claims 70/10/10/10 was served in the US rule is contradicted by the data.
    const lying: AllocationLogRow[] = [];
    const dates = [...new Set(rows.filter((r) => r.flag_key === IMG).map((r) => r.exposure_date))];
    const equal = { 'nano-banana-pro': 25_000, 'gpt-image-2-5': 25_000, 'nano-banana-2': 25_000, 'gpt-image-2': 25_000 };
    lying.push(...constantAllocationLog({ dates, flagKey: IMG, targets: { us: { 'nano-banana-pro': 70_000, 'gpt-image-2-5': 10_000, 'nano-banana-2': 10_000, 'gpt-image-2': 10_000 }, tier1: equal, fallthrough: equal, holdout: equal } }));
    lying.push(...constantAllocationLog({ dates, flagKey: VID, targets: { us: { 'byte-plus-seedance-2': 33_334, 'byte-plus-seedance-2-5': 33_333, 'wan3-0': 33_333 } } }));
    const { f } = one({ log: new AllocationLog(lying) });
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/target "us" vs the logged weights/);
  });

  it('gates the holdout share: hex context keys would put 37.5% of users in the holdout, not 9.7%', () => {
    const hex = smallCohortConfig({ srm: { ...config.srm, holdoutKeyAlphabet: 'hex' } });
    const { f } = one({ config: hex });
    expect(f.checks.srm!.holdoutShare!.expectedShare).toBeCloseTo(6 / 16, 12);
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/holdout share .* vs the 37\.5% the key predicate should match/);
  });

  it('holds (fail closed) when the SRM check cannot be evaluated: no holdout slice', () => {
    const { run, f } = one({ rows: rows.filter((r) => r.allocation_slice === 'bandit') });
    expect(f.status).toBe('held');
    expect(f.request).toBeNull();
    expect(f.reasons.join(' ')).toMatch(/SRM check not evaluable \(fail closed\): no holdout exposures/);
    expect(run.alerts.length).toBeGreaterThan(0);
  });

  it('holds (fail closed) without an allocation log', () => {
    const { f } = one({ log: null });
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/no allocation log/);
  });

  it('holds (fail closed) when the rows lack the guardrail columns', () => {
    const bare = rows.map((r) => ({ ...r, activated_users: null, generations_24h: null, failed_generations_24h: null }));
    const { f } = one({ rows: bare });
    expect(f.status).toBe('held');
    expect(f.reasons.join(' ')).toMatch(/guardrail metrics need the columns/);
  });

  it('a non-profit guardrail breach (activation vs the holdout) stops the arm and raises an alert', () => {
    // No bandit user on gpt-image-2 activates, while holdout users do.
    const broken = rows.map((r) => (r.flag_key === IMG && r.arm === 'gpt-image-2' && r.allocation_slice === 'bandit' ? { ...r, activated_users: 0 } : r));
    const { run, f } = one({ rows: broken, config: smallCohortConfig({ approvals: DIRECT }) });
    const us = f.targets.find((t) => t.name === 'us')!;
    const arm = us.decision.arms.find((a) => a.arm === 'gpt-image-2')!;
    expect(arm.stopped).toBe(true);
    expect(arm.reasons.join(' ')).toMatch(/guardrail: activation/);
    expect(us.guardrails.find((g) => g.arm === 'gpt-image-2' && g.metric === 'activation')!.breach).toMatch(/activation/);
    expect(run.alerts.join(' ')).toMatch(/gpt-image-2 stopped/);
  });
});

describe('finding 3: resets on model / promo changes', () => {
  it('ignores exposure days before the latest reset and says so', () => {
    const reset = smallCohortConfig({ resets: [{ date: '2026-07-10', flagKey: IMG, reason: 'nano-banana-pro model update' }] });
    const run = runAllocation({ rows, flags, config: reset, runDate: RUN_DATE, allocationLog: log });
    const img = run.flags.find((x) => x.flagKey === IMG)!;
    const vid = run.flags.find((x) => x.flagKey === VID)!;
    expect(img.notes.join(' ')).toMatch(/reset on 2026-07-10/);
    expect(vid.notes.join(' ')).not.toMatch(/reset/);
    const before = runAllocation({ rows, flags, config: smallCohortConfig(), runDate: RUN_DATE, allocationLog: log }).flags.find((x) => x.flagKey === IMG)!;
    const users = (f: typeof img) => f.targets.find((t) => t.name === 'us')!.decision.arms[0]!.rewardUsers;
    expect(users(img)).toBeLessThan(users(before));
  });
});

describe('finding 6: TypeScript robustness', () => {
  it('rejects infeasible guardrails at config load (cap below the floor; floors over 100%)', () => {
    expect(() => validateAllocatorConfig({ ...config, guardrails: { ...config.guardrails, minExplorationShare: 0.2, warmStartShare: 0.2, maxDailyChange: 0.1 } })).toThrow(/projection infeasible/);
    expect(() => validateAllocatorConfig({ ...config, guardrails: { ...config.guardrails, minExplorationShare: 0.3, warmStartShare: 0.3, maxDailyChange: 0.3 } })).toThrow(/exceeds 100%/);
  });

  it('one flag failing internally does not lose the other flags', () => {
    const broken = structuredClone(flags[IMG]!);
    broken.environments.production!.rules[1]!.rollout!.variations[0]!.variation = 99; // no such variation
    const run = runAllocation({ rows, flags: { ...flags, [IMG]: broken }, config: smallCohortConfig({ approvals: DIRECT }), runDate: RUN_DATE, allocationLog: log });
    const img = run.flags.find((x) => x.flagKey === IMG)!;
    expect(img.status).toBe('error');
    expect(img.reasons.join(' ')).toMatch(/internal error: .*variation index 99/);
    expect(run.flags.find((x) => x.flagKey === VID)!.status).toBe('patch');
    expect(run.alerts.join(' ')).toMatch(new RegExp(`${IMG}: internal error`));
  });

  it('the change comment compares INTEGER units, so an unchanged 29% arm is not reported as a move', () => {
    const t = {
      name: 'fallthrough',
      ruleId: null,
      arms: ['a', 'b'],
      segments: [],
      currentUnits: [29_000, 71_000],
      proposedUnits: [29_000, 71_000],
      reassignedShare: 0,
      guardrails: [],
      instruction: { kind: 'updateFallthroughVariationOrRollout', rolloutWeights: {} },
      decision: { arms: [{ arm: 'a', currentWeight: 0.29, proposedUnits: 29_000, stopped: false, pBest: 0.4, phase: 'mature' }, { arm: 'b', currentWeight: 0.71, proposedUnits: 71_000, stopped: false, pBest: 0.6, phase: 'mature' }] },
    } as unknown as TargetResult;
    expect(0.29 * 100_000).not.toBe(29_000); // the float comparison the old code made
    const comment = buildComment(IMG, { targets: [t], envVersion: 1 }, config, RUN_DATE);
    expect(comment).not.toMatch(/a 29\.0%->29\.0%/);
  });
});

describe('row sources', () => {
  it('reads JSONL rows (with the optional column groups) and validates them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bandit-rows-'));
    const path = join(dir, 'rows.jsonl');
    writeFileSync(path, rows.slice(0, 5).map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(await new JsonlRowSource(path).load()).toEqual(rows.slice(0, 5));
  });

  it('queries BigQuery with parameters (no string interpolation of values) through an injected client', async () => {
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    const fake = {
      async query(opts: { query: string; params: Record<string, unknown> }) {
        calls.push(opts);
        const r = rows[0]!;
        return [[{ ...r, exposure_date: { value: r.exposure_date }, exposed_users: String(r.exposed_users), matured_users: String(r.matured_users) }]] as [unknown[]];
      },
    };
    const source = new BigQueryRowSource(fake, 'openart-analytics.marts.fct_experiment_profit_by_arm');
    const out = await source.load({ runDate: RUN_DATE, lookbackDays: 365 });
    expect(out).toEqual([rows[0]]);
    expect(calls[0]!.params).toEqual({ run_date: RUN_DATE, lookback_days: 365 });
    expect(calls[0]!.query).toContain('@run_date');
    expect(calls[0]!.query).toContain('matured_users');
    expect(calls[0]!.query).toContain('`openart-analytics.marts.fct_experiment_profit_by_arm`');
    expect(() => new BigQueryRowSource(fake, 'x`; DROP TABLE y; --')).toThrow(/table/);
  });
});

describe('CLI', () => {
  it('runs the demo end to end in dry-run mode and writes the report and requests', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bandit-job-'));
    const lines: string[] = [];
    await main(['--demo', '--min-samples', '50', '--mde', '100', '--out', out], { log: (s) => lines.push(s), env: {} });
    const report = readFileSync(join(out, `report-${RUN_DATE}.md`), 'utf8');
    const requests = JSON.parse(readFileSync(join(out, `requests-${RUN_DATE}.json`), 'utf8')) as unknown[];
    expect(report).toContain('DRY RUN');
    expect(requests.length).toBe(2);
    expect(lines.join('\n')).toContain('DRY RUN: this LaunchDarkly request was NOT sent');
    expect(demoRows().length).toBe(rows.length);
  });

  it('finding 6a: rejects a --min-samples that is NaN, 0, negative or fractional, and a non-positive --mde', async () => {
    for (const bad of ['abc', '0', '-5', '12.5', '']) {
      await expect(main(['--demo', '--min-samples', bad], { log: () => undefined, env: {} })).rejects.toThrow(/--min-samples must be a positive integer/);
    }
    await expect(main(['--demo', '--mde', '0'], { log: () => undefined, env: {} })).rejects.toThrow(/--mde must be a positive number/);
  });

  it('finding 6e: writes the report BEFORE the live submit, so a failed write is still on record', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bandit-live-'));
    const sent: LdHttpRequest[] = [];
    const transport = {
      async send(req: LdHttpRequest) {
        sent.push(req);
        if (req.method === 'GET') {
          const key = decodeURIComponent(new URL(req.url).pathname.split('/').pop()!);
          return { status: 200, body: flags[key] };
        }
        return { status: 500, body: { message: 'LaunchDarkly is down' } };
      },
    };
    const env = { LD_ALLOCATOR_ALLOW_LIVE_WRITES: 'yes-write-to-launchdarkly', LD_API_TOKEN: 'test-token' };
    await expect(main(['--demo', '--mode', 'live', '--min-samples', '50', '--mde', '100', '--out', out], { log: () => undefined, env, transport })).rejects.toThrow(/500/);
    expect(existsSync(join(out, `report-${RUN_DATE}.md`))).toBe(true);
    expect(existsSync(join(out, `requests-${RUN_DATE}.json`))).toBe(true);
    expect(sent.some((r) => r.method !== 'GET')).toBe(true);
  });

  it('prints the one-time setup (holdout rule, then segment rules) without needing warehouse rows', async () => {
    const lines: string[] = [];
    expect(await main(['--setup'], { log: (l) => lines.push(l), env: {} })).toBeNull();
    expect(lines.filter((l) => l.includes('setup already applied')).length).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'bandit-flags-'));
    for (const [key, flag] of Object.entries(flags)) {
      const bare = structuredClone(flag);
      bare.environments.production!.rules = [];
      writeFileSync(join(dir, `${key}.json`), JSON.stringify(bare));
    }
    const setup: string[] = [];
    await main(['--setup', '--flags', dir], { log: (l) => setup.push(l), env: {} });
    const text = setup.join('\n');
    expect(text).toContain('DRY RUN: this LaunchDarkly request was NOT sent');
    expect((text.match(/approval-requests/g) ?? []).length).toBe(2);
    expect((text.match(/"kind": "addRule"/g) ?? []).length).toBe(6);
  });

  it('refuses live mode without the explicit environment switch', async () => {
    await expect(main(['--demo', '--mode', 'live'], { log: () => undefined, env: {} })).rejects.toThrow(/LD_ALLOCATOR_ALLOW_LIVE_WRITES/);
  });
});
