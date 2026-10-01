/**
 * Thompson sampling allocation for one allocation target (the fallthrough or one LaunchDarkly
 * rule), with the guardrails. The posterior models live in posterior.ts (re-exported here).
 *
 * Per arm the job supplies a reward posterior, its effective sample size (Kish, after time decay
 * and inverse-propensity weighting), an always-valid stop-loss test against the control
 * (sequential.ts) and any non-profit guardrail breaches. Then:
 *   1. stops: an arm whose always-valid confidence sequence for (arm - control) lies entirely
 *      below 0, or that breaches a guardrail (activation, refunds, failed generations), goes to 0%.
 *      The test is valid over every daily look, so a null arm is stopped with probability <= alpha
 *      over the whole experiment (the old rule compared the arm's own upper bound with the control's
 *      POINT estimate and fired on 20-30% of null arms per look);
 *   2. phases: every ACTIVE (non-stopped) arm is `mature` once its effective sample reaches the
 *      MDE-based minimum, else `warming`. Stopped arms never block the rule;
 *   3. warm start: a warming arm is held at no less than `warmStartShare`, so a new arm added at 0%
 *      gets traffic instead of deadlocking the flag;
 *   4. Thompson probability matching among mature arms (P(best) from seeded Monte-Carlo draws),
 *      only when the expected loss of the current split, E[max_j mu_j - mu_k] averaged over the
 *      current weights, is at least `minExpectedLossToMove` (otherwise the arms are practically
 *      equivalent and the flag is not churned);
 *   5. the result is projected onto { exploration floor (warm-start share for warming arms) <= w,
 *      |w - current| <= maxDailyChange, sum w = 1 }; the cap is relaxed only as far as a stop, a
 *      floor or a warm start forces, and the report says so;
 *   6. changes below `minChangeToPatch` are not patched; weights become LaunchDarkly integers.
 * The fixed holdout slice lives outside this module: a separate LaunchDarkly rule the job never
 * edits (see launchdarkly.ts). It is the control of the stop-loss and the guardrails.
 */

import { rewardInterval, rewardMean, thompsonSummary, type RewardPosterior } from './posterior.js';
import type { SeededRng } from './rng.js';
import type { SequentialTestResult } from './sequential.js';

export * from './posterior.js';

// ---------------------------------------------------------------------------
// Weight projection and integer rounding
// ---------------------------------------------------------------------------

/**
 * Euclidean projection of `target` onto { w : sum w = 1, lo <= w <= hi }:
 * w_k = clip(target_k + lambda, lo_k, hi_k) with lambda found by bisection.
 */
export function projectOntoBoundedSimplex(target: readonly number[], lo: readonly number[], hi: readonly number[]): number[] {
  const k = target.length;
  if (lo.length !== k || hi.length !== k) throw new Error('projection: length mismatch');
  const sumLo = lo.reduce((a, b) => a + b, 0);
  const sumHi = hi.reduce((a, b) => a + b, 0);
  if (sumLo > 1 + 1e-12 || sumHi < 1 - 1e-12) throw new Error(`projection infeasible: sum(lo)=${sumLo}, sum(hi)=${sumHi}`);
  for (let i = 0; i < k; i += 1) if (lo[i]! > hi[i]! + 1e-15) throw new Error(`projection infeasible at ${i}: lo > hi`);
  const at = (lambda: number) => target.map((t, i) => Math.min(hi[i]!, Math.max(lo[i]!, t + lambda)));
  const total = (lambda: number) => at(lambda).reduce((a, b) => a + b, 0);
  let a = Math.min(...lo.map((l, i) => l - target[i]!)) - 1;
  let b = Math.max(...hi.map((h, i) => h - target[i]!)) + 1;
  for (let i = 0; i < 300; i += 1) {
    const mid = 0.5 * (a + b);
    if (total(mid) < 1) a = mid;
    else b = mid;
  }
  return at(0.5 * (a + b));
}

