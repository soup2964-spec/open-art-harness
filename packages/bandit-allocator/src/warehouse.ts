/**
 * Input interface: rows of the warehouse mart `fct_experiment_profit_by_arm`.
 *
 * Grain: one row per (exposure_date, flag_key, arm, country_bucket, device,
 * acquisition_channel, allocation_slice). Built by packages/warehouse from
 * ExperimentExposure (first exposure per user and flag) joined to
 * fct_predicted_profit_24h (contracts `PredictedProfit`, one row per user, USD):
 *
 *   exposed_users                  users first exposed to the arm that day
 *   scored_users                   of those, users with a PredictedProfit row (24h window closed).
 *                                  EVERY exposed user must be scored, including users who never
 *                                  generated (their predicted profit is ~0): scoring only active
 *                                  users would reward arms that stop people from activating.
 *   converted_users                scored users with a first subscription purchase in the
 *                                  conversion window (only used by the conversion-reward variant)
 *   sum_predicted_profit           sum of PredictedProfit.predicted_profit over scored users
 *   sum_sq_predicted_profit        sum of its squares (with n and the sum: NIG sufficient stats)
 *   sum_predicted_revenue / _generation_cost / _fees / _refund_risk   the four components
 *   allocation_slice               'holdout' when the user's LaunchDarkly context matched the fixed
 *                                  holdout rule (ideally from the evaluation reason logged with the
 *                                  exposure; else recomputed in SQL from the same key predicate, see
 *                                  launchdarkly.ts HOLDOUT_KEY_PATTERN), else 'bandit'
 *   model_version                  PredictedProfit.model_version
 *
 * Optional column groups (NULL when the mart does not provide them; each group is all-or-none).
 * All are intent-to-treat: every exposed user counts, whatever they did after exposure.
 *   matured outcomes, at the mart's FIXED horizon (e.g. 14 days after first exposure). A user is
 *   "matured" once the whole horizon has elapsed; users still inside it are not counted, so recent
 *   days carry 0 matured users rather than partial outcomes:
 *     matured_users                exposed users whose horizon has elapsed
 *     matured_converted_users      of those, first subscription purchase within the horizon
 *     sum_matured_value            net value within the horizon (revenue - fees - refund/chargeback
 *     sum_sq_matured_value         loss), WINSORIZED per user at the value cap; 0 for non-converters
 *     sum_matured_cost             measured serving cost within the horizon (every matured user)
 *     sum_sq_matured_cost
 *     matured_refunded_users       matured converters refunded or charged back within the horizon
 *   24h guardrail metrics (scored users):
 *     activated_users              at least one successful generation in the first 24h
 *     generations_24h              generations started in the first 24h
 *     failed_generations_24h       of those, failed (the ledger refunded their credits)
 *   CUPED covariate (a PRE-exposure covariate x per user, e.g. the segment's historical score):
 *     sum_covariate, sum_sq_covariate, sum_predicted_profit_x_covariate
 *
 * BigQuery types: DATE, STRING x7, INT64 x3, FLOAT64 x6, STRING; optional INT64 x6, FLOAT64 x7.
 */

import { z } from 'zod';
import { addStats, EMPTY_STATS, scaleStats, type SufficientStats } from './posterior.js';
import { ACQUISITION_CHANNELS, COUNTRY_BUCKETS, DEVICES, parseSegmentKey, segmentKey, type AcquisitionChannel, type CountryBucket, type Device } from './segments.js';

export const ALLOCATION_SLICES = ['holdout', 'bandit'] as const;
export type AllocationSlice = (typeof ALLOCATION_SLICES)[number];

export interface ExperimentProfitByArmRow {
  exposure_date: string;
  flag_key: string;
  arm: string;
  country_bucket: CountryBucket;
  device: Device;
  acquisition_channel: AcquisitionChannel;
  allocation_slice: AllocationSlice;
  exposed_users: number;
  scored_users: number;
  converted_users: number;
  sum_predicted_profit: number;
  sum_sq_predicted_profit: number;
  sum_predicted_revenue: number;
  sum_predicted_generation_cost: number;
  sum_predicted_fees: number;
  sum_predicted_refund_risk: number;
  model_version: string;
  // --- optional groups (see the header) ---
  matured_users?: number | null;
  matured_converted_users?: number | null;
  sum_matured_value?: number | null;
  sum_sq_matured_value?: number | null;
  sum_matured_cost?: number | null;
  sum_sq_matured_cost?: number | null;
  matured_refunded_users?: number | null;
  activated_users?: number | null;
  generations_24h?: number | null;
  failed_generations_24h?: number | null;
  sum_covariate?: number | null;
  sum_sq_covariate?: number | null;
  sum_predicted_profit_x_covariate?: number | null;
}

