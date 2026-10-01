/**
 * Per-flag estimation from fct_experiment_profit_by_arm rows: everything decideTarget needs for
 * every allocation target (LaunchDarkly rule or fallthrough).
 *
 * Non-stationarity (the allocator runs on weeks of data while prices, promos and the default
 * models themselves change):
 *   - half-life: each exposure day is weighted 0.5^((age - 1) / halfLifeDays);
 *   - inverse-propensity weighting with the LOGGED weights (allocation-log.ts): a user counts
 *     1 / (weight of their arm in their target that day), so every arm is estimated on the same
 *     day x target mix even though the bandit moved traffic between days (Hajek estimator);
 *   - the effective sample size is Kish's (sum w)^2 / sum w^2, which is what the minimum-sample
 *     rule and the posterior use;
 *   - resets: rows before the latest configured reset (a model or promo change) are dropped, and
 *     for the 24h-score reward only rows scored by the latest score model are used.
 * The stop-loss and guardrail tests use undecayed, day-matched contrasts since the reset instead
 * (sequential.ts), because their error guarantee is for a growing sample.
 *
 * Rewards, per EXPOSED user (intent-to-treat):
 *   decomposed_profit  p x V - C: p = matured conversion (Beta-Binomial), V = value per conversion
 *                      pooled across arms (winsorized per user in the mart), C = measured serving
 *                      cost per exposed user (NIG). Matured = the mart's fixed horizon has elapsed.
 *   predicted_profit   the 24h score (NIG), optionally CUPED-adjusted with a pre-exposure covariate.
 *   conversion         the matured conversion rate (Beta-Binomial).
 */

import type { AllocationLog } from './allocation-log.js';
import {
  requiredSampleSize,
  shrinkagePrior,
  updateBeta,
  updateNig,
  weakBetaPrior,
  weakPriorFor,
  type BetaPosterior,
  type NigPosterior,
  type PriorStrength,
  type RewardPosterior,
  type SufficientStats,
  type ValuePosterior,
} from './posterior.js';
import { parseSegmentKey, segmentKey, segmentMatches, type SegmentMatch } from './segments.js';
import { sequentialTest, type ContrastDay, type SequentialTestResult } from './sequential.js';
import type { ControlSpec, GuardrailConfig } from './thompson.js';
import { addDays, COVARIATE_COLUMNS, daysBetween, GUARDRAIL_COLUMNS, hasGroup, MATURED_COLUMNS, type ExperimentProfitByArmRow } from './warehouse.js';

export const REWARD_MODELS = ['decomposed_profit', 'predicted_profit', 'conversion'] as const;
export type RewardModel = (typeof REWARD_MODELS)[number];

export const GUARDRAIL_METRICS = ['activation', 'refunds', 'failed_generations'] as const;
export type GuardrailMetric = (typeof GUARDRAIL_METRICS)[number];

export interface GuardrailMetricsConfig {
  enabled: boolean;
  /** Hold the flag when the mart lacks the guardrail columns (fail closed). */
  requireData: boolean;
  alpha: number;
  /** Absolute tolerated deterioration vs the holdout before an arm is stopped. */
  activationMargin: number;
  refundMargin: number;
  failedGenerationMargin: number;
  minTreatmentN: number;
  minControlN: number;
}

export const DEFAULT_GUARDRAIL_METRICS: Readonly<GuardrailMetricsConfig> = Object.freeze({
  enabled: true,
  requireData: true,
  alpha: 0.05,
  // 5pp: in the ILLUSTRATIVE cohort the profit-best image arm activates 2.7pp below the holdout
  // (a 20-credit default), so a 2pp margin would stop it; guardrail margins are business choices.
  activationMargin: 0.05,
  refundMargin: 0.02,
  failedGenerationMargin: 0.01,
  minTreatmentN: 200,
  minControlN: 200,
});

export interface TargetSpec {
  name: string;
  /** null = the fallthrough (catch-all). */
  match: SegmentMatch | null;
}

