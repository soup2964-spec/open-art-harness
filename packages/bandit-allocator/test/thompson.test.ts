import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/rng.js';
import { sequentialTest } from '../src/sequential.js';
import { studentTQuantile } from '../src/stats.js';
import {
  addStats,
  credibleInterval,
  decideTarget,
  DEFAULT_GUARDRAILS,
  drawMean,
  EMPTY_STATS,
  marginalOfMean,
  probabilityBest,
  projectOntoBoundedSimplex,
  requiredSampleSize,
  scaleStats,
  shrinkagePrior,
  statsOf,
  toUnits,
  updateNig,
  weakPriorFor,
  type ArmObservation,
  type GuardrailConfig,
  type NigPrior,
  type SufficientStats,
  type TargetContext,
} from '../src/thompson.js';

/** Sufficient statistics of n users with the given mean and (population) variance. */
function synth(n: number, mean: number, sd: number): SufficientStats {
  return { n, sum: n * mean, sumSq: n * (sd * sd + mean * mean) };
}

const WEAK: NigPrior = { mu0: 0, kappa0: 1, alpha0: 2, beta0: 25 };

function arm(name: string, stats: SufficientStats, currentWeight: number, extra: Partial<ArmObservation> = {}): ArmObservation {
  return { arm: name, posterior: { kind: 'normal', nig: updateNig(WEAK, stats) }, effectiveN: stats.n, rewardUsers: stats.n, currentWeight, ...extra };
}

/** The always-valid stop-loss test of one arm against a control, from one day of data. */
function stopTest(treatment: SufficientStats, control: SufficientStats) {
  return sequentialTest([{ date: '2026-09-01', treatment, control }], { alpha: 0.05, tau: 1, minTreatmentN: 1, minControlN: 1 });
}

const rng = (label = 'test') => new SeededRng(`thompson-test/${label}`);

describe('sufficient statistics', () => {
  it('statsOf / addStats are consistent and additive', () => {
    const a = statsOf([1, 2, 3]);
    const b = statsOf([4, 5]);
    expect(a).toEqual({ n: 3, sum: 6, sumSq: 14 });
    expect(addStats(a, b)).toEqual(statsOf([1, 2, 3, 4, 5]));
    expect(addStats(EMPTY_STATS, a)).toEqual(a);
  });

  it('scaleStats weights all three moments (exponential decay of old days)', () => {
    expect(scaleStats({ n: 10, sum: 20, sumSq: 50 }, 0.5)).toEqual({ n: 5, sum: 10, sumSq: 25 });
  });
});

