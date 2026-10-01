/**
 * Posterior models of the per-exposed-user reward of one arm, and the Monte-Carlo summaries the
 * allocator needs from them (P(best), expected loss).
 *
 * Three reward models (config `reward`):
 *   decomposed_profit (default)  mu = p x V - C, per EXPOSED user (the unconditional estimand):
 *                                  p  matured conversion rate, Beta-Binomial;
 *                                  V  value per conversion, POOLED across arms (and winsorized per
 *                                     user upstream), shared by every arm in a draw;
 *                                  C  measured serving cost per exposed user, Normal-Inverse-Gamma.
 *                                Replacing each converter's own (very dispersed: $10 monthly to $2k
 *                                annual) value by the pooled V is what makes this far less noisy than
 *                                raw profit per user (SD ~$90); the price is the assumption that the
 *                                default model does not change value per conversion.
 *   predicted_profit             the 24h predicted-profit score, NIG (optionally CUPED-adjusted).
 *   conversion                   the matured conversion rate alone, Beta-Binomial.
 *
 * NIG model. Rewards x ~ N(mu, sigma^2) with both unknown; conjugate prior NIG(mu0, kappa0, alpha0,
 * beta0): sigma^2 ~ InvGamma(alpha0, beta0), mu | sigma^2 ~ N(mu0, sigma^2 / kappa0). Given (n, sum,
 * sum of squares): kappa = kappa0 + n, mu = (kappa0 mu0 + n xbar) / kappa, alpha = alpha0 + n / 2,
 * beta = beta0 + S / 2 + kappa0 n (xbar - mu0)^2 / (2 kappa); the marginal of mu is Student t with
 * 2 alpha df, location mu, scale sqrt(beta / (alpha kappa)).
 */

import type { SeededRng } from './rng.js';
import { betaQuantile, normalQuantile, studentTQuantile } from './stats.js';

// ---------------------------------------------------------------------------
// Sufficient statistics
// ---------------------------------------------------------------------------

/** n may be fractional (effective sample sizes after decay and inverse-propensity weighting). */
export interface SufficientStats {
  n: number;
  sum: number;
  sumSq: number;
}

export const EMPTY_STATS: Readonly<SufficientStats> = Object.freeze({ n: 0, sum: 0, sumSq: 0 });

export function statsOf(values: readonly number[]): SufficientStats {
  let sum = 0;
  let sumSq = 0;
  for (const v of values) {
    sum += v;
    sumSq += v * v;
  }
  return { n: values.length, sum, sumSq };
}

export function addStats(a: SufficientStats, b: SufficientStats): SufficientStats {
  return { n: a.n + b.n, sum: a.sum + b.sum, sumSq: a.sumSq + b.sumSq };
}

export function scaleStats(s: SufficientStats, weight: number): SufficientStats {
  return { n: s.n * weight, sum: s.sum * weight, sumSq: s.sumSq * weight };
}

export function meanOf(s: SufficientStats): number | null {
  return s.n > 0 ? s.sum / s.n : null;
}

/** Population variance (S / n), clamped at 0 against rounding. */
export function varianceOf(s: SufficientStats): number | null {
  if (s.n <= 0) return null;
  const m = s.sum / s.n;
  return Math.max(0, s.sumSq / s.n - m * m);
}

// ---------------------------------------------------------------------------
// Normal-Inverse-Gamma
// ---------------------------------------------------------------------------

export interface NigPrior {
  mu0: number;
  kappa0: number;
  alpha0: number;
  beta0: number;
}

export interface NigPosterior {
  mu: number;
  kappa: number;
  alpha: number;
  beta: number;
}

function assertPrior(p: NigPrior): void {
  if (!(p.kappa0 > 0 && p.alpha0 > 0 && p.beta0 > 0) || !Number.isFinite(p.mu0)) {
    throw new Error(`invalid NIG prior ${JSON.stringify(p)}`);
  }
}

export function updateNig(prior: NigPrior, s: SufficientStats): NigPosterior {
  assertPrior(prior);
  if (!(s.n > 0)) return { mu: prior.mu0, kappa: prior.kappa0, alpha: prior.alpha0, beta: prior.beta0 };
  const mean = s.sum / s.n;
  const centeredSs = Math.max(0, s.sumSq - s.n * mean * mean);
  const kappa = prior.kappa0 + s.n;
  const mu = (prior.kappa0 * prior.mu0 + s.sum) / kappa;
  const alpha = prior.alpha0 + s.n / 2;
  const beta = prior.beta0 + centeredSs / 2 + (prior.kappa0 * s.n * (mean - prior.mu0) ** 2) / (2 * kappa);
  return { mu, kappa, alpha, beta };
}

/** Student-t marginal posterior of the mean. */
export function marginalOfMean(post: NigPosterior): { location: number; scale: number; df: number } {
  return { location: post.mu, scale: Math.sqrt(post.beta / (post.alpha * post.kappa)), df: 2 * post.alpha };
}