export interface EstimateOptions {
  flagKey: string;
  arms: readonly string[];
  /** In LaunchDarkly evaluation order; the fallthrough last. */
  targets: readonly TargetSpec[];
  runDate: string;
  lookbackDays: number;
  halfLifeDays: number | null;
  /** Days of history (since the reset) the sequential tests use; >= lookbackDays. */
  sequentialWindowDays: number;
  /** Exposure days before this date are ignored (latest reset); null = none. */
  epochStart: string | null;
  reward: RewardModel;
  cuped: boolean;
  /** Used for decomposed_profit when the rows carry no matured converters. */
  valuePerConversionFallback: number | null;
  prior: PriorStrength;
  shrinkageStrength: number;
  guardrails: GuardrailConfig;
  guardrailMetrics: GuardrailMetricsConfig;
  log: AllocationLog;
}

export interface GuardrailResult {
  metric: GuardrailMetric;
  test: SequentialTestResult | null;
  breach: string | null;
}

export interface ArmEstimate {
  arm: string;
  posterior: RewardPosterior;
  effectiveN: number;
  rewardUsers: number;
  /** IPW- and decay-weighted mean reward (null without data). */
  weightedMean: number | null;
  stopLossTest: SequentialTestResult | null;
  guardrails: GuardrailResult[];
}

export interface TargetEstimate {
  name: string;
  segments: string[];
  coversAll: boolean;
  arms: ArmEstimate[];
  requiredN: number;
  /** Pooled per-user reward variance behind requiredN. */
  rewardVariance: number;
  control: { mean: number | null; n: number; source: string | null };
  notes: string[];
}

export interface FlagEstimate {
  targets: TargetEstimate[];
  value: ValuePosterior | null;
  cuped: { theta: number; varianceReduction: number } | null;
  /** Reasons the flag must hold (missing inputs); estimation stops at the first. */
  holds: string[];
  notes: string[];
  segments: string[];
}

// ---------------------------------------------------------------------------

/** First target (in evaluation order) whose match accepts the segment; the fallthrough catches the rest. */
export function routeSegment(targets: readonly TargetSpec[], segment: string): string {
  const s = parseSegmentKey(segment);
  const t = targets.find((x) => x.match === null || segmentMatches(s, x.match));
  if (!t) throw new Error('targets need a catch-all fallthrough');
  return t.name;
}

interface Cell {
  row: ExperimentProfitByArmRow;
  age: number;
  segment: string;
  /** Target the segment routes to (holdout users included: they are the control of that target). */
  target: string;
  decay: number;
  /** Logged weight of the row's arm in the LaunchDarkly target that served it; null when missing. */
  propensity: number | null;
}

interface Moments {
  /** sum w n, sum w^2 n, sum w x, sum w x^2 over users; raw n. */
  a: number;
  a2: number;
  s: number;
  q: number;
  rawN: number;
}

const ZERO_MOMENTS: Readonly<Moments> = Object.freeze({ a: 0, a2: 0, s: 0, q: 0, rawN: 0 });

function addMoments(m: Moments, w: number, part: SufficientStats): Moments {
  return { a: m.a + w * part.n, a2: m.a2 + w * w * part.n, s: m.s + w * part.sum, q: m.q + w * part.sumSq, rawN: m.rawN + part.n };
}

/** Effective sufficient statistics (Kish n) that reproduce the weighted mean and variance. */
function effectiveStats(m: Moments): { stats: SufficientStats; nEff: number; mean: number | null } {
  if (!(m.a > 0)) return { stats: { n: 0, sum: 0, sumSq: 0 }, nEff: 0, mean: null };
  const mean = m.s / m.a;
  const variance = Math.max(0, m.q / m.a - mean * mean);
  const nEff = (m.a * m.a) / m.a2;
  return { stats: { n: nEff, sum: nEff * mean, sumSq: nEff * (variance + mean * mean) }, nEff, mean };
}