describe('Normal-Inverse-Gamma posterior updates', () => {
  it('returns the prior unchanged when there is no data', () => {
    expect(updateNig({ mu0: 3, kappa0: 2, alpha0: 4, beta0: 5 }, EMPTY_STATS)).toEqual({ mu: 3, kappa: 2, alpha: 4, beta: 5 });
  });

  it('matches the closed-form conjugate update', () => {
    // Prior NIG(0, 1, 1, 1); data [1, 2, 3]: n=3, mean=2, S=2.
    // kappa=4, mu=(0+6)/4=1.5, alpha=1+3/2=2.5, beta=1 + 2/2 + (1*3*(2-0)^2)/(2*4)=3.5.
    const post = updateNig({ mu0: 0, kappa0: 1, alpha0: 1, beta0: 1 }, statsOf([1, 2, 3]));
    expect(post.kappa).toBeCloseTo(4, 12);
    expect(post.mu).toBeCloseTo(1.5, 12);
    expect(post.alpha).toBeCloseTo(2.5, 12);
    expect(post.beta).toBeCloseTo(3.5, 12);
  });

  it('is conjugate: sequential updates equal one batch update', () => {
    const r = rng('conjugacy');
    for (let trial = 0; trial < 20; trial += 1) {
      const xs = Array.from({ length: 1 + Math.floor(r.next() * 40) }, () => r.normal() * 7 + 3);
      const ys = Array.from({ length: 1 + Math.floor(r.next() * 40) }, () => r.normal() * 2 - 1);
      const prior: NigPrior = { mu0: r.normal(), kappa0: 0.5 + r.next(), alpha0: 1 + r.next(), beta0: 0.5 + r.next() };
      const seq = updateNig(toPrior(updateNig(prior, statsOf(xs))), statsOf(ys));
      const batch = updateNig(prior, statsOf([...xs, ...ys]));
      expect(seq.mu).toBeCloseTo(batch.mu, 9);
      expect(seq.kappa).toBeCloseTo(batch.kappa, 9);
      expect(seq.alpha).toBeCloseTo(batch.alpha, 9);
      expect(seq.beta).toBeCloseTo(batch.beta, 6);
    }
  });

  it('concentrates on the sample mean as n grows', () => {
    const small = updateNig(WEAK, synth(100, 1.2, 5));
    const big = updateNig(WEAK, synth(100_000, 1.2, 5));
    expect(Math.abs(big.mu - 1.2)).toBeLessThan(1e-4);
    const wSmall = credibleInterval(small, 0.95);
    const wBig = credibleInterval(big, 0.95);
    const ratio = (wSmall.upper - wSmall.lower) / (wBig.upper - wBig.lower);
    expect(ratio).toBeGreaterThan(25);
    expect(ratio).toBeLessThan(40);
  });

  it('credible bounds are Student-t quantiles of the marginal posterior of the mean', () => {
    const post = updateNig(WEAK, synth(40, 2, 3));
    const m = marginalOfMean(post);
    expect(m.df).toBeCloseTo(2 * post.alpha, 12);
    expect(m.scale).toBeCloseTo(Math.sqrt(post.beta / (post.alpha * post.kappa)), 12);
    const ci = credibleInterval(post, 0.9);
    expect(ci.upper).toBeCloseTo(m.location + studentTQuantile(0.95, m.df) * m.scale, 10);
    expect(ci.lower).toBeCloseTo(m.location - studentTQuantile(0.95, m.df) * m.scale, 10);
  });

  it('Thompson draws follow the marginal posterior (mean and variance)', () => {
    const post = updateNig(WEAK, synth(30, 1, 4));
    const r = rng('draws');
    const k = 200_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < k; i += 1) {
      const x = drawMean(post, r);
      s += x;
      s2 += x * x;
    }
    const mean = s / k;
    const variance = s2 / k - mean * mean;
    expect(mean).toBeCloseTo(post.mu, 2);
    expect(variance / (post.beta / (post.kappa * (post.alpha - 1)))).toBeCloseTo(1, 1);
  });

  it('weakPriorFor is centred and scaled on the pooled data', () => {
    const p = weakPriorFor(synth(1000, 4, 10), { meanPseudoCount: 1, variancePseudoCount: 2 });
    expect(p.mu0).toBeCloseTo(4, 12);
    expect(p.kappa0).toBe(1);
    expect(p.alpha0).toBe(2);
    expect(p.beta0 / (p.alpha0 - 1)).toBeCloseTo(100, 8);
    const z = weakPriorFor(synth(50, 0, 0), { meanPseudoCount: 1, variancePseudoCount: 2 });
    expect(z.beta0).toBeGreaterThan(0);
  });

  it('shrinkagePrior centres a segment on the global arm posterior with the given strength', () => {
    const global = updateNig(WEAK, synth(20_000, 1.5, 6));
    const p = shrinkagePrior(global, 50, WEAK);
    expect(p.mu0).toBeCloseTo(global.mu, 12);
    expect(p.kappa0).toBe(50);
    expect(p.beta0 / (p.alpha0 - 1)).toBeCloseTo(global.beta / (global.alpha - 1), 8);
    const seg = updateNig(p, synth(20, -3, 6));
    expect(seg.mu).toBeGreaterThan(-3);
    expect(seg.mu).toBeLessThan(global.mu);
  });
});

describe('probabilityBest (Thompson probability matching)', () => {
  it('sums to one, is deterministic per seed and recognises a clear winner', () => {
    const posts = [updateNig(WEAK, synth(5000, 2, 5)), updateNig(WEAK, synth(5000, 1, 5)), updateNig(WEAK, synth(5000, 1, 5))];
    const p1 = probabilityBest(posts, rng('pb'), 20_000);
    const p2 = probabilityBest(posts, rng('pb'), 20_000);
    expect(p1).toEqual(p2);
    expect(p1.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p1[0]).toBeGreaterThan(0.999);
  });

  it('splits evenly between identical arms (within Monte-Carlo error)', () => {
    const post = updateNig(WEAK, synth(2000, 1, 5));
    const p = probabilityBest([post, post, post, post], rng('even'), 40_000);
    for (const x of p) expect(Math.abs(x - 0.25)).toBeLessThan(0.015);
  });
});

