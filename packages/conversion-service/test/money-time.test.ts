import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMajor, minorToMajor, roundMajor } from '../src/money.js';
import { toUtc } from '../src/time.js';

describe('money', () => {
  it('uses Stripe minor-unit exponents (2 by default, 0 for zero-decimal, 3 for three-decimal)', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('converts signed minor units to major units without float drift', () => {
    expect(minorToMajor(1400, 'USD')).toBe(14);
    expect(minorToMajor(734, 'USD')).toBe(7.34);
    expect(minorToMajor(210240, 'USD')).toBe(2102.4);
    expect(minorToMajor(-1133, 'USD')).toBe(-11.33);
    expect(minorToMajor(1500, 'JPY')).toBe(1500);
    expect(minorToMajor(1234, 'KWD')).toBe(1.234);
  });

  it('rounds and formats major amounts to the currency precision', () => {
    expect(roundMajor(22.114999, 'USD')).toBe(22.11);
    expect(roundMajor(0.005, 'USD')).toBe(0.01);
    expect(formatMajor(7.3, 'USD')).toBe('7.30');
    expect(formatMajor(1500, 'JPY')).toBe('1500');
  });

  it('rejects non-integer minor amounts and malformed currencies', () => {
    expect(() => minorToMajor(14.5, 'USD')).toThrow();
    expect(() => minorToMajor(100, 'US')).toThrow();
  });
});

describe('time', () => {
  it('renders RFC 3339 UTC and drops a zero millisecond part (the ledger fixture convention)', () => {
    expect(toUtc(Date.parse('2026-06-03T17:04:11Z'))).toBe('2026-06-03T17:04:11Z');
    expect(toUtc(Date.parse('2026-06-03T17:04:11.250Z'))).toBe('2026-06-03T17:04:11.250Z');
  });

  it('rejects invalid timestamps', () => {
    expect(() => toUtc(Number.NaN)).toThrow();
  });
});
