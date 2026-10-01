import { describe, expect, it } from 'vitest';
import { AllocationLog, type AllocationLogRow } from '../src/allocation-log.js';
import { DEFAULT_GUARDRAIL_METRICS, estimateFlag, type EstimateOptions } from '../src/estimate.js';
import { DEFAULT_GUARDRAILS } from '../src/thompson.js';
import { addDays, parseExperimentProfitRows, type ExperimentProfitByArmRow } from '../src/warehouse.js';

const FLAG = 'suite-default-model-create-image';
const RUN = '2026-09-21';

/** One row of `n` users with the given score mean/sd (scored = exposed; components keep the identity). */
function row(date: string, arm: string, slice: 'holdout' | 'bandit', n: number, mean: number, sd = 5, extra: Partial<ExperimentProfitByArmRow> = {}): ExperimentProfitByArmRow {
  const sum = n * mean;
  return {
    exposure_date: date,
    flag_key: FLAG,
    arm,
    country_bucket: 'us',
    device: 'desktop',
    acquisition_channel: 'google_cpc',
    allocation_slice: slice,
    exposed_users: n,
    scored_users: n,
    converted_users: 0,
    sum_predicted_profit: sum,
    sum_sq_predicted_profit: n * (sd * sd + mean * mean),
    sum_predicted_revenue: Math.max(0, sum) + 10 * n,
    sum_predicted_generation_cost: 10 * n + Math.max(0, -sum),
    sum_predicted_fees: 0,
    sum_predicted_refund_risk: 0,
    model_version: 'score-v1',
    ...extra,
  };
}

function options(log: AllocationLogRow[], over: Partial<EstimateOptions> = {}): EstimateOptions {
  return {
    flagKey: FLAG,
    arms: ['a', 'b'],
    targets: [{ name: 'fallthrough', match: null }],
    runDate: RUN,
    lookbackDays: 56,
    halfLifeDays: null,
    sequentialWindowDays: 365,
    epochStart: null,
    reward: 'predicted_profit',
    cuped: false,
    valuePerConversionFallback: null,
    prior: { meanPseudoCount: 1, variancePseudoCount: 2 },
    shrinkageStrength: 50,
    guardrails: DEFAULT_GUARDRAILS,
    guardrailMetrics: { ...DEFAULT_GUARDRAIL_METRICS, enabled: false },
    log: new AllocationLog(log),
    ...over,
  };
}

/**
 * 20 days. Everyone earns 10 on days 1-10 and 20 on days 11-20 (a shared trend, e.g. a promo).
 * The bandit gave arm a 10% of its slice early and 90% late; the holdout stays 50/50.
 */
function trendScenario() {
  const rows: ExperimentProfitByArmRow[] = [];
  const log: AllocationLogRow[] = [];
  for (let d = 0; d < 20; d += 1) {
    const date = addDays(RUN, -20 + d);
    const late = d >= 10;
    const mean = late ? 20 : 10;
    const wa = late ? 0.9 : 0.1;
    rows.push(row(date, 'a', 'bandit', Math.round(1000 * wa), mean), row(date, 'b', 'bandit', Math.round(1000 * (1 - wa)), mean));
    rows.push(row(date, 'a', 'holdout', 50, mean), row(date, 'b', 'holdout', 50, mean));
    log.push(
      { date, flag_key: FLAG, target: 'fallthrough', arm: 'a', weight_units: Math.round(100_000 * wa) },
      { date, flag_key: FLAG, target: 'fallthrough', arm: 'b', weight_units: 100_000 - Math.round(100_000 * wa) },
      { date, flag_key: FLAG, target: 'holdout', arm: 'a', weight_units: 50_000 },
      { date, flag_key: FLAG, target: 'holdout', arm: 'b', weight_units: 50_000 },
    );
  }
  return { rows: parseExperimentProfitRows(rows), log };
}