/**
 * Integer weights (LaunchDarkly: thousandths of a percent, summing to 100000) by largest
 * remainder, never below each arm's floor. Values within 1e-6 of an integer snap to it so
 * float noise cannot cost a floored arm a unit. Throws (instead of looping forever) when no
 * weight is positive or a weight is not a finite non-negative number.
 */
export function toUnits(weights: readonly number[], total: number, floors: readonly number[]): number[] {
  if (weights.length === 0) throw new Error('toUnits: no weights');
  if (floors.length !== weights.length) throw new Error('toUnits: floors length mismatch');
  if (!Number.isInteger(total) || total <= 0) throw new Error(`toUnits: total must be a positive integer, got ${total}`);
  if (weights.some((w) => !Number.isFinite(w) || w < -1e-12)) throw new Error(`toUnits: weights must be finite and non-negative, got ${JSON.stringify(weights)}`);
  if (!weights.some((w) => w > 0)) throw new Error('toUnits: at least one weight must be positive');
  if (floors.some((f) => !Number.isInteger(f) || f < 0) || floors.reduce((a, b) => a + b, 0) > total) throw new Error('toUnits: floors must be non-negative integers summing to at most the total');
  const raw = weights.map((w) => {
    const x = Math.max(0, w) * total;
    const r = Math.round(x);
    return Math.abs(x - r) < 1e-6 ? r : x;
  });
  const units = raw.map((x) => Math.floor(x));
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .filter((p) => raw[p.i]! > 0)
    .sort((p, q) => q.frac - p.frac || p.i - q.i)
    .map((p) => p.i);
  let diff = total - units.reduce((a, b) => a + b, 0);
  for (let j = 0; diff > 0; j = (j + 1) % order.length) {
    units[order[j]!]! += 1;
    diff -= 1;
  }
  // Floors first (take from the arm with the most slack above its own floor), then any excess.
  for (let i = 0; i < units.length; i += 1) {
    while (units[i]! < floors[i]!) {
      const donor = slackiest(units, floors, i);
      units[donor]! -= 1;
      units[i]! += 1;
    }
  }
  while (diff < 0) {
    const donor = slackiest(units, floors, -1);
    units[donor]! -= 1;
    diff += 1;
  }
  if (units.reduce((a, b) => a + b, 0) !== total) throw new Error('toUnits: rounding failed');
  return units;
}

function slackiest(units: number[], floors: readonly number[], except: number): number {
  let best = -1;
  let bestSlack = 0;
  for (let j = 0; j < units.length; j += 1) {
    if (j === except) continue;
    const slack = units[j]! - floors[j]!;
    if (slack > bestSlack) {
      bestSlack = slack;
      best = j;
    }
  }
  if (best < 0) throw new Error('toUnits: floors exceed the total');
  return best;
}

// ---------------------------------------------------------------------------
// One allocation target (the fallthrough or one LaunchDarkly rule)
// ---------------------------------------------------------------------------

export type ControlSpec = { kind: 'holdout_mean' } | { kind: 'arm'; arm: string };

export interface StopLossConfig {
  enabled: boolean;
  /** P(ever stopping an arm that is not worse than the control), over all daily looks, per arm and target. */
  alpha: number;
  /** Mixture scale of the always-valid test in reward units (the effect size it is tightest for). */
  tau: number;
  control: ControlSpec;
  /** Control users needed before the test is evaluated. */
  minControlSamples: number;
  /** Arm users needed before the test is evaluated (the CLT behind the plug-in variance). */
  minArmSamples: number;
}

