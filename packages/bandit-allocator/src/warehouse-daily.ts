/**
 * Adapter for packages/warehouse `fct_experiment_profit_by_arm_daily` (per exposure day x segment x
 * slice, intent-to-treat) and its interval-based allocation log (`int_experiment__allocation_log`).
 *
 * The mart's FIRST 17 columns are this package's native columns (warehouse.ts) and pass through
 * unchanged. Since 2026-09-30 the mart also emits the allocator's optional groups under the SAME
 * names (matured_* at its fixed horizon with the value winsorized at bandit_value_cap_usd,
 * activated_users, generations_24h, failed_generations_24h, sum_covariate, sum_sq_covariate,
 * sum_predicted_profit_x_covariate): they pass through too, so the default p x V - C reward, the
 * guardrails and CUPED all run on it. A group the mart only half-implements is rejected by the row
 * schema (all-or-none), never guessed.
 *
 * Caveat: the mart matures users at pp_horizon_days (90 days). With the allocator's 56-day lookback
 * nothing inside the window is matured, so `decomposed_profit` and `conversion` wait until the
 * lookback exceeds the horizon, or until the mart matures these columns at a shorter horizon
 * (the allocator's default is 14 days).
 *
 * Fallback: an older mart without `sum_covariate*` but with `sum_cuped_covariate*` (its cross-fitted
 * pre-exposure segment value) still gets the CUPED group from those.
 * Not used: the mart's own realised-90d sums (no sums of squares for value or cost, no refunded
 * users), its predicted p x V - C sums (they decompose the 24h SCORE, which the predicted_profit
 * reward already uses whole) and its per-row propensity sums (the allocator reads the same log
 * directly, including days on which an arm had no user).
 */

import { z } from 'zod';
import { LOG_WEIGHT_TOTAL, type AllocationLogRow } from './allocation-log.js';
import { toUnits } from './thompson.js';
import { addDays, COVARIATE_COLUMNS, EXPERIMENT_PROFIT_BY_ARM_COLUMNS, MATURED_COLUMNS, OPTIONAL_EXPERIMENT_COLUMNS, parseExperimentProfitRows, type ExperimentProfitByArmRow } from './warehouse.js';

const nullableNumber = z.number().refine(Number.isFinite, 'must be finite').nullable().optional();

/** The mart's cuped-named covariate columns (the fallback source of the CUPED group). */
export const DailyMartExtraSchema = z.looseObject({
  sum_cuped_covariate: nullableNumber,
  sum_sq_cuped_covariate: nullableNumber,
  sum_cuped_covariate_x_predicted_profit: nullableNumber,
});

export function rowsFromDailyMart(input: readonly unknown[]): ExperimentProfitByArmRow[] {
  const rows = input.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`fct_experiment_profit_by_arm_daily row ${i}: not an object`);
    const r = raw as Record<string, unknown>;
    const extra = DailyMartExtraSchema.safeParse(r);
    if (!extra.success) throw new Error(`fct_experiment_profit_by_arm_daily row ${i}: ${extra.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    const native = Object.fromEntries(EXPERIMENT_PROFIT_BY_ARM_COLUMNS.map((c) => [c, r[c]])) as unknown as ExperimentProfitByArmRow;
    // The optional groups under their native names pass through (NULL stays NULL; the row schema
    // enforces all-or-none per group).
    const optional: Record<string, unknown> = {};
    for (const c of OPTIONAL_EXPERIMENT_COLUMNS) if (r[c] !== undefined) optional[c] = r[c];
    // The mart's realised-90d block shares `matured_users` with the matured group. On an older mart
    // that column stands alone: it has no use without the rest of the group, so it is left out rather
    // than reported as a half-implemented group.
    const maturedPresent = MATURED_COLUMNS.filter((c) => optional[c] !== undefined && optional[c] !== null);
    if (maturedPresent.length === 1 && maturedPresent[0] === 'matured_users') delete optional.matured_users;
    const nativeCovariate = COVARIATE_COLUMNS.some((c) => r[c] !== undefined && r[c] !== null);
    const e = extra.data;
    const fallback =
      !nativeCovariate && typeof e.sum_cuped_covariate === 'number' && typeof e.sum_sq_cuped_covariate === 'number' && typeof e.sum_cuped_covariate_x_predicted_profit === 'number'
        ? { sum_covariate: e.sum_cuped_covariate, sum_sq_covariate: e.sum_sq_cuped_covariate, sum_predicted_profit_x_covariate: e.sum_cuped_covariate_x_predicted_profit }
        : {};
    return { ...native, ...optional, ...fallback };
  });
  // Same validation as native rows (identity, Cauchy-Schwarz, counts, groups, duplicate grains).
  return parseExperimentProfitRows(rows);
}

export const AllocationIntervalSchema = z.looseObject({
  flag_key: z.string().min(1),
  arm: z.string().min(1),
  allocation_slice: z.enum(['holdout', 'bandit']),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Exclusive; null/empty = still in force. */
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assignment_probability: z.number().min(0).max(1),
  /** The LaunchDarkly target (rule-target name or `fallthrough`); required once per-segment rules exist. */
  target: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).nullable().optional(),
});
export type AllocationInterval = z.infer<typeof AllocationIntervalSchema>;

/**
 * Expand the warehouse's interval log (flag, arm, slice, [valid_from, valid_to), probability) into
 * the allocator's daily per-target log. Without a `target` column a bandit-slice interval can only
 * describe the fallthrough, so a flag with per-segment rules needs the column.
 */
export function allocationLogFromIntervals(input: readonly unknown[], o: { from: string; to: string; ruleTargets: Readonly<Record<string, readonly string[]>> }): AllocationLogRow[] {
  const intervals = input.map((raw, i) => {
    const parsed = AllocationIntervalSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`allocation interval ${i}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    return parsed.data;
  });
  for (const iv of intervals) {
    if (iv.allocation_slice === 'bandit' && !iv.target && (o.ruleTargets[iv.flag_key]?.length ?? 0) > 0) {
      throw new Error(`${iv.flag_key} has per-segment rules (${o.ruleTargets[iv.flag_key]!.join(', ')}), so its allocation log needs a target column`);
    }
  }
  const out: AllocationLogRow[] = [];
  for (let date = o.from; date <= o.to; date = addDays(date, 1)) {
    const groups = new Map<string, Array<{ arm: string; p: number }>>();
    for (const iv of intervals) {
      if (iv.valid_from > date || (iv.valid_to && iv.valid_to <= date)) continue;
      const target = iv.allocation_slice === 'holdout' ? 'holdout' : (iv.target ?? 'fallthrough');
      const key = `${iv.flag_key}\u0000${target}`;
      const list = groups.get(key) ?? [];
      if (list.some((x) => x.arm === iv.arm)) throw new Error(`overlapping allocation intervals for ${iv.flag_key} ${target} ${iv.arm} on ${date}`);
      list.push({ arm: iv.arm, p: iv.assignment_probability });
      groups.set(key, list);
    }
    for (const [key, list] of groups) {
      const [flag, target] = key.split('\u0000') as [string, string];
      const total = list.reduce((s, x) => s + x.p, 0);
      if (Math.abs(total - 1) > 1e-6) throw new Error(`allocation log ${flag} ${target} on ${date}: probabilities sum to ${total}, expected 1`);
      const units = toUnits(list.map((x) => x.p / total), LOG_WEIGHT_TOTAL, list.map(() => 0));
      list.forEach((x, i) => out.push({ date, flag_key: flag, target, arm: x.arm, weight_units: units[i]! }));
    }
  }
  return out;
}