export const MATURED_COLUMNS = [
  'matured_users',
  'matured_converted_users',
  'sum_matured_value',
  'sum_sq_matured_value',
  'sum_matured_cost',
  'sum_sq_matured_cost',
  'matured_refunded_users',
] as const satisfies ReadonlyArray<keyof ExperimentProfitByArmRow>;
export const GUARDRAIL_COLUMNS = ['activated_users', 'generations_24h', 'failed_generations_24h'] as const satisfies ReadonlyArray<keyof ExperimentProfitByArmRow>;
export const COVARIATE_COLUMNS = ['sum_covariate', 'sum_sq_covariate', 'sum_predicted_profit_x_covariate'] as const satisfies ReadonlyArray<keyof ExperimentProfitByArmRow>;
export const OPTIONAL_EXPERIMENT_COLUMNS = [...MATURED_COLUMNS, ...GUARDRAIL_COLUMNS, ...COVARIATE_COLUMNS] as const;

/** True when every column of the group is present (non-null) on the row. */
export function hasGroup(r: ExperimentProfitByArmRow, group: readonly (keyof ExperimentProfitByArmRow)[]): boolean {
  return group.every((c) => r[c] !== undefined && r[c] !== null);
}

export const EXPERIMENT_PROFIT_BY_ARM_COLUMNS = [
  'exposure_date',
  'flag_key',
  'arm',
  'country_bucket',
  'device',
  'acquisition_channel',
  'allocation_slice',
  'exposed_users',
  'scored_users',
  'converted_users',
  'sum_predicted_profit',
  'sum_sq_predicted_profit',
  'sum_predicted_revenue',
  'sum_predicted_generation_cost',
  'sum_predicted_fees',
  'sum_predicted_refund_risk',
  'model_version',
] as const satisfies ReadonlyArray<keyof ExperimentProfitByArmRow>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const count = z.number().int().min(0);
const money = z.number().refine(Number.isFinite, 'must be finite');
const optCount = count.nullable().optional();
const optMoney = money.nullable().optional();

/** sum(x^2) >= (sum x)^2 / n (Cauchy-Schwarz), with float slack. */
function cauchySchwarzOk(n: number, sum: number, sumSq: number): boolean {
  if (n === 0) return sum === 0 && sumSq === 0;
  const minSq = (sum * sum) / n;
  return sumSq + 1e-6 * (1 + Math.abs(minSq)) >= minSq;
}

