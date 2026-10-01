/**
 * Sample-ratio-mismatch (SRM) checks. Any of them failing, or not being evaluable, holds the flag:
 * the job fails CLOSED (no patch) and raises an alert, because a broken assignment or exposure log
 * makes every downstream estimate untrustworthy.
 *
 *   1. holdout share: the share of exposures in the holdout slice vs the share the key predicate
 *      should match (6/62 = 9.7% for `[0-5]$` on base62 uids; 6/16 = 37.5% if the LaunchDarkly
 *      context key is a hex id instead). Chi-square with 1 df;
 *   2. per target, INCLUDING the bandit slices: observed exposures per arm vs the LOGGED weights that
 *      were live on each exposure day, E_k = sum_t N_t x w_k,t. Summing days with different weights
 *      makes Pearson's statistic conservative (E[X^2] <= df), never anti-conservative;
 *   3. Bonferroni across the evaluated targets.
 */

import type { AllocationLog } from './allocation-log.js';
import { routeSegment, type TargetSpec } from './estimate.js';
import { parseSegmentKey, segmentKey } from './segments.js';
import { chiSquareSurvival } from './stats.js';
import { daysBetween, type ExperimentProfitByArmRow } from './warehouse.js';

export interface SrmTargetResult {
  target: string;
  exposures: number;
  observed: Record<string, number>;
  expected: Record<string, number>;
  chiSquare: number;
  df: number;
  pValue: number;
  /** Not tested: too few exposures (a note, not a hold). */
  skipped: string | null;
}

export interface HoldoutShareResult {
  holdout: number;
  total: number;
  observedShare: number;
  expectedShare: number;
  chiSquare: number;
  pValue: number;
}

export interface SrmResult {
  holdoutShare: HoldoutShareResult | null;
  targets: SrmTargetResult[];
  /** Why the check could not run (fail closed). */
  unevaluable: string[];
  /** Why the check failed (fail closed). */
  alarms: string[];
}

export interface SrmOptions {
  flagKey: string;
  arms: readonly string[];
  targets: readonly TargetSpec[];
  runDate: string;
  lookbackDays: number;
  log: AllocationLog | null;
  expectedHoldoutShare: number;
  alpha: number;
  /** Holdout exposures needed before the checks are evaluable (fewer: hold + alert). */
  minHoldoutUsers: number;
  /** A bandit target with fewer exposures is not tested (noted). */
  minTargetUsers: number;
}

function pearson(observed: Record<string, number>, expected: Record<string, number>): { chiSquare: number; df: number; pValue: number } {
  let chi = 0;
  let df = -1;
  let impossible = false;
  for (const arm of Object.keys(expected)) {
    const e = expected[arm]!;
    const o = observed[arm] ?? 0;
    if (e > 1e-9) {
      chi += (o - e) ** 2 / e;
      df += 1;
    } else if (o > 0) impossible = true;
  }
  if (impossible) return { chiSquare: Number.POSITIVE_INFINITY, df: Math.max(df, 1), pValue: 0 };
  return { chiSquare: chi, df, pValue: df > 0 ? chiSquareSurvival(chi, df) : 1 };
}

