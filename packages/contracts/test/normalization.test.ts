import { describe, expect, it } from 'vitest';
import { hashEmailFor, hashPhoneFor, normalizeEmailFor, normalizePhoneFor, PLATFORMS } from '../src/index.js';

describe('per-platform email normalisation (research/08 §6.3)', () => {
  const raw = '  Seal.Test+promo@Example.COM ';

  it('google_ads (Data Manager): lowercase + trim; dots and +suffix stripped only for gmail/googlemail', () => {
    expect(normalizeEmailFor('google_ads', raw)).toBe('seal.test+promo@example.com');
    expect(normalizeEmailFor('google_ads', ' Jane.Doe+ads@GoogleMail.com')).toBe('janedoe@googlemail.com');
    expect(normalizeEmailFor('google_ads', 'jane.doe+x@gmail.com')).toBe('janedoe@gmail.com');
  });

  it('meta / tiktok / linkedin / x: trim + lowercase only', () => {
    for (const p of ['meta', 'tiktok', 'linkedin', 'x'] as const) {
      expect(normalizeEmailFor(p, raw)).toBe('seal.test+promo@example.com');
    }
  });

  it('reddit / microsoft: strip dots and +suffix in the local part for every domain', () => {
    expect(normalizeEmailFor('reddit', raw)).toBe('sealtest@example.com');
    expect(normalizeEmailFor('microsoft', raw)).toBe('sealtest@example.com');
  });

  it('reproduces what the live pixels put on the wire (sealed replay §3.2)', () => {
    // X and TikTok sent SHA-256 of the trimmed/lower-cased address.
    expect(hashEmailFor('x', 'seal.test@example.com')).toBe(
      '3954eed7e6fa8e044adb47617ff334f24f58ce4ce97ce0cc8c8949891f5f54f0',
    );
    expect(hashEmailFor('tiktok', 'seal.test@example.com')).toBe(
      '3954eed7e6fa8e044adb47617ff334f24f58ce4ce97ce0cc8c8949891f5f54f0',
    );
    // Reddit hashed the dot-stripped local part.
    expect(hashEmailFor('reddit', 'seal.test@example.com')).toBe(
      '466077b2a66b98bceca9f24700707498fdb8b22dc638b7eb833dd54171c99270',
    );
  });

  it('refuses to hash something that is not an email', () => {
    expect(() => normalizeEmailFor('meta', 'not-an-email')).toThrow();
    expect(() => normalizeEmailFor('meta', '')).toThrow();
  });

  it('covers every platform', () => {
    for (const p of PLATFORMS) expect(hashEmailFor(p, 'a@b.co')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('per-platform phone normalisation', () => {
  it('meta drops the leading +; everyone else keeps E.164 with +', () => {
    expect(normalizePhoneFor('meta', '+1 (415) 555-0100')).toBe('14155550100');
    expect(normalizePhoneFor('google_ads', '+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhoneFor('tiktok', '+14155550100')).toBe('+14155550100');
    expect(hashPhoneFor('meta', '+14155550100')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires a country code', () => {
    expect(() => normalizePhoneFor('meta', '4155550100')).toThrow(/E\.164/);
  });
});
