/** Time helpers. All service time is ms since epoch, injected via a Clock for determinism. */

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** RFC 3339 UTC; a zero millisecond part is dropped (…:11Z), matching the contracts fixtures. */
export function toUtc(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp: ${ms}`);
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

/** Parse an RFC 3339 timestamp to ms, throwing on garbage. */
export function parseUtc(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp: ${JSON.stringify(value)}`);
  return ms;
}

/** A clock tests can move. */
export class ManualClock {
  constructor(private current: number) {}
  readonly now: Clock = () => this.current;
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
