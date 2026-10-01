/**
 * Deterministic PRNG (sfc32, seeded through a 128-bit FNV/murmur-style mixer) plus the
 * sampling helpers the cohort generator needs. Same seed => same stream on every
 * platform (only 32-bit integer ops and Math.imul).
 */

function hashSeed(seed: string): [number, number, number, number] {
  // cyrb128: well-distributed 128-bit hash of a string.
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

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const HEX = '0123456789abcdef';

export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number) {
    [this.a, this.b, this.c, this.d] = hashSeed(String(seed));
    for (let i = 0; i < 12; i += 1) this.nextUint32(); // warm up
  }

  /** Independent child stream (e.g. one per user) derived from a label. */
  fork(label: string): Prng {
    return new Prng(`${this.nextUint32()}:${label}`);
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

  bool(p: number): boolean {
    return this.next() < p;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Pick a key of a weight map (weights need not sum to 1). */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as Array<[K, number]>;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r < 0) return k;
    }
    return entries[entries.length - 1]![0];
  }

  /** Poisson sample (Knuth; fine for the small means used here). */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= this.next();
    } while (p > limit && k < 1000);
    return k - 1;
  }

  /** Beta(a, b) via two gamma draws (Marsaglia-Tsang), for utilisation shares. */
  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }

  private gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.next() || 1e-12, 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        const u1 = this.next() || 1e-12;
        const u2 = this.next();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  base62(length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += BASE62[this.nextUint32() % 62];
    return out;
  }

  hex(length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += HEX[this.nextUint32() & 15];
    return out;
  }

  /** RFC 4122 v4-shaped UUID (deterministic). */
  uuidv4(): string {
    const h = this.hex(32).split('');
    h[12] = '4';
    h[16] = HEX[(parseInt(h[16]!, 16) & 0x3) | 0x8]!;
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  /** RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, variant 10, deterministic random bits. */
  uuidv7(epochMs: number): string {
    const ts = Math.floor(epochMs).toString(16).padStart(12, '0').slice(-12);
    const rand = this.hex(20).split('');
    rand[4] = HEX[(parseInt(rand[4]!, 16) & 0x3) | 0x8]!;
    const r = rand.join('');
    return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${r.slice(0, 3)}-${r.slice(4, 8)}-${r.slice(8, 20)}`;
  }
}
