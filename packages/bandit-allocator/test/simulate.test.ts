import { describe, expect, it } from 'vitest';
import type { AllocatorConfig } from '../src/job.js';
import { interval95, POLICIES, renderSimulationReport, runSimulation, type SimulationOptions } from '../src/simulate.js';

/** Shrinks every minimum so a few hundred simulated users per day can exercise the real job. */
function tiny(c: AllocatorConfig): AllocatorConfig {
  return {
    ...c,
    guardrails: {
      ...c.guardrails,
      minSamplesPerArm: 20,
      minimumDetectableEffect: c.reward === 'conversion' ? 0.5 : 100,
      minExpectedLossToMove: 0,
      stopLoss: { ...c.guardrails.stopLoss, minControlSamples: 20, minArmSamples: 20 },
    },
    guardrailMetrics: { ...c.guardrailMetrics, minTreatmentN: 20, minControlN: 20 },
    srm: { ...c.srm, minHoldoutUsers: 10, minTargetUsers: 10 },
  };
}

// A small, fast configuration of the real simulation (the full run is 60 days x 2,000/day x 10).
const SMOKE: Partial<SimulationOptions> = {
  days: 8,
  usersPerDay: 200,
  replications: 2,
  calibrationUsersPerArm: 2000,
  outcomeHorizonDays: 2,
  thompsonDraws: 1000,
  seed: 'bandit-sim/smoke',
  configure: tiny,
};

describe('simulation smoke run (ILLUSTRATIVE)', () => {
  const result = runSimulation(SMOKE);

  it('is labelled illustrative and covers every policy with the same users', () => {
    expect(result.illustrative).toBe(true);
    expect(result.note).toMatch(/ILLUSTRATIVE/);
    expect(result.summary.map((s) => s.policy)).toEqual([...POLICIES]);
    for (const s of result.summary) {
      expect(s.mean.users).toBe(8 * 200);
      expect(Number.isFinite(s.mean.profitPerUser)).toBe(true);
      expect(s.mean.conversionRate).toBeGreaterThanOrEqual(0);
      expect(s.mean.conversionRate).toBeLessThanOrEqual(1);
      expect(s.mean.servingCostPerUser).toBeGreaterThan(0);
    }
  });

  it('measures regret against the oracle (zero for the oracle itself), with 95% intervals', () => {
    const oracle = result.summary.find((s) => s.policy === 'oracle')!;
    expect(oracle.mean.regretPer1000).toBe(0);
    expect(oracle.mean.expectedRegretPer1000).toBe(0);
    for (const s of result.summary) {
      expect(s.regret.lower).toBeLessThanOrEqual(s.regret.mean);
      expect(s.regret.upper).toBeGreaterThanOrEqual(s.regret.mean);
    }
    expect(result.comparisons.map((c) => `${c.a}-${c.b}`)).toContain('profit_bandit-conversion_bandit');
    for (const c of result.comparisons) expect(c.distinguishable).toBe(c.realized.upper < 0 || c.realized.lower > 0);
  });

  it('keeps the fixed split fixed and lets the bandits patch LaunchDarkly through the real job', () => {
    const fixed = result.summary.find((s) => s.policy === 'fixed_split')!;
    for (const w of Object.values(fixed.mean.finalWeights['suite-default-model-create-image'])) expect(w).toBeCloseTo(0.25, 12);
    expect(fixed.mean.patchDays).toBe(0);
    for (const p of ['conversion_bandit', 'profit_bandit', 'score_bandit'] as const) {
      const s = result.summary.find((x) => x.policy === p)!;
      expect(s.mean.patchDays, p).toBeGreaterThanOrEqual(1);
      for (const flag of ['suite-default-model-create-image', 'suite-default-model-create-video'] as const) {
        const weights = Object.values(s.mean.finalWeights[flag]);
        expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      }
    }
  });

  it('computes the break-even conversion band for every (expensive, cheaper) pair', () => {
    expect(result.calibration.divergence.length).toBe(6 + 3);
    for (const b of result.calibration.divergence) expect(b.bandPp).toBeGreaterThanOrEqual(0);
    expect(result.finding).toMatch(/distinguishable/);
  });

  it('renders a report that says ILLUSTRATIVE, gives intervals and states the finding', () => {
    const report = renderSimulationReport(result);
    expect(report).toMatch(/ILLUSTRATIVE/);
    expect(report).toMatch(/## Finding/);
    expect(report).toMatch(/break-even/i);
    expect(report).toMatch(/Paired comparisons/);
    expect(report).toMatch(/95% CI/);
  });

  it('is deterministic (common random numbers, seeded Thompson draws)', () => {
    expect(JSON.stringify(runSimulation(SMOKE))).toBe(JSON.stringify(result));
  });
});

describe('finding 5: the simulation feeds only what would be known at each date', () => {
  it('with a horizon longer than the run, Thompson never moves on matured outcomes; the 24h-score bandit can', () => {
    const r = runSimulation({ ...SMOKE, days: 6, usersPerDay: 150, replications: 1, outcomeHorizonDays: 30, seed: 'bandit-sim/no-future' });
    const get = (p: string) => r.summary.find((s) => s.policy === p)!;
    // (A guardrail on a 24h metric may still stop an arm early: that is not a Thompson move.)
    expect(get('conversion_bandit').mean.firstThompsonDay).toBeNull();
    expect(get('profit_bandit').mean.firstThompsonDay).toBeNull();
    expect(get('score_bandit').mean.firstThompsonDay).not.toBeNull();
  });

  it('interval95 is a t interval across replications', () => {
    const i = interval95([1, 2, 3, 4]);
    expect(i.mean).toBe(2.5);
    expect(i.upper - i.mean).toBeCloseTo(3.182446 * (Math.sqrt(5 / 3) / 2), 5);
    expect(interval95([7])).toEqual({ mean: 7, sd: 0, lower: 7, upper: 7 });
  });
});