export const ExperimentProfitByArmRowSchema = z
  .strictObject({
    exposure_date: z.string().regex(DATE).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'not a calendar date'),
    flag_key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    arm: z.string().min(1).max(128),
    country_bucket: z.enum(COUNTRY_BUCKETS),
    device: z.enum(DEVICES),
    acquisition_channel: z.enum(ACQUISITION_CHANNELS),
    allocation_slice: z.enum(ALLOCATION_SLICES),
    exposed_users: count,
    scored_users: count,
    converted_users: count,
    sum_predicted_profit: money,
    sum_sq_predicted_profit: money.refine((v) => v >= 0, 'must be >= 0'),
    sum_predicted_revenue: money.refine((v) => v >= 0, 'must be >= 0'),
    sum_predicted_generation_cost: money.refine((v) => v >= 0, 'must be >= 0'),
    sum_predicted_fees: money.refine((v) => v >= 0, 'must be >= 0'),
    sum_predicted_refund_risk: money.refine((v) => v >= 0, 'must be >= 0'),
    model_version: z.string().min(1).max(128),
    matured_users: optCount,
    matured_converted_users: optCount,
    sum_matured_value: optMoney,
    sum_sq_matured_value: optMoney,
    sum_matured_cost: optMoney,
    sum_sq_matured_cost: optMoney,
    matured_refunded_users: optCount,
    activated_users: optCount,
    generations_24h: optCount,
    failed_generations_24h: optCount,
    sum_covariate: optMoney,
    sum_sq_covariate: optMoney,
    sum_predicted_profit_x_covariate: optMoney,
  })
  .superRefine((r, ctx) => {
    const present = (c: (typeof OPTIONAL_EXPERIMENT_COLUMNS)[number]) => r[c] !== undefined && r[c] !== null;
    for (const [name, group] of [
      ['matured', MATURED_COLUMNS],
      ['guardrail', GUARDRAIL_COLUMNS],
      ['covariate', COVARIATE_COLUMNS],
    ] as const) {
      const n = group.filter(present).length;
      if (n !== 0 && n !== group.length) ctx.addIssue({ code: 'custom', path: [group[0]], message: `the ${name} columns are all-or-none (${n} of ${group.length} present)` });
    }
    if (MATURED_COLUMNS.every(present)) {
      const m = r.matured_users!;
      if (m > r.exposed_users) ctx.addIssue({ code: 'custom', path: ['matured_users'], message: 'matured_users > exposed_users' });
      if (r.matured_converted_users! > m) ctx.addIssue({ code: 'custom', path: ['matured_converted_users'], message: 'matured_converted_users > matured_users' });
      if (r.matured_refunded_users! > r.matured_converted_users!) ctx.addIssue({ code: 'custom', path: ['matured_refunded_users'], message: 'matured_refunded_users > matured_converted_users' });
      if (r.sum_matured_cost! < 0) ctx.addIssue({ code: 'custom', path: ['sum_matured_cost'], message: 'must be >= 0' });
      // Non-converters carry value 0, so the value moments live on the converters.
      if (!cauchySchwarzOk(r.matured_converted_users!, r.sum_matured_value!, r.sum_sq_matured_value!)) {
        ctx.addIssue({ code: 'custom', path: ['sum_sq_matured_value'], message: 'inconsistent with sum_matured_value and matured_converted_users' });
      }
      if (!cauchySchwarzOk(m, r.sum_matured_cost!, r.sum_sq_matured_cost!)) ctx.addIssue({ code: 'custom', path: ['sum_sq_matured_cost'], message: 'inconsistent with sum_matured_cost and matured_users' });
    }
    if (GUARDRAIL_COLUMNS.every(present)) {
      if (r.activated_users! > r.scored_users) ctx.addIssue({ code: 'custom', path: ['activated_users'], message: 'activated_users > scored_users' });
      if (r.failed_generations_24h! > r.generations_24h!) ctx.addIssue({ code: 'custom', path: ['failed_generations_24h'], message: 'failed_generations_24h > generations_24h' });
    }
    if (COVARIATE_COLUMNS.every(present) && !cauchySchwarzOk(r.scored_users, r.sum_covariate!, r.sum_sq_covariate!)) {
      ctx.addIssue({ code: 'custom', path: ['sum_sq_covariate'], message: 'inconsistent with sum_covariate and scored_users' });
    }
    if (r.scored_users > r.exposed_users) {
      ctx.addIssue({ code: 'custom', path: ['scored_users'], message: 'scored_users > exposed_users' });
    }
    if (r.converted_users > r.scored_users) {
      ctx.addIssue({ code: 'custom', path: ['converted_users'], message: 'converted_users > scored_users' });
    }
    // Cauchy-Schwarz: sum(x^2) >= (sum x)^2 / n. A violation means the columns were mis-built.
    const minSq = r.scored_users > 0 ? (r.sum_predicted_profit * r.sum_predicted_profit) / r.scored_users : 0;
    if (r.sum_sq_predicted_profit + 1e-6 * (1 + Math.abs(minSq)) < minSq || (r.scored_users === 0 && (r.sum_predicted_profit !== 0 || r.sum_sq_predicted_profit !== 0))) {
      ctx.addIssue({ code: 'custom', path: ['sum_sq_predicted_profit'], message: 'inconsistent with sum_predicted_profit and scored_users' });
    }
    // PredictedProfit identity (validators.ts, 0.01 per user), summed over the row.
    const components = r.sum_predicted_revenue - r.sum_predicted_generation_cost - r.sum_predicted_fees - r.sum_predicted_refund_risk;
    if (Math.abs(components - r.sum_predicted_profit) > 0.01 * Math.max(1, r.scored_users) + 1e-6) {
      ctx.addIssue({ code: 'custom', path: ['sum_predicted_profit'], message: `identity violated: profit ${r.sum_predicted_profit} != components ${components}` });
    }
  });

function grainKey(r: ExperimentProfitByArmRow): string {
  return [r.exposure_date, r.flag_key, r.arm, r.country_bucket, r.device, r.acquisition_channel, r.allocation_slice].join('|');
}

/** Validate untrusted rows (BigQuery / JSONL); throws with row index, column and reason. */
export function parseExperimentProfitRows(input: readonly unknown[]): ExperimentProfitByArmRow[] {
  const out: ExperimentProfitByArmRow[] = [];
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const parsed = ExperimentProfitByArmRowSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((iss) => `${iss.path.join('.') || '(row)'}: ${iss.message}`).join('; ');
      throw new Error(`fct_experiment_profit_by_arm row ${i}: ${detail}`);
    }
    const row = parsed.data as ExperimentProfitByArmRow;
    const key = grainKey(row);
    if (seen.has(key)) throw new Error(`fct_experiment_profit_by_arm row ${i}: duplicate grain ${key}`);
    seen.add(key);
    out.push(row);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation into sufficient statistics
// ---------------------------------------------------------------------------

export type RewardKind = 'predicted_profit' | 'conversion';