/** Two-sided equal-tailed credible interval for the mean. */
export function credibleInterval(post: NigPosterior, level: number): { lower: number; upper: number } {
  const m = marginalOfMean(post);
  const q = studentTQuantile(0.5 + level / 2, m.df);
  return { lower: m.location - q * m.scale, upper: m.location + q * m.scale };
}

/** One-sided upper credible bound: P(mu <= bound | data) = level. */
export function upperCredibleBound(post: NigPosterior, level: number): number {
  const m = marginalOfMean(post);
  return m.location + studentTQuantile(level, m.df) * m.scale;
}

/** One Thompson draw of the mean: sigma^2 ~ InvGamma(alpha, beta), mu ~ N(mu, sigma^2 / kappa). */
export function drawMean(post: NigPosterior, rng: SeededRng): number {
  const sigma2 = post.beta / rng.gamma(post.alpha);
  return post.mu + Math.sqrt(sigma2 / post.kappa) * rng.normal();
}

/** Posterior variance of the mean (infinite while alpha <= 1). */
export function nigMeanVariance(post: NigPosterior): number {
  return post.alpha > 1 ? post.beta / (post.kappa * (post.alpha - 1)) : Number.POSITIVE_INFINITY;
}

/** Monte-Carlo P(arm k has the largest mean) for NIG posteriors. Deterministic for a given rng state. */
export function probabilityBest(posteriors: readonly NigPosterior[], rng: SeededRng, draws: number): number[] {
  return thompsonSummary(
    posteriors.map((nig) => ({ kind: 'normal', nig }) as const),
    rng,
    draws,
  ).pBest;
}

export interface PriorStrength {
  /** kappa0 of the weak prior, in pseudo-users (also the pseudo-count of the Beta prior). */
  meanPseudoCount: number;
  /** nu0 = 2 (alpha0 - 1): pseudo-users behind the prior variance. */
  variancePseudoCount: number;
}

/**
 * Weakly informative, data-scaled prior (empirical Bayes on the pooled rewards of all arms):
 * centred on the pooled mean, with prior E[sigma^2] equal to the pooled variance.
 */
export function weakPriorFor(pooled: SufficientStats, strength: PriorStrength): NigPrior {
  const mean = meanOf(pooled) ?? 0;
  const variance = varianceOf(pooled) ?? 0;
  const floor = 1e-9 * (1 + mean * mean);
  const alpha0 = 1 + strength.variancePseudoCount / 2;
  return { mu0: mean, kappa0: strength.meanPseudoCount, alpha0, beta0: (alpha0 - 1) * Math.max(variance, floor) };
}

/**
 * Partial pooling: a segment/rule prior centred on the arm's global posterior mean with
 * `strength` pseudo-users, so sparse segments shrink toward the arm's global performance.
 */
export function shrinkagePrior(global: NigPosterior, strength: number, weak: NigPrior): NigPrior {
  if (!(weak.alpha0 > 1)) throw new Error('shrinkagePrior needs weak.alpha0 > 1');
  const sigma2 = global.alpha > 1 ? global.beta / (global.alpha - 1) : weak.beta0 / (weak.alpha0 - 1);
  return { mu0: global.mu, kappa0: strength, alpha0: weak.alpha0, beta0: (weak.alpha0 - 1) * sigma2 };
}

// ---------------------------------------------------------------------------
// Beta-Binomial
// ---------------------------------------------------------------------------

export interface BetaPosterior {
  a: number;
  b: number;
}

/** Beta prior centred on the pooled rate with `pseudoCount` pseudo-users. */
export function weakBetaPrior(pooledRate: number, pseudoCount: number): BetaPosterior {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, Number.isFinite(pooledRate) ? pooledRate : 0.5));
  return { a: p * pseudoCount, b: (1 - p) * pseudoCount };
}

/** Beta update with (possibly effective, fractional) trials and successes. */
export function updateBeta(prior: BetaPosterior, trials: number, successes: number): BetaPosterior {
  if (!(prior.a > 0 && prior.b > 0)) throw new Error(`invalid Beta prior ${JSON.stringify(prior)}`);
  const t = Math.max(0, trials);
  const s = Math.min(t, Math.max(0, successes));
  return { a: prior.a + s, b: prior.b + t - s };
}

export const betaMean = (p: BetaPosterior) => p.a / (p.a + p.b);
export const betaVariance = (p: BetaPosterior) => (p.a * p.b) / ((p.a + p.b) ** 2 * (p.a + p.b + 1));

// ---------------------------------------------------------------------------
// Reward posteriors
// ---------------------------------------------------------------------------

/** Pooled value per conversion (USD), shared by every arm of a flag. */
export interface ValuePosterior {
  mean: number;
  /** Standard error of the pooled mean (0 when V is a configured constant). */
  se: number;
  source: string;
}