export interface GuardrailConfig {
  /** Every non-stopped arm keeps at least this share of the target's traffic. */
  minExplorationShare: number;
  /** An active arm below the minimum sample keeps at least this share (no new-arm deadlock). */
  warmStartShare: number;
  /** Largest absolute change of one arm's share per daily run. */
  maxDailyChange: number;
  /** Floor of the MDE-based minimum: effective users per active arm before Thompson moves weights. */
  minSamplesPerArm: number;
  /** Minimum detectable effect in reward units per exposed user (USD for the profit rewards). */
  minimumDetectableEffect: number;
  /** Two-sided alpha and power of the fixed-n power calculation behind the minimum sample. */
  mdeAlpha: number;
  power: number;
  /** Thompson moves only when the current split's expected loss per user is at least this. */
  minExpectedLossToMove: number;
  /** Changes smaller than this (max over arms) are not patched. */
  minChangeToPatch: number;
  thompsonDraws: number;
  stopLoss: StopLossConfig;
}

export const DEFAULT_GUARDRAILS: Readonly<GuardrailConfig> = Object.freeze<GuardrailConfig>({
  minExplorationShare: 0.05,
  warmStartShare: 0.1,
  maxDailyChange: 0.1,
  minSamplesPerArm: 300,
  minimumDetectableEffect: 2,
  mdeAlpha: 0.05,
  power: 0.8,
  minExpectedLossToMove: 0.02,
  minChangeToPatch: 0.005,
  thompsonDraws: 20_000,
  stopLoss: { enabled: true, alpha: 0.05, tau: 2, control: { kind: 'holdout_mean' }, minControlSamples: 500, minArmSamples: 300 },
});

export interface ArmObservation {
  arm: string;
  posterior: RewardPosterior;
  /** Effective sample size behind the posterior (Kish, after decay and IPW): drives the minimum-sample rule. */
  effectiveN: number;
  /** Real users behind the reward since the last reset (reporting only). */
  rewardUsers: number;
  /** Current share of this target's traffic (LaunchDarkly weight / 100000). */
  currentWeight: number;
  /** Always-valid two-sample test of this arm against the control (null: not evaluable yet). */
  stopLossTest?: SequentialTestResult | null;
  /** Non-profit guardrail breaches against the holdout. */
  guardrailBreaches?: readonly string[];
}

export interface TargetContext {
  /** Effective users each ACTIVE arm needs before Thompson may move weights (MDE-based). */
  requiredN: number;
  control?: { mean: number | null; n: number; source: string | null };
  /** Target-level notes shown first in the reasons (e.g. why the stop-loss could not run). */
  notes?: readonly string[];
  /** Formats reward values (USD or rate) in reasons. */
  format?: (x: number) => string;
}

export interface ArmDecision {
  arm: string;
  rewardUsers: number;
  effectiveN: number;
  posteriorMean: number;
  lower95: number;
  upper95: number;
  /** P(best) among mature arms; null when Thompson did not run. */
  pBest: number | null;
  /** E[max_j mu_j - mu_k] among mature arms; null when Thompson did not run. */
  expectedLoss: number | null;
  /** The always-valid stop-loss test, when evaluated. */
  stopLoss: { estimate: number; lower: number; upper: number; alpha: number } | null;
  currentWeight: number;
  /** Thompson target before the guardrail projection; null when Thompson did not move this arm. */
  targetWeight: number | null;
  proposedWeight: number;
  proposedUnits: number;
  stopped: boolean;
  phase: 'stopped' | 'warming' | 'mature';
  reasons: string[];
}

export interface TargetDecision {
  status: 'moved' | 'unchanged' | 'held';
  reasons: string[];
  requiredN: number;
  controlMean: number | null;
  controlN: number;
  controlSource: string | null;
  /** Set when a stop, a floor or a warm start forced a larger move than maxDailyChange. */
  capRelaxedTo: number | null;
  /** Expected loss per user of the current split among mature arms; null when Thompson did not run. */
  expectedLossCurrent: number | null;
  arms: ArmDecision[];
}

export const LD_WEIGHT_TOTAL = 100_000;

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const pp = (x: number) => `${(100 * x).toFixed(1)}pp`;
const num = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4));
const EPS = 1e-9;