export interface AggregateOptions {
  /** The run date (YYYY-MM-DD). Only exposure days strictly before it are used. */
  runDate: string;
  /** Days of history to use (1 = yesterday only). */
  lookbackDays: number;
  /** Exponential decay half-life in days for non-stationarity; null = no decay. */
  halfLifeDays: number | null;
  reward: RewardKind;
}

export interface CellStats {
  /** Reward statistics over both slices, decayed. */
  all: SufficientStats;
  /** Holdout-slice statistics, decayed. */
  holdout: SufficientStats;
  /** Undecayed scored users over both slices. */
  scoredUsers: number;
  holdoutScored: number;
  exposedUsers: number;
  holdoutExposed: number;
}

const EMPTY_CELL: Readonly<CellStats> = Object.freeze({
  all: EMPTY_STATS,
  holdout: EMPTY_STATS,
  scoredUsers: 0,
  holdoutScored: 0,
  exposedUsers: 0,
  holdoutExposed: 0,
});

function addCell(a: CellStats, b: CellStats): CellStats {
  return {
    all: addStats(a.all, b.all),
    holdout: addStats(a.holdout, b.holdout),
    scoredUsers: a.scoredUsers + b.scoredUsers,
    holdoutScored: a.holdoutScored + b.holdoutScored,
    exposedUsers: a.exposedUsers + b.exposedUsers,
    holdoutExposed: a.holdoutExposed + b.holdoutExposed,
  };
}

const DAY_MS = 86_400_000;
export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Sufficient statistics per (flag, arm, segment), with query helpers. */
export class ArmSegmentStats {
  private readonly cells = new Map<string, CellStats>();

  add(flag: string, arm: string, segment: string, cell: CellStats): void {
    const key = `${flag}\u0000${arm}\u0000${segment}`;
    this.cells.set(key, addCell(this.cells.get(key) ?? EMPTY_CELL, cell));
  }

  cell(flag: string, arm: string, segment: string): CellStats | undefined {
    return this.cells.get(`${flag}\u0000${arm}\u0000${segment}`);
  }

  /** Every (flag, arm, segment) with data. */
  entries(): Array<{ flag: string; arm: string; segment: string; cell: CellStats }> {
    return [...this.cells.entries()].map(([key, cell]) => {
      const [flag, arm, segment] = key.split('\u0000') as [string, string, string];
      return { flag, arm, segment, cell };
    });
  }

  segments(flag: string): string[] {
    return [...new Set(this.entries().filter((e) => e.flag === flag).map((e) => e.segment))].sort();
  }

  arms(flag: string): string[] {
    return [...new Set(this.entries().filter((e) => e.flag === flag).map((e) => e.arm))].sort();
  }

  /** Pool one arm over the segments accepted by `include`. */
  pooled(flag: string, arm: string, include: (segment: string) => boolean = () => true): CellStats {
    let acc: CellStats = EMPTY_CELL;
    for (const e of this.entries()) if (e.flag === flag && e.arm === arm && include(e.segment)) acc = addCell(acc, e.cell);
    return acc;
  }
}

export function aggregateRows(rows: readonly ExperimentProfitByArmRow[], opts: AggregateOptions): ArmSegmentStats {
  if (!DATE.test(opts.runDate)) throw new Error(`runDate must be YYYY-MM-DD, got ${opts.runDate}`);
  if (!(opts.lookbackDays >= 1)) throw new Error('lookbackDays must be >= 1');
  if (opts.halfLifeDays !== null && !(opts.halfLifeDays > 0)) throw new Error('halfLifeDays must be > 0 or null');
  const out = new ArmSegmentStats();
  for (const r of rows) {
    const ageDays = daysBetween(r.exposure_date, opts.runDate);
    if (ageDays < 1 || ageDays > opts.lookbackDays) continue;
    const weight = opts.halfLifeDays === null ? 1 : Math.pow(0.5, (ageDays - 1) / opts.halfLifeDays);
    const reward: SufficientStats =
      opts.reward === 'predicted_profit'
        ? { n: r.scored_users, sum: r.sum_predicted_profit, sumSq: r.sum_sq_predicted_profit }
        : { n: r.scored_users, sum: r.converted_users, sumSq: r.converted_users };
    const decayed = scaleStats(reward, weight);
    const holdout = r.allocation_slice === 'holdout';
    out.add(r.flag_key, r.arm, segmentKey(parseSegmentKey(`${r.country_bucket}|${r.device}|${r.acquisition_channel}`)), {
      all: decayed,
      holdout: holdout ? decayed : EMPTY_STATS,
      scoredUsers: r.scored_users,
      holdoutScored: holdout ? r.scored_users : 0,
      exposedUsers: r.exposed_users,
      holdoutExposed: holdout ? r.exposed_users : 0,
    });
  }
  return out;
}
