/**
 * Logged allocation weights ("propensities"): which rollout weights LaunchDarkly actually served,
 * per exposure day, flag and allocation target. The allocator needs them for two things:
 *   - the sample-ratio-mismatch check of the BANDIT slices (observed arm counts vs the weights that
 *     were live when those users were exposed; the current flag snapshot says nothing about the
 *     past), and
 *   - inverse-propensity weighting (IPW): the bandit moves traffic between arms over time, so an
 *     arm's pooled mean mixes days in different proportions than another arm's; weighting each user
 *     by 1 / (logged weight of their arm that day) compares arms on the same day mix.
 *
 * Source of truth in production: LaunchDarkly's audit log for the two flags (every semantic patch
 * carries the full rollout), expanded to one row per exposure day and target. When a patch lands
 * mid-day, align the mart's exposure day with the patch time (or log the time-weighted average,
 * which is an approximation). Targets are the configured rule-target names, `fallthrough`, and
 * `holdout` for the fixed holdout rule.
 *
 *   date (DATE), flag_key, target, arm (STRING), weight_units (INT64, thousandths of a percent;
 *   every (date, flag_key, target) sums to 100000, like LaunchDarkly rollout weights)
 */

import { z } from 'zod';

export const LOG_WEIGHT_TOTAL = 100_000;

export interface AllocationLogRow {
  date: string;
  flag_key: string;
  target: string;
  arm: string;
  weight_units: number;
}

export const AllocationLogRowSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flag_key: z.string().min(1),
  target: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  arm: z.string().min(1),
  weight_units: z.number().int().min(0).max(LOG_WEIGHT_TOTAL),
});

const key = (date: string, flag: string, target: string) => `${date}\u0000${flag}\u0000${target}`;

export class AllocationLog {
  private readonly weights = new Map<string, Map<string, number>>();

  /** Validated rows: no duplicate (date, flag, target, arm); every (date, flag, target) sums to 100000. */
  constructor(rows: readonly AllocationLogRow[]) {
    rows.forEach((raw, i) => {
      const parsed = AllocationLogRowSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`allocation log row ${i}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      const r = parsed.data;
      const k = key(r.date, r.flag_key, r.target);
      const m = this.weights.get(k) ?? new Map<string, number>();
      if (m.has(r.arm)) throw new Error(`allocation log row ${i}: duplicate ${r.date} ${r.flag_key} ${r.target} ${r.arm}`);
      m.set(r.arm, r.weight_units);
      this.weights.set(k, m);
    });
    for (const [k, m] of this.weights) {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      if (total !== LOG_WEIGHT_TOTAL) throw new Error(`allocation log ${k.replaceAll('\u0000', ' ')}: weights total ${total}, expected ${LOG_WEIGHT_TOTAL}`);
    }
  }

  has(date: string, flag: string, target: string): boolean {
    return this.weights.has(key(date, flag, target));
  }

  /** Logged share (0-1) of `arm`; 0 for an arm the log does not list; undefined when the day/target is missing. */
  weight(date: string, flag: string, target: string, arm: string): number | undefined {
    const m = this.weights.get(key(date, flag, target));
    if (!m) return undefined;
    return (m.get(arm) ?? 0) / LOG_WEIGHT_TOTAL;
  }
}

/** Rows for weights that were constant over `dates` (tests, the demo cohort, the simulation). */
export function constantAllocationLog(o: { dates: readonly string[]; flagKey: string; targets: Readonly<Record<string, Readonly<Record<string, number>>>> }): AllocationLogRow[] {
  const out: AllocationLogRow[] = [];
  for (const date of o.dates) {
    for (const [target, units] of Object.entries(o.targets)) {
      for (const [arm, w] of Object.entries(units)) out.push({ date, flag_key: o.flagKey, target, arm, weight_units: w });
    }
  }
  return out;
}

export const KEY_ALPHABETS: Readonly<Record<string, string>> = {
  base62: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  hex: '0123456789abcdef',
};

/**
 * Expected share of context keys the holdout predicate matches, for keys whose last character is
 * uniform over `alphabet`. `[0-5]$` gives 6/62 = 9.7% on base62 uids but 6/16 = 37.5% on hex keys
 * (e.g. a device id), which is why the observed holdout share is gated. The predicate must depend
 * on the last character only (checked with two different prefixes).
 */
export function expectedHoldoutShare(pattern: string, alphabet: string): number {
  if (alphabet.length === 0) throw new Error('empty key alphabet');
  const re = new RegExp(pattern);
  let hits = 0;
  for (const c of alphabet) {
    const a = re.test(`k${c}`);
    const b = re.test(`ZZ9_${c}`);
    if (a !== b) throw new Error(`holdout pattern ${pattern} depends on more than the last character`);
    if (a) hits += 1;
  }
  return hits / alphabet.length;
}
