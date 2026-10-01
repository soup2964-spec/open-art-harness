/**
 * Special functions the allocator needs, in plain TypeScript (no numeric dependency):
 *   - Student-t CDF / quantile: credible bounds of the NIG posterior mean (df = 2 alpha),
 *   - normal quantile: large-df limit and a starting point,
 *   - chi-square survival: the sample-ratio-mismatch (SRM) guard on the holdout split.
 * Algorithms: Lanczos log-gamma; Lentz continued fractions for the incomplete beta and
 * gamma functions (Numerical Recipes 3rd ed. §6.2, §6.4); Acklam's normal quantile with
 * one Halley refinement. Verified against scipy in test/rng-stats.test.ts.
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new Error(`logGamma needs x > 0, got ${x}`);
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-15;
const TINY = 1e-300;
const MAX_ITER = 20_000;

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  throw new Error(`incomplete beta did not converge (x=${x}, a=${a}, b=${b})`);
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new Error('incomplete beta needs a, b > 0');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Quantile of Beta(a, b) by bisection on the regularized incomplete beta function. */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`beta quantile needs 0 < p < 1, got ${p}`);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Regularized lower incomplete gamma P(a, x) and upper Q(a, x) = 1 - P. */
function regularizedGamma(a: number, x: number): { p: number; q: number } {
  if (!(a > 0)) throw new Error('incomplete gamma needs a > 0');
  if (x <= 0) return { p: 0, q: 1 };
  const lnFront = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    // Series representation.
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < MAX_ITER; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) {
        const p = sum * Math.exp(lnFront);
        return { p, q: 1 - p };
      }
    }
    throw new Error('incomplete gamma series did not converge');
  }
  // Continued fraction (modified Lentz).
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITER; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) {
      const q = Math.exp(lnFront) * h;
      return { p: 1 - q, q };
    }
  }
  throw new Error('incomplete gamma continued fraction did not converge');
}

/** P(X > x) for X ~ chi-square(df). */
export function chiSquareSurvival(x: number, df: number): number {
  if (!(df > 0)) throw new Error('chi-square needs df > 0');
  if (x <= 0) return 1;
  return regularizedGamma(df / 2, x / 2).q;
}

/** Standard normal CDF via erfc = Q(1/2, z^2/2). */
export function normalCdf(z: number): number {
  const q = regularizedGamma(0.5, (z * z) / 2).q; // = erfc(|z| / sqrt 2)
  return z >= 0 ? 1 - q / 2 : q / 2;
}

/** Standard normal quantile (Acklam's approximation + one Halley step). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normal quantile needs 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // Halley refinement against the exact CDF.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Above this df the Student t is replaced by the normal (error < 3e-6 on 97.5% quantiles). */
const T_NORMAL_LIMIT = 1e6;

/** CDF of the standard Student t with (possibly non-integer) df > 0. */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new Error(`Student t needs df > 0, got ${df}`);
  if (df >= T_NORMAL_LIMIT) return normalCdf(t);
  if (t === 0) return 0.5;
  const tail = 0.5 * regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Quantile of the standard Student t (bracketing + bisection to machine precision). */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`t quantile needs 0 < p < 1, got ${p}`);
  if (!(df > 0)) throw new Error(`Student t needs df > 0, got ${df}`);
  if (df >= T_NORMAL_LIMIT) return normalQuantile(p);
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let lo = 0;
  let hi = Math.max(1, normalQuantile(p));
  while (studentTCdf(hi, df) < p) {
    lo = hi;
    hi *= 2;
    if (!Number.isFinite(hi)) throw new Error('t quantile bracket overflow');
  }
  for (let i = 0; i < 200 && hi - lo > 1e-15 * Math.max(1, hi); i += 1) {
    const mid = 0.5 * (lo + hi);
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
