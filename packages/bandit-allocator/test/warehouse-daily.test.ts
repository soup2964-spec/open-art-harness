import { beforeAll, describe, expect, it } from 'vitest';
import { AllocationLog } from '../src/allocation-log.js';
import { demoRows, loadAllocatorConfig, loadFlagSnapshots, runAllocation, type AllocatorConfig } from '../src/job.js';
import { allocationLogFromIntervals, rowsFromDailyMart } from '../src/warehouse-daily.js';
import { EXPERIMENT_PROFIT_BY_ARM_COLUMNS, type ExperimentProfitByArmRow } from '../src/warehouse.js';

const IMG = 'suite-default-model-create-image';
const VID = 'suite-default-model-create-video';
const RUN = '2026-08-01';

/**
 * Interval rows in the shape of packages/warehouse `int_experiment__allocation_log` (copied from its
 * SYNTHETIC seed allocation_log_synthetic.csv: the cohort generator's equal split since 2026-06-01).
 */
const INTERVALS = [
  ...['nano-banana-pro', 'gpt-image-2-5', 'nano-banana-2', 'gpt-image-2'].flatMap((arm) =>
    (['bandit', 'holdout'] as const).map((allocation_slice) => ({ flag_key: IMG, arm, allocation_slice, valid_from: '2026-06-01', valid_to: null, assignment_probability: 0.25, data_origin: 'SYNTHETIC' })),
  ),
  ...[
    ['byte-plus-seedance-2', 0.333333333],
    ['byte-plus-seedance-2-5', 0.333333333],
    ['wan3-0', 0.333333334],
  ].flatMap(([arm, p]) =>
    (['bandit', 'holdout'] as const).map((allocation_slice) => ({ flag_key: VID, arm, allocation_slice, valid_from: '2026-06-01', valid_to: null, assignment_probability: p, data_origin: 'SYNTHETIC' })),
  ),
];

let native: ExperimentProfitByArmRow[];
let config: AllocatorConfig;

/**
 * A daily-mart row as packages/warehouse builds it: the 17 native columns first, then its extras.
 * `withGroups` adds the allocator's optional groups under the same names, as the mart does since
 * 2026-09-30 (matured at its fixed horizon, value winsorized at bandit_value_cap_usd).
 */
function asDailyMart(r: ExperimentProfitByArmRow, withGroups = false): Record<string, unknown> {
  const first = Object.fromEntries(EXPERIMENT_PROFIT_BY_ARM_COLUMNS.map((c) => [c, r[c]]));
  const x = 3; // a constant segment value keeps the covariate sums consistent
  const groups = withGroups
    ? {
        matured_converted_users: r.matured_converted_users,
        sum_matured_value: r.sum_matured_value,
        sum_sq_matured_value: r.sum_sq_matured_value,
        sum_matured_cost: r.sum_matured_cost,
        sum_sq_matured_cost: r.sum_sq_matured_cost,
        matured_refunded_users: r.matured_refunded_users,
        activated_users: r.activated_users,
        generations_24h: r.generations_24h,
        failed_generations_24h: r.failed_generations_24h,
        // The native names win over the cuped-named columns below (which carry a different value).
        sum_covariate: 5 * r.scored_users,
        sum_sq_covariate: 25 * r.scored_users,
        sum_predicted_profit_x_covariate: 5 * r.sum_predicted_profit,
      }
    : {};
  return {
    ...first,
    ...groups,
    contaminated_users: 0,
    scored_paid_within_24h_users: 0,
    sum_p_convert: 0.05 * r.scored_users,
    sum_expected_value_if_converted: r.sum_predicted_revenue,
    sum_unconditional_cost: r.sum_predicted_generation_cost,
    propensity_source: 'log',
    sum_propensity: 0.25 * r.exposed_users,
    sum_cuped_covariate: x * r.scored_users,
    sum_sq_cuped_covariate: x * x * r.scored_users,
    sum_cuped_covariate_x_predicted_profit: x * r.sum_predicted_profit,
    // The mart's realised-90d block: one matured_users column serves both blocks. An older mart
    // (90-day horizon, no group columns) reports 0 matured users inside the window.
    matured_users: withGroups ? r.matured_users : 0,
    realised_converted_users_90d: 0,
    sum_realised_profit_90d: 0,
    fitted_params_ref: 'fit-1',
  };
}

beforeAll(() => {
  native = demoRows();
  config = loadAllocatorConfig(new URL('../fixtures/allocator.config.json', import.meta.url));
});