/** Smallest cap c >= base with ok(c), by bisection (ok monotone in c). */
function relaxCap(base: number, ok: (cap: number) => boolean): number {
  if (ok(base)) return base;
  let lo = base;
  let hi = 1;
  if (!ok(hi)) throw new Error('guardrails infeasible even with an unlimited daily change');
  for (let i = 0; i < 100; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function decideTarget(observations: readonly ArmObservation[], cfg: GuardrailConfig, rng: SeededRng, ctx: TargetContext): TargetDecision {
  const fmt = ctx.format ?? num;
  const control = ctx.control ?? { mean: null, n: 0, source: null };
  if (observations.length === 0) {
    return { status: 'held', reasons: ['no arms to allocate'], requiredN: ctx.requiredN, controlMean: control.mean, controlN: control.n, controlSource: control.source, capRelaxedTo: null, expectedLossCurrent: null, arms: [] };
  }
  const k = observations.length;
  const floor = cfg.minExplorationShare;
  const warm = Math.max(cfg.warmStartShare, floor);
  if (floor * k > 1 + 1e-12) throw new Error(`minExplorationShare ${floor} x ${k} arms exceeds 100%`);
  if (warm * k > 1 + 1e-12) throw new Error(`warmStartShare ${warm} x ${k} arms exceeds 100%`);
  const current = observations.map((o) => o.currentWeight);
  if (current.some((c) => !Number.isFinite(c) || c < -EPS || c > 1 + EPS)) throw new Error(`current weights must be in [0, 1], got ${JSON.stringify(current)}`);
  const currentSum = current.reduce((a, b) => a + b, 0);
  if (Math.abs(currentSum - 1) > 1e-9) throw new Error(`current weights must sum to 1, got ${currentSum}`);
  if (!(ctx.requiredN >= 0)) throw new Error(`requiredN must be >= 0, got ${ctx.requiredN}`);

  const arms: ArmDecision[] = observations.map((o) => {
    const ci = rewardInterval(o.posterior, 0.95);
    const t = o.stopLossTest ?? null;
    return {
      arm: o.arm,
      rewardUsers: o.rewardUsers,
      effectiveN: o.effectiveN,
      posteriorMean: rewardMean(o.posterior),
      lower95: ci.lower,
      upper95: ci.upper,
      pBest: null,
      expectedLoss: null,
      stopLoss: t ? { estimate: t.estimate, lower: t.lower, upper: t.upper, alpha: t.alpha } : null,
      currentWeight: o.currentWeight,
      targetWeight: null,
      proposedWeight: o.currentWeight,
      proposedUnits: 0,
      stopped: false,
      phase: 'mature',
      reasons: [],
    };
  });
  const reasons: string[] = [...(ctx.notes ?? [])];
  // Declared before any early return: finish() reads them.
  let active: boolean[] = arms.map(() => true);
  let expectedLossCurrent: number | null = null;
  const lowerBound = (i: number) => (!active[i] ? 0 : arms[i]!.phase === 'warming' ? warm : floor);

  // --- 1. stops: guardrail breaches and the always-valid stop-loss ----------------------
  const controlArm = cfg.stopLoss.control.kind === 'arm' ? cfg.stopLoss.control.arm : null;
  if (controlArm !== null && !observations.some((o) => o.arm === controlArm)) throw new Error(`control arm ${controlArm} is not an arm of this target`);
  observations.forEach((o, i) => {
    const a = arms[i]!;
    for (const breach of o.guardrailBreaches ?? []) {
      a.stopped = true;
      a.reasons.push(`guardrail: ${breach}`);
    }
    const t = o.stopLossTest ?? null;
    if (cfg.stopLoss.enabled && t && o.arm !== controlArm && t.upper < 0) {
      a.stopped = true;
      a.reasons.push(
        `stop-loss: always-valid ${pct(1 - t.alpha)} confidence sequence for (arm - control) is ${fmt(t.lower)} to ${fmt(t.upper)}, entirely below 0 (${t.days} day-matched day(s), ${Math.round(t.treatmentN)} arm vs ${Math.round(t.controlN)} control users)`,
      );
    }
  });
  if (arms.every((a) => a.stopped)) {
    arms.forEach((a) => {
      a.stopped = false;
      a.reasons = [];
    });
    return finish('held', [...reasons, 'the stop-loss and guardrails would stop every arm: control and arm estimates contradict each other (check holdout assignment / SRM); holding']);
  }
  active = arms.map((a) => !a.stopped);

  // --- 2. phases (stopped arms never count toward the minimum sample) ----------------------
  arms.forEach((a, i) => {
    a.phase = a.stopped ? 'stopped' : observations[i]!.effectiveN >= ctx.requiredN ? 'mature' : 'warming';
  });
  const mature = arms.map((_, i) => i).filter((i) => arms[i]!.phase === 'mature');
  const warming = arms.map((_, i) => i).filter((i) => arms[i]!.phase === 'warming');
  if (warming.length > 0) {
    const why = warming.map((i) => `${arms[i]!.arm} has ${Math.round(observations[i]!.effectiveN)} effective users < ${ctx.requiredN}`).join('; ');
    reasons.push(
      mature.length >= 2
        ? `minimum sample not met for ${why}: ${warming.length === 1 ? 'it keeps' : 'they keep'} at least the ${pct(warm)} warm-start share while Thompson allocates the rest`
        : `minimum sample size not met: ${why}${warming.some((i) => current[i]! < warm - EPS) ? `; under-sampled arms are raised to the ${pct(warm)} warm-start share` : ''}`,
    );
  }

  // --- 3. Thompson among mature arms, gated by expected loss --------------------------------
  const target = current.map((c, i) => (active[i] ? c : 0));
  let thompsonMoves = false;
  if (mature.length >= 2) {
    const s = thompsonSummary(
      mature.map((i) => observations[i]!.posterior),
      rng,
      cfg.thompsonDraws,
    );
    mature.forEach((i, j) => {
      arms[i]!.pBest = s.pBest[j]!;
      arms[i]!.expectedLoss = s.expectedLoss[j]!;
    });
    const cm = mature.map((i) => current[i]!);
    const cmSum = cm.reduce((a, b) => a + b, 0);
    expectedLossCurrent = cmSum > EPS ? mature.reduce((acc, _, j) => acc + (cm[j]! / cmSum) * s.expectedLoss[j]!, 0) : s.expectedLoss.reduce((a, b) => a + b, 0) / mature.length;
    if (expectedLossCurrent < cfg.minExpectedLossToMove) {
      reasons.push(
        `expected loss of the current split among mature arms is ${fmt(expectedLossCurrent)} per user < ${fmt(cfg.minExpectedLossToMove)}: the arms are practically equivalent, so Thompson does not move them`,
      );
    } else {
      const warmMass = warming.reduce((acc, i) => acc + Math.max(current[i]!, warm), 0);
      const rest = Math.max(0, 1 - warmMass);
      mature.forEach((i, j) => {
        target[i] = rest * s.pBest[j]!;
        arms[i]!.targetWeight = target[i]!;
      });
      warming.forEach((i) => {
        target[i] = Math.max(current[i]!, warm);
      });
      thompsonMoves = true;
    }
  }

  const stoppedWithTraffic = arms.some((a, i) => a.stopped && current[i]! > EPS);
  const lifts = arms.map((_, i) => i).filter((i) => active[i] && current[i]! < lowerBound(i) - EPS);
  if (!thompsonMoves && !stoppedWithTraffic && lifts.length === 0) {
    return finish(mature.length >= 2 && warming.length === 0 ? 'unchanged' : 'held', reasons);
  }

  // --- 4. projection: exploration floor / warm-start share, daily change cap ------------------
  const lowerAt = (cap: number) => current.map((c, i) => (active[i] ? Math.max(lowerBound(i), c - cap) : 0));
  const upperAt = (cap: number) => current.map((c, i) => (active[i] ? Math.min(1, c + cap) : 0));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const downCap = relaxCap(cfg.maxDailyChange, (cap) => sum(lowerAt(cap)) <= 1 + 1e-12);
  // Every active arm must be able to reach its own lower bound today (an arm at 0% needs +floor).
  const liftNeeded = Math.max(0, ...current.map((c, i) => (active[i] ? lowerBound(i) - c : 0)));
  const upCap = Math.max(liftNeeded, relaxCap(cfg.maxDailyChange, (cap) => sum(upperAt(cap)) >= 1 - 1e-12));
  const lo = lowerAt(downCap);
  const hi = upperAt(upCap);
  const relaxed = Math.max(downCap, upCap);
  const capRelaxedTo = relaxed > cfg.maxDailyChange + 1e-12 ? relaxed : null;
  if (capRelaxedTo !== null) {
    const cause = stoppedWithTraffic ? 'stop-loss / guardrail' : lifts.some((i) => arms[i]!.phase === 'warming') ? 'warm start' : 'exploration floor';
    reasons.push(`daily change cap relaxed from ${pp(cfg.maxDailyChange)} to ${pp(capRelaxedTo)} (${cause} needs it)`);
  }
  const proposed = projectOntoBoundedSimplex(target, lo, hi);

  const maxChange = Math.max(...proposed.map((w, i) => Math.abs(w - current[i]!)));
  if (!stoppedWithTraffic && maxChange < cfg.minChangeToPatch) {
    arms.forEach((a) => {
      if (Math.abs(a.currentWeight - floor) < EPS) a.reasons.push(`at the ${pct(floor)} exploration floor`);
      a.reasons.push(`no change: largest move ${pp(maxChange)} < ${pp(cfg.minChangeToPatch)}`);
    });
    return finish(thompsonMoves ? 'unchanged' : 'held', reasons);
  }

  arms.forEach((a, i) => {
    const w = proposed[i]!;
    if (a.stopped) return;
    if (a.targetWeight !== null) a.reasons.push(`P(best) ${pct(a.pBest ?? 0)} -> Thompson target ${pct(a.targetWeight)}`);
    if (a.phase === 'warming' && current[i]! < warm - EPS) a.reasons.push(`warm start: raised toward the ${pct(warm)} warm-start share (under the minimum sample)`);
    if (Math.abs(w - floor) < EPS && lo[i]! <= floor + EPS) a.reasons.push(`held at the ${pct(floor)} exploration floor`);
    else if (Math.abs(w - hi[i]!) < EPS && hi[i]! < 1 - EPS) a.reasons.push(`limited by the daily change cap (+${pp(hi[i]! - current[i]!)})`);
    else if (Math.abs(w - lo[i]!) < EPS && lo[i]! > lowerBound(i) + EPS) a.reasons.push(`limited by the daily change cap (-${pp(current[i]! - lo[i]!)})`);
    const delta = Math.round((w - a.currentWeight) * 1e6) / 1e6;
    a.reasons.push(`${pct(a.currentWeight)} -> ${pct(w)} (${delta >= 0 ? '+' : ''}${pp(delta === 0 ? 0 : delta)})`);
  });
  return finish('moved', reasons, proposed, capRelaxedTo);

  function finish(status: TargetDecision['status'], why: string[], weights: readonly number[] = current, relaxedTo: number | null = null): TargetDecision {
    const floorsUnits = arms.map((_, i) => (status === 'moved' && active[i] ? Math.round(lowerBound(i) * LD_WEIGHT_TOTAL) : 0));
    const units = toUnits(weights, LD_WEIGHT_TOTAL, floorsUnits);
    arms.forEach((a, i) => {
      a.proposedWeight = weights[i]!;
      a.proposedUnits = units[i]!;
    });
    return {
      status,
      reasons: why,
      requiredN: ctx.requiredN,
      controlMean: control.mean,
      controlN: control.n,
      controlSource: control.source,
      capRelaxedTo: status === 'moved' ? relaxedTo : null,
      expectedLossCurrent,
      arms,
    };
  }
}