export function srmCheck(rows: readonly ExperimentProfitByArmRow[], o: SrmOptions): SrmResult {
  const out: SrmResult = { holdoutShare: null, targets: [], unevaluable: [], alarms: [] };
  const mine = rows.filter((r) => {
    if (r.flag_key !== o.flagKey) return false;
    const age = daysBetween(r.exposure_date, o.runDate);
    return age >= 1 && age <= o.lookbackDays;
  });
  const total = mine.reduce((s, r) => s + r.exposed_users, 0);
  const holdout = mine.filter((r) => r.allocation_slice === 'holdout').reduce((s, r) => s + r.exposed_users, 0);
  if (holdout < o.minHoldoutUsers) {
    out.unevaluable.push(
      holdout === 0
        ? 'no holdout exposures in the window: the rows carry no holdout slice, so neither the SRM check nor the stop-loss control can run'
        : `only ${holdout} holdout exposures in the window < ${o.minHoldoutUsers}: the SRM check cannot run yet`,
    );
  } else {
    const e = o.expectedHoldoutShare;
    const chi = (holdout - total * e) ** 2 / (total * e) + (total - holdout - total * (1 - e)) ** 2 / (total * (1 - e));
    out.holdoutShare = { holdout, total, observedShare: holdout / total, expectedShare: e, chiSquare: chi, pValue: chiSquareSurvival(chi, 1) };
    if (out.holdoutShare.pValue < o.alpha) {
      out.alarms.push(
        `holdout share ${(100 * out.holdoutShare.observedShare).toFixed(1)}% vs the ${(100 * e).toFixed(1)}% the key predicate should match (chi2=${chi.toFixed(1)}, p=${out.holdoutShare.pValue.toExponential(2)}): is the LaunchDarkly context key the uid?`,
      );
    }
  }
  if (!o.log) {
    out.unevaluable.push('no allocation log: the bandit slices cannot be checked against the weights that were actually served');
    return out;
  }

  // Per target: observed arm exposures vs the logged weights of each exposure day.
  const groups = new Map<string, { exposures: number; byDay: Map<string, number>; observed: Record<string, number> }>();
  const missing = new Set<string>();
  for (const r of mine) {
    const segment = segmentKey(parseSegmentKey(`${r.country_bucket}|${r.device}|${r.acquisition_channel}`));
    const target = r.allocation_slice === 'holdout' ? 'holdout' : routeSegment(o.targets, segment);
    let g = groups.get(target);
    if (!g) groups.set(target, (g = { exposures: 0, byDay: new Map(), observed: {} }));
    g.exposures += r.exposed_users;
    g.byDay.set(r.exposure_date, (g.byDay.get(r.exposure_date) ?? 0) + r.exposed_users);
    g.observed[r.arm] = (g.observed[r.arm] ?? 0) + r.exposed_users;
  }
  for (const [target, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const expected: Record<string, number> = Object.fromEntries(o.arms.map((a) => [a, 0]));
    for (const arm of Object.keys(g.observed)) if (!(arm in expected)) expected[arm] = 0;
    for (const [date, n] of g.byDay) {
      if (!o.log.has(date, o.flagKey, target)) {
        missing.add(`${date} ${target}`);
        continue;
      }
      for (const arm of Object.keys(expected)) expected[arm]! += n * o.log.weight(date, o.flagKey, target, arm)!;
    }
    const skipped = target !== 'holdout' && g.exposures < o.minTargetUsers ? `${g.exposures} exposures < ${o.minTargetUsers}` : null;
    const p = pearson(g.observed, expected);
    out.targets.push({ target, exposures: g.exposures, observed: g.observed, expected, ...p, skipped });
  }
  if (missing.size > 0) {
    const list = [...missing].sort();
    out.unevaluable.push(`allocation log has no weights for ${list.length} (day, target) pair(s) with exposures (e.g. ${list.slice(0, 3).join(', ')})`);
    return out;
  }
  const tested = out.targets.filter((t) => t.skipped === null);
  const bonferroni = o.alpha / Math.max(1, tested.length);
  for (const t of tested) {
    if (t.pValue < bonferroni) {
      out.alarms.push(
        `sample-ratio mismatch in ${t.target === 'holdout' ? 'the holdout' : `target "${t.target}"`} vs the logged weights: chi2=${Number.isFinite(t.chiSquare) ? t.chiSquare.toFixed(1) : 'inf'}, df=${t.df}, p=${t.pValue.toExponential(2)} < ${bonferroni.toExponential(2)} (alpha ${o.alpha} / ${tested.length} targets): assignment or exposure logging is broken`,
      );
    }
  }
  return out;
}