describe('adapter for the warehouse daily mart (fct_experiment_profit_by_arm_daily)', () => {
  it('keeps the 17 native columns and maps the CUPED covariate; it never guesses matured or guardrail columns', () => {
    const rows = rowsFromDailyMart(native.map((r) => asDailyMart(r)));
    expect(rows.length).toBe(native.length);
    const r = rows[0]!;
    for (const c of EXPERIMENT_PROFIT_BY_ARM_COLUMNS) expect(r[c]).toEqual(native[0]![c]);
    expect(r.sum_covariate).toBe(3 * native[0]!.scored_users);
    // The mart's realised 90-day columns have no sums of squares or refunds: left unmapped (NULL).
    expect(r.matured_users ?? null).toBeNull();
    expect(r.activated_users ?? null).toBeNull();
  });

  it('passes the optional groups through when the mart carries them under the native names, preferring sum_covariate over sum_cuped_covariate', () => {
    const rows = rowsFromDailyMart(native.map((r) => asDailyMart(r, true)));
    const r = rows[0]!;
    const n = native[0]!;
    for (const c of ['matured_users', 'matured_converted_users', 'sum_matured_value', 'sum_sq_matured_cost', 'matured_refunded_users', 'activated_users', 'generations_24h', 'failed_generations_24h'] as const) {
      expect(r[c], c).toBe(n[c]);
    }
    expect(r.sum_covariate).toBe(5 * n.scored_users);
    expect(r.sum_predicted_profit_x_covariate).toBe(5 * n.sum_predicted_profit);
  });

  it('rejects a mart that half-implements a group instead of guessing the missing columns', () => {
    const partial = native.map((r) => ({ ...asDailyMart(r, true), sum_sq_matured_cost: null }));
    expect(() => rowsFromDailyMart(partial)).toThrow(/matured columns are all-or-none/);
  });

  it('with the groups present, the default p x V - C reward and the guardrails run on the daily mart', () => {
    const rows = rowsFromDailyMart(native.map((r) => asDailyMart(r, true)));
    const log = new AllocationLog(allocationLogFromIntervals(INTERVALS, { from: '2026-05-01', to: '2026-07-31', ruleTargets: {} }));
    const flags = loadFlagSnapshots(new URL('../fixtures/flags/', import.meta.url));
    const cfg: AllocatorConfig = { ...config, flags: config.flags.map((f) => ({ ...f, ruleTargets: [] })) };
    const f = runAllocation({ rows, flags, config: cfg, runDate: RUN, allocationLog: log }).flags.find((x) => x.flagKey === IMG)!;
    expect(f.status, f.reasons.join('; ')).toBe('no_change'); // holds only for the $2 MDE, not for missing inputs
    expect(f.reasons).toEqual([]);
    expect(f.valuePerConversion).not.toBeNull();
    expect(f.targets[0]!.guardrails.length).toBeGreaterThan(0);
  });

  it('expands the interval allocation log into daily per-target weights (fallthrough-only flags)', () => {
    const rows = allocationLogFromIntervals(INTERVALS, { from: '2026-06-01', to: '2026-07-31', ruleTargets: {} });
    const log = new AllocationLog(rows);
    expect(log.weight('2026-07-01', IMG, 'fallthrough', 'gpt-image-2')).toBe(0.25);
    expect(log.weight('2026-07-01', IMG, 'holdout', 'gpt-image-2')).toBe(0.25);
    expect(log.weight('2026-07-01', VID, 'fallthrough', 'wan3-0')).toBeCloseTo(1 / 3, 4);
    expect(log.has('2026-05-31', IMG, 'fallthrough')).toBe(false);
  });

  it('refuses an interval log without a target column once a flag has per-segment rules', () => {
    expect(() => allocationLogFromIntervals(INTERVALS, { from: '2026-06-01', to: '2026-06-02', ruleTargets: { [IMG]: ['us', 'tier1'] } })).toThrow(/needs a target column/);
  });

  it('drives the job end to end: the 24h-score reward runs, the matured rewards hold (fail closed) on this mart', () => {
    const rows = rowsFromDailyMart(native.map((r) => asDailyMart(r)));
    const log = new AllocationLog(allocationLogFromIntervals(INTERVALS, { from: '2026-05-01', to: '2026-07-31', ruleTargets: {} }));
    const flags = loadFlagSnapshots(new URL('../fixtures/flags/', import.meta.url));
    const fallthroughOnly = config.flags.map((f) => ({ ...f, ruleTargets: [] }));
    const score: AllocatorConfig = { ...config, reward: 'predicted_profit', rewardModel: { ...config.rewardModel, cuped: true }, guardrailMetrics: { ...config.guardrailMetrics, requireData: false }, flags: fallthroughOnly };
    const ok = runAllocation({ rows, flags, config: score, runDate: RUN, allocationLog: log }).flags.find((f) => f.flagKey === IMG)!;
    expect(ok.status, ok.reasons.join('; ')).not.toBe('held');
    expect(ok.checks.srm!.alarms).toEqual([]);
    expect(ok.notes.join(' ')).toMatch(/guardrail metrics unavailable/);
    const decomposed = runAllocation({ rows, flags, config: { ...config, flags: fallthroughOnly }, runDate: RUN, allocationLog: log }).flags.find((f) => f.flagKey === IMG)!;
    expect(decomposed.status).toBe('held');
    expect(decomposed.reasons.join(' ')).toMatch(/needs the matured-outcome columns/);
  });
});
