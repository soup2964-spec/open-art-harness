import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/rng.js';
import {
  chiSquareSurvival,
  logGamma,
  normalQuantile,
  regularizedIncompleteBeta,
  studentTCdf,
  studentTQuantile,
} from '../src/stats.js';

describe('SeededRng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new SeededRng('seed-a');
    const b = new SeededRng('seed-a');
    const c = new SeededRng('seed-b');
    const sa = Array.from({ length: 8 }, () => a.nextUint32());
    const sb = Array.from({ length: 8 }, () => b.nextUint32());
    const sc = Array.from({ length: 8 }, () => c.nextUint32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('forks independent, reproducible child streams', () => {
    const x1 = new SeededRng('root').fork('child').next();
    const x2 = new SeededRng('root').fork('child').next();
    const y = new SeededRng('root').fork('other').next();
    expect(x1).toBe(x2);
    expect(x1).not.toBe(y);
  });

  it('next() stays in [0, 1) and nextOpen() in (0, 1)', () => {
    const r = new SeededRng('range');
    for (let i = 0; i < 20_000; i += 1) {
      const u = r.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const v = r.nextOpen();
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('normal() has mean 0 and variance 1', () => {
    const r = new SeededRng('normal');
    const n = 200_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i += 1) {
      const z = r.normal();
      s += z;
      s2 += z * z;
    }
    const mean = s / n;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(s2 / n - mean * mean - 1)).toBeLessThan(0.015);
  });

  it.each([0.5, 1, 2.5, 30])('gamma(%s) has mean k and variance k', (k) => {
    const r = new SeededRng(`gamma-${k}`);
    const n = 100_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i += 1) {
      const g = r.gamma(k);
      expect(g).toBeGreaterThan(0);
      s += g;
      s2 += g * g;
    }
    const mean = s / n;
    const variance = s2 / n - mean * mean;
    expect(Math.abs(mean - k) / k).toBeLessThan(0.02);
    expect(Math.abs(variance - k) / k).toBeLessThan(0.05);
  });

  it('rejects invalid gamma shapes', () => {
    expect(() => new SeededRng('x').gamma(0)).toThrow();
    expect(() => new SeededRng('x').gamma(Number.NaN)).toThrow();
  });
});

// Reference values were computed with scipy.stats / scipy.special (t.ppf, norm.ppf, chi2.sf,
// betainc) and Python math.lgamma.
describe('special functions (reference values from scipy)', () => {
  it('logGamma', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(logGamma(10)).toBeCloseTo(Math.log(362_880), 10);
    // scipy/math.lgamma(100.5) = 361.4355404677776
    expect(logGamma(100.5)).toBeCloseTo(361.4355404677776, 8);
  });

  it('regularized incomplete beta', () => {
    // I_x(2,3) = sum_{j=2..4} C(4,j) x^j (1-x)^(4-j); at x=0.5 that is 11/16.
    expect(regularizedIncompleteBeta(0.5, 2, 3)).toBeCloseTo(11 / 16, 12);
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    // Symmetry I_x(a,b) = 1 - I_{1-x}(b,a).
    expect(regularizedIncompleteBeta(0.3, 4.5, 1.7)).toBeCloseTo(1 - regularizedIncompleteBeta(0.7, 1.7, 4.5), 12);
  });

  it('Student t CDF and quantiles', () => {
    expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 12);
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.706204736, 6);
    expect(studentTQuantile(0.975, 2)).toBeCloseTo(4.30265273, 6);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228138852, 7);
    expect(studentTQuantile(0.95, 30)).toBeCloseTo(1.697260887, 7);
    expect(studentTQuantile(0.025, 10)).toBeCloseTo(-2.228138852, 7);
    // Non-integer degrees of freedom (NIG posteriors have df = 2 * alpha).
    expect(studentTCdf(1.5, 7.3)).toBeCloseTo(0.912218453598457, 10);
    expect(studentTCdf(studentTQuantile(0.9, 7.3), 7.3)).toBeCloseTo(0.9, 10);
    // Large df converges to the normal quantile.
    expect(studentTQuantile(0.975, 1e7)).toBeCloseTo(1.959963985, 5);
  });

  it('normal quantile', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963985, 8);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644853627, 8);
    expect(normalQuantile(1e-6)).toBeCloseTo(-4.753424309, 6);
  });

  it('chi-square survival (used by the sample-ratio-mismatch check)', () => {
    expect(chiSquareSurvival(3.841458821, 1)).toBeCloseTo(0.05, 8);
    expect(chiSquareSurvival(7.814727903, 3)).toBeCloseTo(0.05, 8);
    expect(chiSquareSurvival(16.2662362, 3)).toBeCloseTo(0.001, 8);
    expect(chiSquareSurvival(2, 2)).toBeCloseTo(Math.exp(-1), 12);
    expect(chiSquareSurvival(0, 4)).toBe(1);
  });
});
