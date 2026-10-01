import { describe, expect, it } from 'vitest';
import {
  betaMean,
  requiredSampleSize,
  rewardInterval,
  rewardMean,
  thompsonSummary,
  updateBeta,
  updateNig,
  weakBetaPrior,
  type NigPrior,
  type RewardPosterior,
  type SufficientStats,
  type ValuePosterior,
} from '../src/posterior.js';
import { SeededRng } from '../src/rng.js';

const WEAK: NigPrior = { mu0: 0, kappa0: 1, alpha0: 2, beta0: 1 };
const synth = (n: number, mean: number, sd: number): SufficientStats => ({ n, sum: n * mean, sumSq: n * (sd * sd + mean * mean) });

function decomposed(conversions: number, users: number, costMean: number, costSd: number, value: ValuePosterior): RewardPosterior {
  return { kind: 'decomposed', conversion: updateBeta(weakBetaPrior(0.05, 1), users, conversions), cost: updateNig(WEAK, synth(users, costMean, costSd)), value };
}

describe('finding 4: the decomposed reward p x V - C', () => {
  const V: ValuePosterior = { mean: 100, se: 0, source: 'test' };

  it('is the UNCONDITIONAL per-exposed-user estimand, not the purchase-conditional value', () => {
    const p = decomposed(1000, 10_000, 2, 1, V); // 10% conversion, $2 serving cost per exposed user
    expect(betaMean((p as Extract<RewardPosterior, { kind: 'decomposed' }>).conversion)).toBeCloseTo(0.1, 3);
    expect(rewardMean(p)).toBeCloseTo(0.1 * 100 - 2, 1); // $8 per exposed user
    // What a purchase-conditional "ad value" would report: value per purchase net of cost per purchase.
    expect(100 - 2 / 0.1).toBeGreaterThan(rewardMean(p) * 5);
  });

  it('prices serving cost: equal conversion, the cheaper arm is preferred', () => {
    const cheap = decomposed(600, 10_000, 1.0, 1, V);
    const pricey = decomposed(600, 10_000, 1.8, 1, V);
    const s = thompsonSummary([cheap, pricey], new SeededRng('cost'), 20_000);
    expect(s.pBest[0]).toBeGreaterThan(0.99);
    expect(s.expectedLoss[1]).toBeGreaterThan(0.7);
  });

  it('shares ONE draw of the pooled value per conversion across arms, so V noise creates no spurious winner', () => {
    const noisyV: ValuePosterior = { mean: 100, se: 40, source: 'test' };
    const a = decomposed(600, 10_000, 1, 1, noisyV);
    const b = decomposed(600, 10_000, 1, 1, noisyV);
    const s = thompsonSummary([a, b], new SeededRng('shared-v'), 40_000);
    expect(Math.abs(s.pBest[0]! - 0.5)).toBeLessThan(0.02);
    // Expected loss stays at the conversion-noise level instead of the value-noise level.
    expect(s.expectedLoss[0]).toBeLessThan(0.2);
  });

  it('has a much narrower interval than raw per-user profit when converter values are heavy-tailed', () => {
    // 6% convert; a converter is worth $10 / $50 / $300 / $1,200 (monthly ... annual Wonder).
    const values = [10, 50, 300, 1200];
    const shares = [0.5, 0.3, 0.15, 0.05];
    const users = 20_000;
    const conv = Math.round(0.06 * users);
    let sum = 0;
    let sumSq = 0;
    values.forEach((v, i) => {
      const k = conv * shares[i]!;
      sum += k * v;
      sumSq += k * v * v;
    });
    const cost = synth(users, 1.2, 3);
    const raw = updateNig(WEAK, { n: users, sum: sum - cost.sum, sumSq: sumSq + cost.sumSq - 2 * 1.2 * sum });
    const rawWidth = rewardInterval({ kind: 'normal', nig: raw }, 0.95);
    // Arm-vs-arm comparisons are what move traffic. The pooled V is shared by every arm, so its
    // uncertainty cancels in a difference: compare the per-arm interval without it (se = 0).
    const shared: ValuePosterior = { mean: sum / conv, se: 0, source: 'pooled over all arms' };
    const dec = rewardInterval(decomposed(conv, users, 1.2, 3, shared), 0.95);
    expect(dec.upper - dec.lower).toBeLessThan((rawWidth.upper - rawWidth.lower) / 2);
    // Two identical arms with a noisy V: P(best) stays a coin flip (V noise is common to both).
    const noisy: ValuePosterior = { mean: sum / conv, se: 20, source: 'pooled' };
    const s = thompsonSummary([decomposed(conv, users, 1.2, 3, noisy), decomposed(conv, users, 1.2, 3, noisy)], new SeededRng('heavy'), 20_000);
    expect(Math.abs(s.pBest[0]! - 0.5)).toBeLessThan(0.02);
    // Same data, same MDE: the lower-variance reward needs several times fewer users per arm.
    const rawVar = sumSq / users - (sum / users) ** 2;
    const decVar = (sum / conv) ** 2 * 0.06 * 0.94 + 9;
    const nRaw = requiredSampleSize({ variance: rawVar, mde: 2, alpha: 0.05, power: 0.8, floor: 1 });
    const nDec = requiredSampleSize({ variance: decVar, mde: 2, alpha: 0.05, power: 0.8, floor: 1 });
    expect(nRaw / nDec).toBeGreaterThan(4);
  });

  it('conversion is Beta-Binomial (exact Beta quantiles in the interval)', () => {
    const beta = updateBeta({ a: 1, b: 1 }, 100, 7);
    expect(beta).toEqual({ a: 8, b: 94 });
    const ci = rewardInterval({ kind: 'rate', beta }, 0.95);
    expect(ci.lower).toBeGreaterThan(0.02);
    expect(ci.upper).toBeLessThan(0.15);
    expect(ci.lower).toBeLessThan(8 / 102);
    expect(ci.upper).toBeGreaterThan(8 / 102);
  });
});