function pooled(parts: readonly SufficientStats[]): SufficientStats {
  return parts.reduce((acc, p) => ({ n: acc.n + p.n, sum: acc.sum + p.sum, sumSq: acc.sumSq + p.sumSq }), { n: 0, sum: 0, sumSq: 0 });
}

const variance = (s: SufficientStats) => (s.n > 0 ? Math.max(0, s.sumSq / s.n - (s.sum / s.n) ** 2) : 0);

// Per-row statistics of one per-user quantity.
const scorePart = (r: ExperimentProfitByArmRow): SufficientStats => ({ n: r.scored_users, sum: r.sum_predicted_profit, sumSq: r.sum_sq_predicted_profit });
const conversionPart = (r: ExperimentProfitByArmRow): SufficientStats => ({ n: r.matured_users ?? 0, sum: r.matured_converted_users ?? 0, sumSq: r.matured_converted_users ?? 0 });
const costPart = (r: ExperimentProfitByArmRow): SufficientStats => ({ n: r.matured_users ?? 0, sum: r.sum_matured_cost ?? 0, sumSq: r.sum_sq_matured_cost ?? 0 });

/**
 * y = V conv - cost per matured user. The cross term E[conv x cost] is not in the mart; it is
 * approximated by p x mean cost (independence). Converters burn more credits, so the true variance
 * is smaller: the approximation is conservative for the tests and the sample-size rule.
 */
function decomposedPart(r: ExperimentProfitByArmRow, value: number): SufficientStats {
  const n = r.matured_users ?? 0;
  if (n === 0) return { n: 0, sum: 0, sumSq: 0 };
  const conv = r.matured_converted_users ?? 0;
  const cost = r.sum_matured_cost ?? 0;
  const costSq = r.sum_sq_matured_cost ?? 0;
  return { n, sum: value * conv - cost, sumSq: Math.max(0, value * value * conv - 2 * value * conv * (cost / n) + costSq) };
}

const GUARDRAIL_PART: Record<GuardrailMetric, (r: ExperimentProfitByArmRow) => SufficientStats> = {
  activation: (r) => ({ n: r.scored_users, sum: r.activated_users ?? 0, sumSq: r.activated_users ?? 0 }),
  refunds: (r) => ({ n: r.matured_converted_users ?? 0, sum: r.matured_refunded_users ?? 0, sumSq: r.matured_refunded_users ?? 0 }),
  failed_generations: (r) => ({ n: r.generations_24h ?? 0, sum: r.failed_generations_24h ?? 0, sumSq: r.failed_generations_24h ?? 0 }),
};

