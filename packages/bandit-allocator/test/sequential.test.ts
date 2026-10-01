import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/rng.js';
import { dayMatchedContrast, mixtureHalfWidth, sequentialTest, type ContrastDay } from '../src/sequential.js';
import { statsOf, type SufficientStats } from '../src/thompson.js';

/** Sufficient statistics of n draws from N(mean, sd^2). */
function draw(rng: SeededRng, n: number, mean: number, sd: number): SufficientStats {
  const xs = Array.from({ length: n }, () => mean + sd * rng.normal());
  return statsOf(xs);
}

describe('normal-mixture always-valid confidence sequence (mSPRT)', () => {
  it('is wider than the fixed-n interval and shrinks like sqrt(log I / I)', () => {
    const z = 1.959964;
    for (const info of [10, 1e3, 1e5]) {
      const h = mixtureHalfWidth(info, 1, 0.05);
      expect(h).toBeGreaterThan(z / Math.sqrt(info));
    }
    expect(mixtureHalfWidth(1e6, 1, 0.05)).toBeLessThan(mixtureHalfWidth(1e4, 1, 0.05) / 5);
  });

  it('matches the closed form sqrt((1 + t I) / (t I^2) * (2 ln(1/a) + ln(1 + t I)))', () => {
    const [I, tau, a] = [250, 0.4, 0.05];
    const t = tau * tau;
    expect(mixtureHalfWidth(I, tau, a)).toBeCloseTo(Math.sqrt(((1 + t * I) / (t * I * I)) * (2 * Math.log(1 / a) + Math.log(1 + t * I))), 12);
  });
});

describe('day-matched two-sample contrast', () => {
  it('combines days by inverse variance and includes BOTH arms\' standard errors', () => {
    const days: ContrastDay[] = [
      { date: '2026-09-01', treatment: { n: 100, sum: 100, sumSq: 100 + 99 * 4 }, control: { n: 400, sum: 800, sumSq: 1600 + 399 * 4 } },
      { date: '2026-09-02', treatment: { n: 100, sum: 100, sumSq: 100 + 99 * 4 }, control: { n: 400, sum: 800, sumSq: 1600 + 399 * 4 } },
    ];
    const c = dayMatchedContrast(days)!;
    expect(c.estimate).toBeCloseTo(-1, 9);
    // Per day v = s_t^2/100 + s_c^2/400 with pooled within-day variances.
    const sT = (99 * 4 * 2) / (2 * 99);
    const sC = (399 * 4 * 2) / (2 * 399);
    const v = sT / 100 + sC / 400;
    expect(c.information).toBeCloseTo(2 / v, 6);
    // A control-only SE would claim far more information than the two-sample one.
    expect(c.information).toBeLessThan(2 / (sT / 100));
  });

  it('removes a shared time trend that confounds pooled means when allocation shifts', () => {
    // Day 1: everyone earns 10; day 2: everyone earns 20. The treatment arm got most of its
    // users on day 2 (the bandit moved toward it), the control is flat across days.
    const days: ContrastDay[] = [
      { date: '2026-09-01', treatment: { n: 50, sum: 500, sumSq: 50 * 101 }, control: { n: 500, sum: 5000, sumSq: 500 * 101 } },
      { date: '2026-09-02', treatment: { n: 950, sum: 19000, sumSq: 950 * 401 }, control: { n: 500, sum: 10000, sumSq: 500 * 401 } },
    ];
    expect(dayMatchedContrast(days)!.estimate).toBeCloseTo(0, 9);
    const pooledGap = (500 + 19000) / 1000 - (5000 + 10000) / 1000;
    expect(pooledGap).toBeGreaterThan(4); // what a pooled-mean comparison would report
  });
});

describe('sequential stop-loss test (finding 1: two-sample, valid under daily looks)', () => {
  const opts = { alpha: 0.05, tau: 2, minTreatmentN: 1, minControlN: 1 };

  it('a NULL arm (same mean as the control) is ever flagged in at most ~alpha of experiments despite daily looks', () => {
    const rng = new SeededRng('seq-null');
    const reps = 300;
    const days = 40;
    let everRejected = 0;
    let everRejectedOldRule = 0;
    for (let r = 0; r < reps; r += 1) {
      const series: ContrastDay[] = [];
      let tAll: SufficientStats = { n: 0, sum: 0, sumSq: 0 };
      let cAll: SufficientStats = { n: 0, sum: 0, sumSq: 0 };
      let rejected = false;
      let oldRejected = false;
      for (let d = 0; d < days; d += 1) {
        const t = draw(rng, 60, 10, 30);
        const c = draw(rng, 20, 10, 30);
        series.push({ date: `d${String(d).padStart(3, '0')}`, treatment: t, control: c });
        tAll = { n: tAll.n + t.n, sum: tAll.sum + t.sum, sumSq: tAll.sumSq + t.sumSq };
        cAll = { n: cAll.n + c.n, sum: cAll.sum + c.sum, sumSq: cAll.sumSq + c.sumSq };
        const res = sequentialTest(series, opts);
        if (res && res.upper < 0) rejected = true;
        // The old rule: the arm's own one-sided 95% upper bound vs the control POINT estimate.
        const mT = tAll.sum / tAll.n;
        const sdT = Math.sqrt(tAll.sumSq / tAll.n - mT * mT);
        if (mT + 1.645 * (sdT / Math.sqrt(tAll.n)) < cAll.sum / cAll.n) oldRejected = true;
      }
      if (rejected) everRejected += 1;
      if (oldRejected) everRejectedOldRule += 1;
    }
    // Always-valid: P(ever reject a null arm) <= alpha (plus Monte-Carlo slack).
    expect(everRejected / reps).toBeLessThanOrEqual(0.05 + 0.03);
    // The rule it replaces fires on a large share of null arms over 40 daily looks.
    expect(everRejectedOldRule / reps).toBeGreaterThan(0.3);
  });

  it('still stops an arm that is clearly worse than the control', () => {
    const rng = new SeededRng('seq-bad');
    const series: ContrastDay[] = [];
    for (let d = 0; d < 20; d += 1) series.push({ date: `d${d}`, treatment: draw(rng, 200, 5, 30), control: draw(rng, 200, 15, 30) });
    const res = sequentialTest(series, opts)!;
    expect(res.upper).toBeLessThan(0);
    expect(res.estimate).toBeLessThan(-5);
  });

  it('does not stop a moderately worse arm when the CONTROL is small (its SE counts)', () => {
    const series: ContrastDay[] = [{ date: 'd0', treatment: { n: 20_000, sum: 20_000 * 9, sumSq: 20_000 * (81 + 900) }, control: { n: 60, sum: 60 * 10, sumSq: 60 * (100 + 900) } }];
    const res = sequentialTest(series, opts)!;
    expect(res.upper).toBeGreaterThan(0);
    // The one-sample rule (arm upper bound vs the control mean) would have stopped it.
    expect(9 + 1.645 * Math.sqrt(900 / 20_000)).toBeLessThan(10);
  });

  it('is not evaluated below the minimum sample sizes', () => {
    const series: ContrastDay[] = [{ date: 'd0', treatment: { n: 10, sum: 0, sumSq: 0 }, control: { n: 10, sum: 100, sumSq: 1000 } }];
    expect(sequentialTest(series, { ...opts, minControlN: 500 })).toBeNull();
  });
});