describe('projectOntoBoundedSimplex', () => {
  it('returns the target when it already satisfies the bounds', () => {
    const r = projectOntoBoundedSimplex([0.1, 0.2, 0.7], [0, 0, 0], [1, 1, 1]);
    r.forEach((x, i) => expect(x).toBeCloseTo([0.1, 0.2, 0.7][i]!, 12));
  });

  it('is the Euclidean projection: free coordinates move by one common shift', () => {
    const w = projectOntoBoundedSimplex([1, 0, 0, 0], [0.15, 0.15, 0.15, 0.15], [0.35, 0.35, 0.35, 0.35]);
    expect(w[0]).toBeCloseTo(0.35, 12);
    for (const x of w.slice(1)) expect(x).toBeCloseTo(0.65 / 3, 12);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('throws when the bounds are infeasible', () => {
    expect(() => projectOntoBoundedSimplex([0.5, 0.5], [0.6, 0.6], [1, 1])).toThrow(/infeasible/);
  });
});

describe('toUnits (LaunchDarkly weights are integers summing to 100000)', () => {
  it('sums exactly to the total and respects floors', () => {
    expect(toUnits([0.05, 0.05, 0.05, 0.85], 100_000, [5000, 5000, 5000, 0])).toEqual([5000, 5000, 5000, 85_000]);
    const odd = toUnits([1 / 3, 1 / 3, 1 / 3], 100_000, [0, 0, 0]);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(Math.max(...odd) - Math.min(...odd)).toBeLessThanOrEqual(1);
  });

  it('never lets float noise push a floored arm one unit under its floor', () => {
    expect(toUnits([0.05 - 1e-12, 0.3, 0.65 + 1e-12], 100_000, [5000, 5000, 5000])[0]).toBe(5000);
  });

  it('throws instead of looping forever when no weight is positive (finding 6d)', () => {
    expect(() => toUnits([0, 0, 0], 100_000, [0, 0, 0])).toThrow(/positive/);
    expect(() => toUnits([], 100_000, [])).toThrow(/no weights/);
    expect(() => toUnits([Number.NaN, 1], 100_000, [0, 0])).toThrow(/finite/);
    expect(() => toUnits([-0.5, 1.5], 100_000, [0, 0])).toThrow(/non-negative/);
    // Tiny weights that round to zero units still terminate with a valid split.
    expect(toUnits([1e-9, 1], 100_000, [0, 0])).toEqual([0, 100_000]);
  });
});

const G: GuardrailConfig = {
  ...DEFAULT_GUARDRAILS,
  minSamplesPerArm: 200,
  maxDailyChange: 0.1,
  minExplorationShare: 0.05,
  warmStartShare: 0.1,
  thompsonDraws: 20_000,
  minExpectedLossToMove: 0,
};
const CTX: TargetContext = { requiredN: 200 };

describe('decideTarget guardrails', () => {
  const equal = [0.25, 0.25, 0.25, 0.25];

  it('moves toward the Thompson target, capped at the maximum daily change', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.25), arm('b', synth(5000, 1, 5), 0.25), arm('c', synth(5000, 1, 5), 0.25), arm('d', synth(5000, 1, 5), 0.25)], G, rng('cap'), CTX);
    expect(d.status).toBe('moved');
    expect(d.arms[0]!.proposedWeight).toBeCloseTo(0.35, 9);
    for (const a of d.arms) expect(Math.abs(a.proposedWeight - a.currentWeight)).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(d.arms.reduce((s, a) => s + a.proposedWeight, 0)).toBeCloseTo(1, 12);
    expect(d.arms[0]!.reasons.join(' ')).toMatch(/daily change cap/);
    expect(d.arms.reduce((s, a) => s + a.proposedUnits, 0)).toBe(100_000);
  });

  it('never drops an active arm below the exploration floor, even after many days', () => {
    let current = equal;
    let d = decideTarget([], G, rng('noop'), CTX);
    for (let day = 0; day < 20; day += 1) {
      d = decideTarget(
        [arm('a', synth(5000, 2, 5), current[0]!), arm('b', synth(5000, 1, 5), current[1]!), arm('c', synth(5000, 1, 5), current[2]!), arm('d', synth(5000, 1, 5), current[3]!)],
        G,
        rng(`floor-${day}`),
        CTX,
      );
      current = d.arms.map((a) => a.proposedWeight);
    }
    expect(current[0]).toBeCloseTo(0.85, 9);
    for (const w of current.slice(1)) expect(w).toBeCloseTo(0.05, 9);
    expect(d.arms.map((a) => a.proposedUnits)).toEqual([85_000, 5000, 5000, 5000]);
    expect(d.arms[1]!.reasons.join(' ')).toMatch(/exploration floor/);
  });

  it('holds every weight while fewer than two arms have the minimum sample', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.4), arm('b', synth(150, 1, 5), 0.2), arm('c', synth(150, 1, 5), 0.2), arm('d', synth(150, 1, 5), 0.2)], G, rng('min-n'), CTX);
    expect(d.status).toBe('held');
    expect(d.reasons.join(' ')).toMatch(/d has 150 effective users < 200/);
    expect(d.arms.map((a) => a.proposedWeight)).toEqual([0.4, 0.2, 0.2, 0.2]);
  });

  it('an under-sampled arm keeps its share while the mature arms are allocated (no global freeze)', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.4), arm('b', synth(5000, 1, 5), 0.2), arm('c', synth(5000, 1, 5), 0.2), arm('d', synth(150, 1, 5), 0.2)], G, rng('min-n-partial'), CTX);
    expect(d.status).toBe('moved');
    expect(d.arms[3]!.phase).toBe('warming');
    expect(d.arms[3]!.pBest).toBeNull();
    // Never cut below the warm-start share while it warms up (here it also absorbs capped-off mass).
    expect(d.arms[3]!.proposedWeight).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(d.arms[0]!.proposedWeight).toBeCloseTo(0.5, 9); // the winner, capped at +10pp
  });

  it('counts effective users (after decay and IPW), not raw or prior pseudo-counts, toward the minimum', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.5, { effectiveN: 199 }), arm('b', synth(5000, 1, 5), 0.5)], G, rng('min-n-2'), CTX);
    expect(d.status).toBe('held');
  });

  it('stop-loss: an arm whose always-valid confidence sequence vs the control is below 0 goes to zero at once', () => {
    const control = synth(1000, 1.5, 5);
    const d = decideTarget(
      [arm('a', synth(5000, 1.6, 5), 0.25), arm('b', synth(5000, 1.5, 5), 0.25), arm('c', synth(5000, 1.4, 5), 0.25), arm('d', synth(3000, -1, 5), 0.25, { stopLossTest: stopTest(synth(3000, -1, 5), control) })],
      G,
      rng('stop'),
      CTX,
    );
    const dArm = d.arms[3]!;
    expect(dArm.stopped).toBe(true);
    expect(dArm.phase).toBe('stopped');
    expect(dArm.proposedWeight).toBe(0);
    expect(dArm.proposedUnits).toBe(0);
    expect(dArm.reasons.join(' ')).toMatch(/stop-loss: always-valid 95\.0% confidence sequence/);
    expect(dArm.stopLoss!.upper).toBeLessThan(0);
    expect(d.arms.reduce((s, a) => s + a.proposedUnits, 0)).toBe(100_000);
  });

  it('stop-loss relaxes the daily cap only as much as needed and reports it', () => {
    const control = synth(1000, 1.5, 5);
    const d = decideTarget(
      [arm('a', synth(5000, 1.5, 5), 0.2), arm('b', synth(5000, 1.5, 5), 0.2), arm('c', synth(5000, 1.5, 5), 0.2), arm('d', synth(3000, -1, 5), 0.4, { stopLossTest: stopTest(synth(3000, -1, 5), control) })],
      G,
      rng('stop-relax'),
      CTX,
    );
    expect(d.capRelaxedTo).toBeCloseTo(0.4 / 3, 6);
    expect(d.reasons.join(' ')).toMatch(/cap relaxed/);
    for (const a of d.arms.slice(0, 3)) expect(a.proposedWeight).toBeCloseTo(0.2 + 0.4 / 3, 6);
  });

  it('never stops an arm whose test could not be evaluated (control too small)', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.5), arm('b', synth(5000, -3, 5), 0.5, { stopLossTest: null })], G, rng('no-control'), CTX);
    expect(d.arms.every((a) => !a.stopped)).toBe(true);
    expect(d.arms[1]!.proposedWeight).toBeCloseTo(0.4, 9); // only the cap moved it
  });

  it('does not stop a worse-looking arm while the confidence sequence still includes 0', () => {
    const control = synth(60, 1.5, 5); // a tiny control: its standard error dominates
    const test = stopTest(synth(5000, 1.0, 5), control)!;
    expect(test.upper).toBeGreaterThan(0);
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.5), arm('b', synth(5000, 1.0, 5), 0.5, { stopLossTest: test })], G, rng('ci-includes-0'), CTX);
    expect(d.arms[1]!.stopped).toBe(false);
  });

  it('with an arm as control, compares against that arm and never stops it', () => {
    const cfg: GuardrailConfig = { ...G, stopLoss: { ...G.stopLoss, control: { kind: 'arm', arm: 'b' } } };
    const bStats = synth(5000, 0.5, 5);
    const d = decideTarget(
      [arm('a', synth(5000, -2, 5), 0.5, { stopLossTest: stopTest(synth(5000, -2, 5), bStats) }), arm('b', bStats, 0.5, { stopLossTest: stopTest(bStats, synth(5000, 3, 5)) })],
      cfg,
      rng('arm-control'),
      CTX,
    );
    expect(d.arms[0]!.stopped).toBe(true);
    expect(d.arms[1]!.stopped).toBe(false);
    expect(d.arms[1]!.proposedWeight).toBeCloseTo(1, 9);
    expect(d.arms[1]!.proposedUnits).toBe(100_000);
  });

  it('holds instead of stopping every arm when control and arm estimates contradict each other', () => {
    const control = synth(5000, 10, 1);
    const d = decideTarget(
      [arm('a', synth(5000, 0, 1), 0.5, { stopLossTest: stopTest(synth(5000, 0, 1), control) }), arm('b', synth(5000, 0, 1), 0.5, { stopLossTest: stopTest(synth(5000, 0, 1), control) })],
      G,
      rng('contradiction'),
      CTX,
    );
    expect(d.status).toBe('held');
    expect(d.reasons.join(' ')).toMatch(/every arm/);
  });

  it('does not churn the flag for changes below minChangeToPatch', () => {
    const d = decideTarget([arm('a', synth(5000, 1, 5), 0.25), arm('b', synth(5000, 1, 5), 0.25), arm('c', synth(5000, 1, 5), 0.25), arm('d', synth(5000, 1, 5), 0.25)], { ...G, minChangeToPatch: 0.05 }, rng('churn'), CTX);
    expect(d.status).toBe('unchanged');
    expect(d.arms.map((a) => a.proposedWeight)).toEqual(equal);
  });

  it('is deterministic for a seed', () => {
    const obs = [arm('a', synth(800, 1.1, 5), 0.5), arm('b', synth(800, 1, 5), 0.5)];
    expect(decideTarget(obs, G, rng('det'), CTX)).toEqual(decideTarget(obs, G, rng('det'), CTX));
  });

  it('brings an arm below the floor up to the floor even when that exceeds the cap', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 1), arm('b', synth(5000, 1, 5), 0), arm('c', synth(5000, 1, 5), 0), arm('d', synth(5000, 1, 5), 0)], G, rng('below-floor'), CTX);
    for (const a of d.arms.slice(1)) expect(a.proposedWeight).toBeCloseTo(0.05, 9);
    expect(d.arms[0]!.proposedWeight).toBeCloseTo(0.85, 9);
    expect(d.capRelaxedTo).toBeCloseTo(0.15, 9);
  });
});

