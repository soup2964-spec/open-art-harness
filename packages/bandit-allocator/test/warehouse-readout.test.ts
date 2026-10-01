import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAllocatorConfig, loadFlagSnapshots, runAllocation } from '../src/job.js';
import { aggregateRows } from '../src/warehouse.js';
import { rowsFromArmReadout, sufficientStatsFromReadout } from '../src/warehouse-readout.js';

/**
 * Rows copied from packages/warehouse `fct_experiment_profit_by_arm` as materialised on
 * 2026-09-30 from the contracts fixture cohort (subset of its columns; the adapter accepts
 * and ignores the rest: CIs for other metrics, ranks, winner flags).
 */
const READOUT = JSON.parse(readFileSync(new URL('./fixtures/warehouse-fct_experiment_profit_by_arm.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
const IMG = 'suite-default-model-create-image';

describe('adapter for the warehouse readout mart (one row per flag x arm)', () => {
  it('recovers n, sum and sum of squares from scored_users, the mean and the 95% CI', () => {
    const row = READOUT.find((r) => r.flag_key === IMG && r.arm === 'gpt-image-2-5')!;
    const s = sufficientStatsFromReadout(row as never, 1.96);
    const n = 483;
    const mean = 16.076928;
    const sd = ((17.450657 - 14.703199) * Math.sqrt(n)) / (2 * 1.96);
    expect(s.n).toBe(n);
    expect(s.sum).toBeCloseTo(n * mean, 6);
    expect(s.sumSq).toBeCloseTo((n - 1) * sd * sd + n * mean * mean, 3);
    // Round trip: the sample SD implied by the recovered statistics equals the CI-implied SD.
    const recoveredSd = Math.sqrt((s.sumSq - (s.sum * s.sum) / s.n) / (s.n - 1));
    expect(recoveredSd).toBeCloseTo(sd, 6);
  });

  it('maps every arm to a valid fct_experiment_profit_by_arm row dated the day before the run', () => {
    const rows = rowsFromArmReadout(READOUT, { runDate: '2026-09-28' });
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.exposure_date).toBe('2026-09-27');
      expect([r.country_bucket, r.device, r.acquisition_channel, r.allocation_slice]).toEqual(['unknown', 'unknown', 'unknown', 'bandit']);
      expect(r.converted_users).toBeLessThanOrEqual(r.scored_users);
    }
    const agg = aggregateRows(rows, { runDate: '2026-09-28', lookbackDays: 56, halfLifeDays: null, reward: 'predicted_profit' });
    expect(agg.pooled(IMG, 'gpt-image-2-5').all.sum / agg.pooled(IMG, 'gpt-image-2-5').all.n).toBeCloseTo(16.076928, 6);
  });

  it('rejects readout rows whose components do not add up to predicted profit', () => {
    const broken = READOUT.map((r) => (r.arm === 'wan3-0' ? { ...r, predicted_fees_per_exposed_usd: 5 } : r));
    expect(() => rowsFromArmReadout(broken, { runDate: '2026-09-28' })).toThrow(/identity/);
  });

  it('fails CLOSED on the readout grain (no holdout slice, so no SRM check): no patch, and an alert', () => {
    const config = loadAllocatorConfig(new URL('../fixtures/allocator.config.json', import.meta.url));
    const flags = loadFlagSnapshots(new URL('../fixtures/flags/', import.meta.url));
    const run = runAllocation({
      rows: rowsFromArmReadout(READOUT, { runDate: '2026-09-28' }),
      flags,
      config: { ...config, flags: config.flags.map((f) => ({ ...f, ruleTargets: [] })), approvals: { mode: 'direct', notifyMemberIds: [], notifyTeamKeys: [] } },
      runDate: '2026-09-28',
      allocationLog: null,
    });
    const image = run.flags.find((f) => f.flagKey === IMG)!;
    expect(image.status).toBe('held');
    expect(image.request).toBeNull();
    expect(run.requests).toEqual([]);
    expect(image.reasons.join(' ')).toMatch(/SRM check not evaluable \(fail closed\): no holdout exposures/);
    expect(run.alerts.join(' ')).toMatch(new RegExp(`${IMG}: SRM check not evaluable`));
    expect(run.report).toMatch(/## ALERTS/);
  });
});
