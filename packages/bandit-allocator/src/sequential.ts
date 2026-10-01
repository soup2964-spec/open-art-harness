/**
 * Sequentially valid two-sample comparisons, used by the stop-loss and the non-profit guardrails.
 *
 * The allocator looks at the data every day, so a fixed-n test (or, worse, an arm's own credible
 * bound against the control's POINT estimate) is re-run dozens of times per experiment and its
 * false-alarm rate compounds. The stop-loss therefore uses an always-valid confidence sequence:
 * the normal-mixture sequential probability ratio test (mSPRT; Robbins 1970, Johari, Koomen,
 * Pekelis & Walsh 2017/2022, Howard, Ramdas, McAuliffe & Sekhon 2021).
 *
 * Estimator (day-matched). Each exposure day t contributes the difference of the treatment and
 * control means d_t with variance v_t = s_T^2 / n_T,t + s_C^2 / n_C,t (both sides' standard errors,
 * s^2 = pooled within-day variance of each side). Days are combined by inverse variance:
 *   Z = sum d_t / v_t,   I = sum 1 / v_t,   estimate = Z / I,   Var(estimate) = 1 / I.
 * Matching on the day removes a trend shared by both sides even when the allocator has moved
 * traffic between days, and new days are independent increments, so Z is a Brownian motion with
 * drift Delta in information time I.
 *
 * Mixture boundary. With Delta ~ N(0, tau^2) mixed over the likelihood ratio,
 *   Lambda_I = (1 + tau^2 I)^(-1/2) exp(tau^2 Z^2 / (2 (1 + tau^2 I)))
 * is a nonnegative martingale under Delta = 0, so by Ville's inequality P(ever Lambda >= 1/alpha)
 * <= alpha, over EVERY daily look. Inverting it gives the confidence sequence
 *   estimate +/- sqrt((1 + tau^2 I) / (tau^2 I^2) * (2 ln(1/alpha) + ln(1 + tau^2 I))).
 * tau sets the effect size the boundary is tightest for (the allocator uses the minimum detectable
 * effect). Variances are plug-in estimates, so the guarantee is asymptotic (large n per side), which
 * the minimum-sample settings enforce.
 */

import type { SufficientStats } from './thompson.js';

export interface ContrastDay {
  date: string;
  treatment: SufficientStats;
  control: SufficientStats;
}

export interface DayMatchedContrast {
  /** Inverse-variance weighted day-matched difference, treatment minus control. */
  estimate: number;
  /** sum over days of 1 / v_t. */
  information: number;
  /** Z = estimate x information. */
  z: number;
  days: number;
  treatmentN: number;
  controlN: number;
  treatmentMean: number;
  controlMean: number;
  treatmentVariance: number;
  controlVariance: number;
}

export interface SequentialTestOptions {
  /** Probability of ever excluding the true difference, over all looks. */
  alpha: number;
  /** Mixture scale (reward units): the effect size the boundary is tuned for. */
  tau: number;
  minTreatmentN: number;
  minControlN: number;
}

export interface SequentialTestResult extends DayMatchedContrast {
  alpha: number;
  tau: number;
  /** Always-valid (1 - alpha) confidence sequence for the difference. */
  lower: number;
  upper: number;
  /** ln Lambda for H0: difference = 0. */
  logLambda: number;
}

/** Pooled within-day variance of one side (n - 1 degrees of freedom per day); overall variance as a fallback. */
function pooledWithinDayVariance(parts: readonly SufficientStats[]): number {
  let ss = 0;
  let df = 0;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (const p of parts) {
    if (!(p.n > 0)) continue;
    n += p.n;
    sum += p.sum;
    sumSq += p.sumSq;
    if (p.n > 1) {
      ss += Math.max(0, p.sumSq - (p.sum * p.sum) / p.n);
      df += p.n - 1;
    }
  }
  if (df > 0) return ss / df;
  if (n > 0) return Math.max(0, sumSq / n - (sum / n) ** 2);
  return 0;
}

/** Day-matched, inverse-variance weighted difference of means; null when no day has both sides. */
export function dayMatchedContrast(days: readonly ContrastDay[]): DayMatchedContrast | null {
  const both = days.filter((d) => d.treatment.n > 0 && d.control.n > 0);
  if (both.length === 0) return null;
  const s2t = pooledWithinDayVariance(both.map((d) => d.treatment));
  const s2c = pooledWithinDayVariance(both.map((d) => d.control));
  // Degenerate data (every value identical on both sides): a tiny variance keeps the maths finite.
  const floor = 1e-12;
  let z = 0;
  let info = 0;
  let nT = 0;
  let nC = 0;
  let sumT = 0;
  let sumC = 0;
  for (const d of both) {
    const v = Math.max(floor, s2t / d.treatment.n + s2c / d.control.n);
    const diff = d.treatment.sum / d.treatment.n - d.control.sum / d.control.n;
    z += diff / v;
    info += 1 / v;
    nT += d.treatment.n;
    nC += d.control.n;
    sumT += d.treatment.sum;
    sumC += d.control.sum;
  }
  return {
    estimate: z / info,
    information: info,
    z,
    days: both.length,
    treatmentN: nT,
    controlN: nC,
    treatmentMean: sumT / nT,
    controlMean: sumC / nC,
    treatmentVariance: s2t,
    controlVariance: s2c,
  };
}

/** Half-width of the normal-mixture confidence sequence at information I. */
export function mixtureHalfWidth(information: number, tau: number, alpha: number): number {
  if (!(information > 0)) return Number.POSITIVE_INFINITY;
  if (!(tau > 0) || !(alpha > 0 && alpha < 1)) throw new Error('mixtureHalfWidth needs tau > 0 and 0 < alpha < 1');
  const t = tau * tau;
  return Math.sqrt(((1 + t * information) / (t * information * information)) * (2 * Math.log(1 / alpha) + Math.log1p(t * information)));
}

/** ln Lambda of the normal mixture for H0: difference = delta0. */
export function mixtureLogLikelihoodRatio(z: number, information: number, tau: number, delta0 = 0): number {
  const t = tau * tau;
  const zc = z - delta0 * information;
  return -0.5 * Math.log1p(t * information) + (t * zc * zc) / (2 * (1 + t * information));
}

/**
 * Always-valid comparison of treatment vs control; null when either side is below its minimum
 * sample size or no day has both sides.
 */
export function sequentialTest(days: readonly ContrastDay[], o: SequentialTestOptions): SequentialTestResult | null {
  const c = dayMatchedContrast(days);
  if (!c || c.treatmentN < o.minTreatmentN || c.controlN < o.minControlN) return null;
  const h = mixtureHalfWidth(c.information, o.tau, o.alpha);
  return { ...c, alpha: o.alpha, tau: o.tau, lower: c.estimate - h, upper: c.estimate + h, logLambda: mixtureLogLikelihoodRatio(c.z, c.information, o.tau) };
}