function contrastDays(treatment: readonly Cell[], control: readonly Cell[], part: (r: ExperimentProfitByArmRow) => SufficientStats): ContrastDay[] {
  const days = new Map<string, ContrastDay>();
  const at = (date: string) => {
    let d = days.get(date);
    if (!d) days.set(date, (d = { date, treatment: { n: 0, sum: 0, sumSq: 0 }, control: { n: 0, sum: 0, sumSq: 0 } }));
    return d;
  };
  for (const c of treatment) {
    const d = at(c.row.exposure_date);
    const p = part(c.row);
    d.treatment = { n: d.treatment.n + p.n, sum: d.treatment.sum + p.sum, sumSq: d.treatment.sumSq + p.sumSq };
  }
  for (const c of control) {
    const d = at(c.row.exposure_date);
    const p = part(c.row);
    d.control = { n: d.control.n + p.n, sum: d.control.sum + p.sum, sumSq: d.control.sumSq + p.sumSq };
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------

export function estimateFlag(rows: readonly ExperimentProfitByArmRow[], o: EstimateOptions): FlagEstimate {
  const out: FlagEstimate = { targets: [], value: null, cuped: null, holds: [], notes: [], segments: [] };
  if (o.targets.length === 0 || o.targets[o.targets.length - 1]!.match !== null) throw new Error('the last target must be the fallthrough');
  const windowDays = Math.max(o.lookbackDays, o.sequentialWindowDays);
  let mine = rows.filter((r) => {
    if (r.flag_key !== o.flagKey || !o.arms.includes(r.arm)) return false;
    const age = daysBetween(r.exposure_date, o.runDate);
    return age >= 1 && age <= windowDays && (o.epochStart === null || r.exposure_date >= o.epochStart);
  });
  if (o.epochStart !== null) out.notes.push(`reset on ${o.epochStart}: earlier exposure days are ignored`);

  // Score-model change = reset for the 24h-score reward (scores from two models are not comparable).
  if (o.reward === 'predicted_profit' && mine.length > 0) {
    const latest = [...mine].sort((a, b) => (a.exposure_date < b.exposure_date ? 1 : a.exposure_date > b.exposure_date ? -1 : 0))[0]!.model_version;
    const others = new Set(mine.filter((r) => r.model_version !== latest).map((r) => r.model_version));
    if (others.size > 0) {
      mine = mine.filter((r) => r.model_version === latest);
      out.notes.push(`score model changed (${[...others].join(', ')} -> ${latest}): only rows scored by ${latest} are used`);
    }
  }

  const needsMatured = o.reward !== 'predicted_profit';
  if (needsMatured && mine.some((r) => !hasGroup(r, MATURED_COLUMNS))) {
    out.holds.push(`reward ${o.reward} needs the matured-outcome columns (${MATURED_COLUMNS.join(', ')}), which these rows do not carry`);
    return out;
  }
  const guardrailsOn = o.guardrailMetrics.enabled;
  const guardrailData = mine.every((r) => hasGroup(r, GUARDRAIL_COLUMNS) && hasGroup(r, MATURED_COLUMNS));
  if (guardrailsOn && !guardrailData) {
    if (o.guardrailMetrics.requireData) {
      out.holds.push(`guardrail metrics need the columns ${[...GUARDRAIL_COLUMNS, 'matured_converted_users', 'matured_refunded_users'].join(', ')}, which these rows do not carry`);
      return out;
    }
    out.notes.push('guardrail metrics unavailable (columns missing): activation, refund and failed-generation checks skipped');
  }

  // Cells: routing, decay, logged propensity.
  const cells: Cell[] = mine.map((row) => {
    const segment = segmentKey(parseSegmentKey(`${row.country_bucket}|${row.device}|${row.acquisition_channel}`));
    const target = routeSegment(o.targets, segment);
    const age = daysBetween(row.exposure_date, o.runDate);
    const decay = o.halfLifeDays === null ? 1 : Math.pow(0.5, (age - 1) / o.halfLifeDays);
    const served = row.allocation_slice === 'holdout' ? 'holdout' : target;
    const propensity = o.log.weight(row.exposure_date, o.flagKey, served, row.arm) ?? null;
    return { row, age, segment, target, decay, propensity };
  });
  out.segments = [...new Set(cells.map((c) => c.segment))].sort();
  const missing = [...new Set(cells.filter((c) => c.propensity === null).map((c) => `${c.row.exposure_date} ${c.row.allocation_slice === 'holdout' ? 'holdout' : c.target}`))].sort();
  if (missing.length > 0) {
    out.holds.push(`allocation log has no weights for ${missing.length} (day, target) pair(s) with exposures (e.g. ${missing.slice(0, 3).join(', ')}): cannot weight by propensity`);
    return out;
  }
  const inWindow = cells.filter((c) => c.age <= o.lookbackDays);
  /** IPW x decay weight; cells whose arm had 0 logged weight carry no weight (the SRM check flags them). */
  const weightOf = (c: Cell) => (c.propensity! > 0 ? c.decay / c.propensity! : 0);

  // CUPED (24h score only): theta from pooled rows, adjustment with a PRE-exposure covariate.
  let scoreOf = scorePart;
  if (o.reward === 'predicted_profit' && o.cuped) {
    if (inWindow.length > 0 && inWindow.every((c) => hasGroup(c.row, COVARIATE_COLUMNS))) {
      let n = 0;
      let sx = 0;
      let sxx = 0;
      let sy = 0;
      let syy = 0;
      let sxy = 0;
      for (const c of inWindow) {
        n += c.row.scored_users;
        sx += c.row.sum_covariate!;
        sxx += c.row.sum_sq_covariate!;
        sy += c.row.sum_predicted_profit;
        syy += c.row.sum_sq_predicted_profit;
        sxy += c.row.sum_predicted_profit_x_covariate!;
      }
      const xbar = sx / n;
      const varX = sxx / n - xbar * xbar;
      const varY = syy / n - (sy / n) ** 2;
      const cov = sxy / n - xbar * (sy / n);
      if (varX > 1e-12 && varY > 0) {
        const theta = cov / varX;
        out.cuped = { theta, varianceReduction: (cov * cov) / (varX * varY) };
        scoreOf = (r) => {
          const shift = r.sum_covariate! - r.scored_users * xbar;
          const sum = r.sum_predicted_profit - theta * shift;
          const sumSq =
            r.sum_sq_predicted_profit -
            2 * theta * (r.sum_predicted_profit_x_covariate! - xbar * r.sum_predicted_profit) +
            theta * theta * (r.sum_sq_covariate! - 2 * xbar * r.sum_covariate! + r.scored_users * xbar * xbar);
          return { n: r.scored_users, sum, sumSq: Math.max(0, sumSq) };
        };
        out.notes.push(`CUPED on the 24h score: theta ${theta.toFixed(4)}, variance reduction ${(100 * out.cuped.varianceReduction).toFixed(1)}%`);
      }
    } else {
      out.notes.push('CUPED requested but the rows carry no covariate columns: unadjusted 24h score used');
    }
  }

  // Pooled value per conversion (decomposed reward): shared by every arm.
  if (o.reward === 'decomposed_profit') {
    let w = 0;
    let w2 = 0;
    let s = 0;
    let q = 0;
    for (const c of inWindow) {
      const conv = c.row.matured_converted_users ?? 0;
      w += c.decay * conv;
      w2 += c.decay * c.decay * conv;
      s += c.decay * (c.row.sum_matured_value ?? 0);
      q += c.decay * (c.row.sum_sq_matured_value ?? 0);
    }
    if (w > 0) {
      const mean = s / w;
      const v = Math.max(0, q / w - mean * mean);
      out.value = { mean, se: Math.sqrt(v / ((w * w) / w2)), source: 'pooled matured converters (all arms)' };
    } else if (o.valuePerConversionFallback !== null) {
      out.value = { mean: o.valuePerConversionFallback, se: 0, source: 'configured valuePerConversionUsd (no matured converters yet)' };
    } else {
      out.holds.push('decomposed_profit needs a value per conversion: no matured converters in the window and no rewardModel.valuePerConversionUsd');
      return out;
    }
  }
  const value = out.value?.mean ?? 0;
  const rewardPart = (r: ExperimentProfitByArmRow): SufficientStats =>
    o.reward === 'predicted_profit' ? scoreOf(r) : o.reward === 'conversion' ? conversionPart(r) : decomposedPart(r, value);
  const trialsPart = o.reward === 'predicted_profit' ? scoreOf : conversionPart;

  // Weak priors from the pooled flag data, then each arm's global posterior (all targets).
  const flagReward = pooled(inWindow.map((c) => rewardPart(c.row)));
  const flagConversion = pooled(inWindow.map((c) => conversionPart(c.row)));
  const flagCost = pooled(inWindow.map((c) => costPart(c.row)));
  const weakNormal = weakPriorFor(o.reward === 'decomposed_profit' ? flagCost : flagReward, o.prior);
  const weakRate = weakBetaPrior(flagConversion.n > 0 ? flagConversion.sum / flagConversion.n : 0.05, o.prior.meanPseudoCount);

  const momentsOf = (cs: readonly Cell[], part: (r: ExperimentProfitByArmRow) => SufficientStats): Moments =>
    cs.reduce((m, c) => {
      const w = weightOf(c);
      return w > 0 ? addMoments(m, w, part(c.row)) : m;
    }, ZERO_MOMENTS);

  interface Fit {
    posterior: RewardPosterior;
    effectiveN: number;
    rewardUsers: number;
    weightedMean: number | null;
    nig: NigPosterior | null;
    beta: BetaPosterior | null;
  }
  const fit = (cs: readonly Cell[], global: Fit | null): Fit => {
    const trials = effectiveStats(momentsOf(cs, trialsPart));
    const rewardUsers = cs.reduce((acc, c) => acc + trialsPart(c.row).n, 0);
    if (o.reward === 'predicted_profit') {
      const prior = global?.nig ? shrinkagePrior(global.nig, o.shrinkageStrength, weakNormal) : weakNormal;
      const nig = updateNig(prior, trials.stats);
      return { posterior: { kind: 'normal', nig }, effectiveN: trials.nEff, rewardUsers, weightedMean: trials.mean, nig, beta: null };
    }
    const rate = trials.mean ?? 0;
    const betaPrior = global?.beta ? { a: (global.beta.a / (global.beta.a + global.beta.b)) * o.shrinkageStrength, b: (global.beta.b / (global.beta.a + global.beta.b)) * o.shrinkageStrength } : weakRate;
    const beta = updateBeta(betaPrior, trials.nEff, trials.nEff * rate);
    if (o.reward === 'conversion') {
      return { posterior: { kind: 'rate', beta }, effectiveN: trials.nEff, rewardUsers, weightedMean: trials.mean, nig: null, beta };
    }
    const cost = effectiveStats(momentsOf(cs, costPart));
    const costPrior = global?.nig ? shrinkagePrior(global.nig, o.shrinkageStrength, weakNormal) : weakNormal;
    const nig = updateNig(costPrior, cost.stats);
    const weightedMean = trials.mean === null || cost.mean === null ? null : trials.mean * value - cost.mean;
    return { posterior: { kind: 'decomposed', conversion: beta, cost: nig, value: out.value! }, effectiveN: trials.nEff, rewardUsers, weightedMean, nig, beta };
  };

  const globalFit = new Map(o.arms.map((arm) => [arm, fit(inWindow.filter((c) => c.row.arm === arm), null)] as const));
  const allSegments = out.segments;
  const g = o.guardrails;
  const control: ControlSpec = g.stopLoss.control;

  for (const t of o.targets) {
    const tCells = cells.filter((c) => c.target === t.name);
    const tWindow = tCells.filter((c) => c.age <= o.lookbackDays);
    const segments = [...new Set(tCells.map((c) => c.segment))].sort();
    const coversAll = segments.length === allSegments.length && allSegments.length > 0;
    const notes: string[] = [];

    // MDE-based minimum sample from the pooled per-user variance of the reward in this target.
    const pooledReward = pooled(tWindow.map((c) => rewardPart(c.row)));
    const rewardVariance = variance(pooledReward);
    const requiredN =
      pooledReward.n > 1
        ? requiredSampleSize({ variance: rewardVariance, mde: g.minimumDetectableEffect, alpha: g.mdeAlpha, power: g.power, floor: g.minSamplesPerArm })
        : g.minSamplesPerArm;

    // Control of the stop-loss: the holdout users of this target's segments (all arms), or a named arm.
    const controlCells =
      control.kind === 'holdout_mean' ? tCells.filter((c) => c.row.allocation_slice === 'holdout') : tCells.filter((c) => c.row.allocation_slice === 'bandit' && c.row.arm === control.arm);
    const controlWindow = pooled(controlCells.filter((c) => c.age <= o.lookbackDays).map((c) => rewardPart(c.row)));
    const controlSummary = {
      mean: controlWindow.n > 0 ? controlWindow.sum / controlWindow.n : null,
      n: controlWindow.n,
      source: control.kind === 'holdout_mean' ? 'holdout (fixed uniform split), same segments' : `arm ${control.arm}`,
    };
    const guardrailControl = tCells.filter((c) => c.row.allocation_slice === 'holdout');

    const arms: ArmEstimate[] = o.arms.map((arm) => {
      const armWindow = tWindow.filter((c) => c.row.arm === arm);
      const f = fit(armWindow, coversAll ? null : globalFit.get(arm)!);
      // Every user of the arm in this target, holdout slice included: a stopped arm keeps getting
      // holdout users, so its evidence keeps growing and it can recover. Those users are also in the
      // holdout control; the positive covariance makes the independent-variance test conservative.
      const treatment = tCells.filter((c) => c.row.arm === arm);
      const stopLossTest =
        g.stopLoss.enabled && !(control.kind === 'arm' && control.arm === arm)
          ? sequentialTest(contrastDays(treatment, controlCells, rewardPart), { alpha: g.stopLoss.alpha, tau: g.stopLoss.tau, minTreatmentN: g.stopLoss.minArmSamples, minControlN: g.stopLoss.minControlSamples })
          : null;
      const guardrails: GuardrailResult[] =
        guardrailsOn && guardrailData
          ? GUARDRAIL_METRICS.map((metric) => {
              const gm = o.guardrailMetrics;
              const margin = metric === 'activation' ? gm.activationMargin : metric === 'refunds' ? gm.refundMargin : gm.failedGenerationMargin;
              const test = sequentialTest(contrastDays(treatment, guardrailControl, GUARDRAIL_PART[metric]), { alpha: gm.alpha, tau: Math.max(margin, 1e-6), minTreatmentN: gm.minTreatmentN, minControlN: gm.minControlN });
              let breach: string | null = null;
              const pc = (x: number) => `${(100 * x).toFixed(1)}%`;
              if (test && metric === 'activation' && test.upper < -margin) {
                breach = `activation ${pc(test.treatmentMean)} vs holdout ${pc(test.controlMean)}: always-valid CS for the difference ${pc(test.lower)} to ${pc(test.upper)} is below -${pc(margin)}`;
              } else if (test && metric !== 'activation' && test.lower > margin) {
                const label = metric === 'refunds' ? 'refund rate among converters' : 'failed-generation rate';
                breach = `${label} ${pc(test.treatmentMean)} vs holdout ${pc(test.controlMean)}: always-valid CS for the difference ${pc(test.lower)} to ${pc(test.upper)} is above +${pc(margin)}`;
              }
              return { metric, test, breach };
            })
          : [];
      return { arm, posterior: f.posterior, effectiveN: f.effectiveN, rewardUsers: f.rewardUsers, weightedMean: f.weightedMean, stopLossTest, guardrails };
    });
    if (g.stopLoss.enabled && arms.every((a) => a.stopLossTest === null)) {
      const cN = pooled(controlCells.map((c) => rewardPart(c.row))).n;
      notes.push(
        cN < g.stopLoss.minControlSamples
          ? `stop-loss not evaluated: the control has ${Math.round(cN)} users ${o.epochStart ? 'since the reset' : 'in the sequential window'} < ${g.stopLoss.minControlSamples}`
          : `stop-loss not evaluated: no arm has ${g.stopLoss.minArmSamples} users in this target yet`,
      );
    }
    out.targets.push({ name: t.name, segments, coversAll, arms, requiredN, rewardVariance, control: controlSummary, notes });
  }
  return out;
}

/** The latest reset date (<= runDate) that applies to this flag; null when there is none. */
export function epochStartFor(resets: ReadonlyArray<{ date: string; flagKey: string | null }>, flagKey: string, runDate: string): string | null {
  const dates = resets.filter((r) => (r.flagKey === null || r.flagKey === flagKey) && r.date <= runDate).map((r) => r.date);
  return dates.length > 0 ? dates.sort().at(-1)! : null;
}

/** Exposure dates [runDate - days, runDate - 1] (for allocation logs and data checks). */
export function windowDates(runDate: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(runDate, -days + i));
}
