/**
 * Adapter for packages/warehouse `fct_experiment_profit_by_arm` AS BUILT TODAY: one readout row
 * per (flag_key, arm) with per-exposed-user means, 95% normal-approximation CIs and ranks.
 *
 * The allocator's native input (warehouse.ts) is the same mart at a finer grain (exposure day x
 * segment x holdout/bandit slice) with sums and sums of squares. From a readout row the NIG
 * sufficient statistics are still recoverable exactly:
 *   n     = scored_users
 *   sum   = n * predicted_profit_per_exposed_usd
 *   sd    = (predicted_profit_ci_high - predicted_profit_ci_low) * sqrt(n) / (2 * ci_z)   (stddev_samp)
 *   sumSq = (n - 1) * sd^2 + n * mean^2
 * What the readout grain cannot support: per-segment rules (no segment columns), the holdout
 * control and SRM check (no allocation_slice), time decay and IPW (no exposure day), matured
 * outcomes and guardrail metrics. Rows are mapped to one "unknown" segment in the bandit slice,
 * dated the day before the run. Because the SRM check cannot run without a holdout slice, the job
 * FAILS CLOSED on these rows: no patch, and an alert. Use fct_experiment_profit_by_arm_daily
 * (warehouse-daily.ts) or the native grain instead.
 */

import { z } from 'zod';
import type { SufficientStats } from './thompson.js';
import { addDays, parseExperimentProfitRows, type ExperimentProfitByArmRow } from './warehouse.js';

const num = z.number().refine(Number.isFinite, 'must be finite');
const nullableNum = num.nullable();

/** The readout columns the adapter uses; other columns (ranks, other CIs) pass through unused. */
export const WarehouseArmReadoutRowSchema = z.looseObject({
  flag_key: z.string().min(1),
  arm: z.string().min(1),
  exposed_users: z.number().int().min(0),
  converters: z.number().int().min(0),
  conversion_rate: num.min(0).max(1),
  scored_users: z.number().int().min(0),
  predicted_profit_per_exposed_usd: nullableNum,
  predicted_profit_ci_low: nullableNum,
  predicted_profit_ci_high: nullableNum,
  predicted_revenue_per_exposed_usd: nullableNum,
  predicted_generation_cost_per_exposed_usd: nullableNum,
  predicted_fees_per_exposed_usd: nullableNum,
  predicted_refund_risk_per_exposed_usd: nullableNum,
});

export type WarehouseArmReadoutRow = z.infer<typeof WarehouseArmReadoutRowSchema>;

/** dbt var `ci_z` in packages/warehouse/dbt_project.yml (95% two-sided). */
export const WAREHOUSE_CI_Z = 1.96;

export function sufficientStatsFromReadout(row: WarehouseArmReadoutRow, ciZ: number = WAREHOUSE_CI_Z): SufficientStats {
  const n = row.scored_users;
  if (n === 0 || row.predicted_profit_per_exposed_usd === null) return { n: 0, sum: 0, sumSq: 0 };
  const mean = row.predicted_profit_per_exposed_usd;
  let sd = 0;
  if (n > 1) {
    if (row.predicted_profit_ci_low === null || row.predicted_profit_ci_high === null) {
      throw new Error(`${row.flag_key}/${row.arm}: predicted profit CI missing, cannot recover the variance`);
    }
    sd = ((row.predicted_profit_ci_high - row.predicted_profit_ci_low) * Math.sqrt(n)) / (2 * ciZ);
    if (!(sd >= 0)) throw new Error(`${row.flag_key}/${row.arm}: CI high < CI low`);
  }
  return { n, sum: n * mean, sumSq: (n - 1) * sd * sd + n * mean * mean };
}

export function rowsFromArmReadout(input: readonly unknown[], o: { runDate: string; ciZ?: number; modelVersion?: string }): ExperimentProfitByArmRow[] {
  const exposureDate = addDays(o.runDate, -1);
  const rows = input.map((raw, i) => {
    const parsed = WarehouseArmReadoutRowSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`fct_experiment_profit_by_arm readout row ${i}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    const r = parsed.data;
    const s = sufficientStatsFromReadout(r, o.ciZ ?? WAREHOUSE_CI_Z);
    const n = r.scored_users;
    const per = (x: number | null) => n * (x ?? 0);
    return {
      exposure_date: exposureDate,
      flag_key: r.flag_key,
      arm: r.arm,
      country_bucket: 'unknown',
      device: 'unknown',
      acquisition_channel: 'unknown',
      allocation_slice: 'bandit',
      exposed_users: r.exposed_users,
      scored_users: n,
      // converters are counted over exposed users; restate them over scored users.
      converted_users: n === r.exposed_users ? Math.min(r.converters, n) : Math.min(n, Math.round(r.conversion_rate * n)),
      sum_predicted_profit: s.sum,
      sum_sq_predicted_profit: s.sumSq,
      sum_predicted_revenue: per(r.predicted_revenue_per_exposed_usd),
      sum_predicted_generation_cost: per(r.predicted_generation_cost_per_exposed_usd),
      sum_predicted_fees: per(r.predicted_fees_per_exposed_usd),
      sum_predicted_refund_risk: per(r.predicted_refund_risk_per_exposed_usd),
      model_version: o.modelVersion ?? 'warehouse:fct_experiment_profit_by_arm(readout)',
    } satisfies ExperimentProfitByArmRow;
  });
  // Same validation as native rows (identity, Cauchy-Schwarz, counts, duplicates).
  return parseExperimentProfitRows(rows);
}
