/**
 * Deterministic, seedable RNG for Thompson sampling and the simulation.
 *
 * sfc32 seeded through cyrb128 (the same construction as the contracts cohort's
 * internal Prng, which is not a public export of @openart-signal/contracts). Only
 * 32-bit integer operations and Math.imul are used, so a given seed yields the same
 * stream on every platform. That is what makes the daily job reproducible: re-running
 * it for the same date and data emits the byte-identical LaunchDarkly patch.
 */

function cyrb128(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i += 1) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export class SeededRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareNormal: number | null = null;

  constructor(readonly seed: string) {
    [this.a, this.b, this.c, this.d] = cyrb128(seed);
    for (let i = 0; i < 15; i += 1) this.nextUint32();
  }

  /** Independent child stream derived from this seed and a label (does not advance this stream). */
  fork(label: string): SeededRng {
    return new SeededRng(`${this.seed}/${label}`);
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in (0, 1): safe for logarithms. */
  nextOpen(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }

  /** Standard normal (Marsaglia polar method; the second variate is cached). */
  normal(): number {
    if (this.spareNormal !== null) {
      const z = this.spareNormal;
      this.spareNormal = null;
      return z;
    }
    for (;;) {
      const u = 2 * this.next() - 1;
      const v = 2 * this.next() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        const f = Math.sqrt((-2 * Math.log(s)) / s);
        this.spareNormal = v * f;
        return u * f;
      }
    }
  }

  /** Gamma(shape, scale 1) via Marsaglia-Tsang (shape < 1 boosted by u^(1/shape)). */
  gamma(shape: number): number {
    if (!(shape > 0) || !Number.isFinite(shape)) throw new Error(`gamma shape must be a positive finite number, got ${shape}`);
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.nextOpen(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.nextOpen();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /** Beta(a, b) as a ratio of gammas. */
  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }
}