describe('finding 3: non-stationarity', () => {
  it('IPW with the logged weights removes the time-trend confounding a pooled mean suffers when the bandit shifts traffic', () => {
    const { rows, log } = trendScenario();
    const pooledMean = (arm: string) => {
      const mine = rows.filter((r) => r.arm === arm);
      return mine.reduce((s, r) => s + r.sum_predicted_profit, 0) / mine.reduce((s, r) => s + r.scored_users, 0);
    };
    expect(pooledMean('a') - pooledMean('b')).toBeGreaterThan(7); // pure confounding: the arms are identical
    const est = estimateFlag(rows, options(log));
    const [a, b] = est.targets[0]!.arms;
    expect(a!.weightedMean).toBeCloseTo(15, 6);
    expect(b!.weightedMean).toBeCloseTo(15, 6);
    expect(Math.abs(a!.posterior.kind === 'normal' ? a!.posterior.nig.mu - 15 : 99)).toBeLessThan(0.05);
  });

  it('the Kish effective sample size charges for unequal weights (and equals n when weights are equal)', () => {
    const { rows, log } = trendScenario();
    const a = estimateFlag(rows, options(log)).targets[0]!.arms[0]!;
    const raw = rows.filter((r) => r.arm === 'a').reduce((s, r) => s + r.scored_users, 0);
    expect(a.rewardUsers).toBe(raw);
    expect(a.effectiveN).toBeLessThan(raw);
    const flat = [row(addDays(RUN, -1), 'a', 'bandit', 500, 3), row(addDays(RUN, -1), 'b', 'bandit', 500, 3)];
    const flatLog: AllocationLogRow[] = [
      { date: addDays(RUN, -1), flag_key: FLAG, target: 'fallthrough', arm: 'a', weight_units: 50_000 },
      { date: addDays(RUN, -1), flag_key: FLAG, target: 'fallthrough', arm: 'b', weight_units: 50_000 },
    ];
    expect(estimateFlag(flat, options(flatLog)).targets[0]!.arms[0]!.effectiveN).toBeCloseTo(500, 9);
  });

  it('a 14-21 day half-life weights recent days more: the estimate follows a drifting arm', () => {
    const { rows, log } = trendScenario();
    const decayed = estimateFlag(rows, options(log, { halfLifeDays: 1 })).targets[0]!.arms[0]!;
    expect(decayed.weightedMean!).toBeGreaterThan(19); // dominated by the late (20) days
    const flat = estimateFlag(rows, options(log)).targets[0]!.arms[0]!;
    expect(flat.weightedMean!).toBeCloseTo(15, 6);
  });

  it('a score-model change resets the 24h-score reward to the latest model', () => {
    const { rows, log } = trendScenario();
    const mixed = rows.map((r) => (r.exposure_date < addDays(RUN, -5) ? { ...r, model_version: 'score-v0' } : r));
    const est = estimateFlag(mixed, options(log));
    expect(est.notes.join(' ')).toMatch(/score model changed \(score-v0 -> score-v1\)/);
    expect(est.targets[0]!.arms[0]!.rewardUsers).toBeLessThan(estimateFlag(rows, options(log)).targets[0]!.arms[0]!.rewardUsers);
  });

  it('a stopped arm (0% of the bandit slice) keeps its stop-loss evidence growing from holdout users, so it can recover', () => {
    const rows: ExperimentProfitByArmRow[] = [];
    const log: AllocationLogRow[] = [];
    for (let d = 0; d < 10; d += 1) {
      const date = addDays(RUN, -10 + d);
      rows.push(row(date, 'a', 'bandit', 900, 10), row(date, 'a', 'holdout', 50, 10), row(date, 'b', 'holdout', 50, 10));
      log.push(
        { date, flag_key: FLAG, target: 'fallthrough', arm: 'a', weight_units: 100_000 },
        { date, flag_key: FLAG, target: 'fallthrough', arm: 'b', weight_units: 0 },
        { date, flag_key: FLAG, target: 'holdout', arm: 'a', weight_units: 50_000 },
        { date, flag_key: FLAG, target: 'holdout', arm: 'b', weight_units: 50_000 },
      );
    }
    const g = { ...DEFAULT_GUARDRAILS, stopLoss: { ...DEFAULT_GUARDRAILS.stopLoss, minArmSamples: 100, minControlSamples: 100 } };
    const b = estimateFlag(parseExperimentProfitRows(rows), options(log, { guardrails: g })).targets[0]!.arms[1]!;
    expect(b.stopLossTest).not.toBeNull();
    expect(b.stopLossTest!.treatmentN).toBe(500);
  });

  it('holds (fail closed) when the allocation log lacks a day that has exposures', () => {
    const { rows, log } = trendScenario();
    const est = estimateFlag(rows, options(log.filter((l) => l.date !== addDays(RUN, -3))));
    expect(est.holds.join(' ')).toMatch(/allocation log has no weights/);
  });
});

describe('finding 4: CUPED on the 24h score', () => {
  it('uses a pre-exposure covariate to cut the variance behind the minimum sample', () => {
    // Two acquisition segments with different baselines (x = 0 or 10); the score tracks x.
    const date = addDays(RUN, -1);
    const mk = (arm: string, channel: 'google_cpc' | 'organic', x: number, n: number) =>
      row(date, arm, 'bandit', n, x, 1, { acquisition_channel: channel, sum_covariate: n * x, sum_sq_covariate: n * x * x, sum_predicted_profit_x_covariate: n * x * x });
    const rows = parseExperimentProfitRows([mk('a', 'google_cpc', 0, 500), mk('a', 'organic', 10, 500), mk('b', 'google_cpc', 0, 500), mk('b', 'organic', 10, 500)]);
    const log: AllocationLogRow[] = [
      { date, flag_key: FLAG, target: 'fallthrough', arm: 'a', weight_units: 50_000 },
      { date, flag_key: FLAG, target: 'fallthrough', arm: 'b', weight_units: 50_000 },
    ];
    const g = { ...DEFAULT_GUARDRAILS, minimumDetectableEffect: 0.5, minSamplesPerArm: 1 };
    const plain = estimateFlag(rows, options(log, { guardrails: g }));
    const cuped = estimateFlag(rows, options(log, { guardrails: g, cuped: true }));
    expect(cuped.cuped!.theta).toBeCloseTo(1, 6);
    expect(cuped.cuped!.varianceReduction).toBeGreaterThan(0.9);
    expect(cuped.targets[0]!.requiredN).toBeLessThan(plain.targets[0]!.requiredN / 10);
    // The adjustment is mean-preserving across the pooled data.
    expect(cuped.targets[0]!.arms[0]!.weightedMean).toBeCloseTo(plain.targets[0]!.arms[0]!.weightedMean!, 6);
    expect(estimateFlag(rows.map((r) => ({ ...r, sum_covariate: null, sum_sq_covariate: null, sum_predicted_profit_x_covariate: null })), options(log, { cuped: true })).notes.join(' ')).toMatch(/no covariate columns/);
  });
});