export type RewardPosterior =
  | { kind: 'normal'; nig: NigPosterior }
  | { kind: 'rate'; beta: BetaPosterior }
  | { kind: 'decomposed'; conversion: BetaPosterior; cost: NigPosterior; value: ValuePosterior };

export function rewardMean(p: RewardPosterior): number {
  if (p.kind === 'normal') return p.nig.mu;
  if (p.kind === 'rate') return betaMean(p.beta);
  return betaMean(p.conversion) * p.value.mean - p.cost.mu;
}

/** Equal-tailed interval: exact for NIG and Beta, a normal approximation for p x V - C. */
export function rewardInterval(p: RewardPosterior, level: number): { lower: number; upper: number } {
  if (p.kind === 'normal') return credibleInterval(p.nig, level);
  if (p.kind === 'rate') return { lower: betaQuantile(0.5 - level / 2, p.beta.a, p.beta.b), upper: betaQuantile(0.5 + level / 2, p.beta.a, p.beta.b) };
  const pm = betaMean(p.conversion);
  const pv = betaVariance(p.conversion);
  const v = p.value.mean;
  const sv = p.value.se * p.value.se;
  const variance = v * v * pv + pm * pm * sv + pv * sv + nigMeanVariance(p.cost);
  const z = normalQuantile(0.5 + level / 2);
  const m = rewardMean(p);
  const h = z * Math.sqrt(variance);
  return { lower: m - h, upper: m + h };
}

/**
 * One joint posterior draw of every arm's mean reward. Decomposed arms share ONE draw of the
 * pooled value per conversion, so V's uncertainty moves every arm together and does not create
 * spurious differences between them.
 */
export function drawRewards(posteriors: readonly RewardPosterior[], rng: SeededRng): number[] {
  let value: number | null = null;
  return posteriors.map((p) => {
    if (p.kind === 'normal') return drawMean(p.nig, rng);
    if (p.kind === 'rate') return rng.beta(p.beta.a, p.beta.b);
    if (value === null) value = Math.max(0, p.value.mean + p.value.se * rng.normal());
    return rng.beta(p.conversion.a, p.conversion.b) * value - drawMean(p.cost, rng);
  });
}

export interface ThompsonSummary {
  /** P(arm k has the largest mean reward). */
  pBest: number[];
  /** E[max_j mu_j - mu_k]: reward per user given up by serving arm k instead of the best arm. */
  expectedLoss: number[];
}

/** P(best) and expected loss from seeded Monte-Carlo draws; deterministic for a given rng state. */
export function thompsonSummary(posteriors: readonly RewardPosterior[], rng: SeededRng, draws: number): ThompsonSummary {
  const k = posteriors.length;
  if (k === 0) return { pBest: [], expectedLoss: [] };
  if (k === 1) return { pBest: [1], expectedLoss: [0] };
  const wins = new Array<number>(k).fill(0);
  const loss = new Array<number>(k).fill(0);
  for (let d = 0; d < draws; d += 1) {
    const x = drawRewards(posteriors, rng);
    let best = 0;
    for (let j = 1; j < k; j += 1) if (x[j]! > x[best]!) best = j;
    wins[best]! += 1;
    for (let j = 0; j < k; j += 1) loss[j]! += x[best]! - x[j]!;
  }
  return { pBest: wins.map((w) => w / draws), expectedLoss: loss.map((l) => l / draws) };
}

// ---------------------------------------------------------------------------
// Minimum sample size from the minimum detectable effect
// ---------------------------------------------------------------------------

export interface MdeOptions {
  /** Per-user variance of the reward the allocator uses. */
  variance: number;
  /** Minimum detectable difference between two arms, in reward units per exposed user. */
  mde: number;
  /** Two-sided significance level of the (fixed-n) power calculation. */
  alpha: number;
  power: number;
  /** Never ask for fewer users than this. */
  floor: number;
}

/**
 * Users per arm for a two-sample comparison to detect `mde` with the given power:
 * n = 2 (z_{1-alpha/2} + z_{power})^2 sigma^2 / mde^2. Profit per user is heavy-tailed: a $2 gap at
 * an SD of $90 needs 2 x 7.85 x 8100 / 4 = ~31,800 users per arm (alpha 0.05, power 0.8).
 */
export function requiredSampleSize(o: MdeOptions): number {
  if (!(o.mde > 0) || !(o.alpha > 0 && o.alpha < 1) || !(o.power > 0 && o.power < 1) || !(o.variance >= 0)) {
    throw new Error(`invalid MDE options ${JSON.stringify(o)}`);
  }
  const z = normalQuantile(1 - o.alpha / 2) + normalQuantile(o.power);
  return Math.max(o.floor, Math.ceil((2 * z * z * o.variance) / (o.mde * o.mde)));
}