describe('regressions from the ML / TypeScript review', () => {
  it('finding 3 / 6c: a NEW arm added at 0% with no data is warm-started instead of deadlocking the flag', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.5), arm('b', synth(5000, 1, 5), 0.5), arm('new', EMPTY_STATS, 0)], G, rng('new-arm'), CTX);
    expect(d.status).toBe('moved');
    const fresh = d.arms[2]!;
    expect(fresh.phase).toBe('warming');
    expect(fresh.proposedWeight).toBeCloseTo(0.1, 9);
    expect(fresh.proposedUnits).toBe(10_000);
    expect(fresh.reasons.join(' ')).toMatch(/warm start/);
    // The mature arms are still allocated by Thompson in the same run.
    expect(d.arms[0]!.pBest).not.toBeNull();
    expect(d.arms[0]!.proposedWeight).toBeGreaterThan(d.arms[1]!.proposedWeight);
  });

  it('finding 3 / 6c: a stopped arm with little data does not block Thompson for the others', () => {
    const control = synth(2000, 1.5, 5);
    const d = decideTarget(
      [arm('a', synth(5000, 2, 5), 0.4), arm('b', synth(5000, 1, 5), 0.4), arm('bad', synth(80, -6, 5), 0.2, { stopLossTest: stopTest(synth(80, -6, 5), control) })],
      G,
      rng('stopped-short'),
      CTX,
    );
    expect(d.arms[2]!.stopped).toBe(true);
    expect(d.arms[2]!.effectiveN).toBeLessThan(CTX.requiredN);
    expect(d.status).toBe('moved');
    expect(d.arms[0]!.pBest).not.toBeNull();
    expect(d.reasons.join(' ')).not.toMatch(/minimum sample/);
  });

  it('finding 2: the minimum sample is MDE-based ($2 at SD $90 needs ~31,800 users per arm)', () => {
    const n = requiredSampleSize({ variance: 90 * 90, mde: 2, alpha: 0.05, power: 0.8, floor: 300 });
    expect(n).toBeGreaterThan(31_700);
    expect(n).toBeLessThan(31_900);
    expect(requiredSampleSize({ variance: 1, mde: 10, alpha: 0.05, power: 0.8, floor: 300 })).toBe(300);
    const d = decideTarget([arm('a', synth(5000, 2, 90), 0.5), arm('b', synth(5000, 1, 90), 0.5)], G, rng('mde'), { requiredN: n });
    expect(d.status).toBe('held');
    expect(d.reasons.join(' ')).toMatch(/5000 effective users < 3\d{4}/);
  });

  it('finding 1: moves are gated by expected loss (practically equivalent arms are not churned)', () => {
    const near = [arm('a', synth(200_000, 1.0, 5), 0.5), arm('b', synth(200_000, 1.01, 5), 0.5)];
    const gated = decideTarget(near, { ...G, minExpectedLossToMove: 0.05 }, rng('el'), CTX);
    expect(gated.status).toBe('unchanged');
    expect(gated.expectedLossCurrent).toBeLessThan(0.05);
    expect(gated.reasons.join(' ')).toMatch(/practically equivalent/);
    const clear = decideTarget([arm('a', synth(5000, 1.0, 5), 0.5), arm('b', synth(5000, 2.0, 5), 0.5)], { ...G, minExpectedLossToMove: 0.05 }, rng('el-clear'), CTX);
    expect(clear.status).toBe('moved');
    expect(clear.arms[1]!.expectedLoss).toBeLessThan(clear.arms[0]!.expectedLoss!);
  });

  it('finding 2: a non-profit guardrail breach stops the arm', () => {
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.5), arm('b', synth(5000, 3, 5), 0.5, { guardrailBreaches: ['activation 40.0% vs holdout 60.0%'] })], G, rng('guardrail'), CTX);
    expect(d.arms[1]!.stopped).toBe(true);
    expect(d.arms[1]!.proposedUnits).toBe(0);
    expect(d.arms[1]!.reasons.join(' ')).toMatch(/guardrail: activation/);
  });

  it('finding 6b: a floor above the daily cap no longer makes the projection infeasible', () => {
    const cfg: GuardrailConfig = { ...G, minExplorationShare: 0.2, warmStartShare: 0.2, maxDailyChange: 0.1 };
    const d = decideTarget([arm('a', synth(5000, 2, 5), 0.7), arm('b', synth(5000, 1, 5), 0.3), arm('c', synth(5000, 1, 5), 0), arm('d', synth(5000, 1, 5), 0)], cfg, rng('infeasible'), CTX);
    expect(d.status).toBe('moved');
    for (const a of d.arms) expect(a.proposedWeight).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(d.capRelaxedTo).toBeGreaterThanOrEqual(0.2 - 1e-9);
  });
});

function toPrior(p: { mu: number; kappa: number; alpha: number; beta: number }): NigPrior {
  return { mu0: p.mu, kappa0: p.kappa, alpha0: p.alpha, beta0: p.beta };
}
