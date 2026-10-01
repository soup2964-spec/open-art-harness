import { describe, expect, it } from 'vitest';
import { decodeConsent, decodeGcd, decodeGcs, decodeLetter, defaultsSet } from '../src/consent/gcd.js';

describe('gcd / gcs decoding', () => {
  it("decodes OpenArt's live gcd (research: 348/348 Google hits) as 'no consent mode'", () => {
    const d = decodeGcd('13l3l3l3l1l1')!;
    expect(d.ad_storage).toMatchObject({ letter: 'l', default: 'not set', update: 'none', effective: 'not set' });
    expect(d.analytics_storage!.letter).toBe('l');
    expect(d.ad_user_data!.letter).toBe('l');
    expect(d.ad_personalization!.letter).toBe('l');
    expect(d.extra).toHaveLength(1); // the undocumented trailing letter
    expect(defaultsSet(d)).toBe(false);
  });

  it('decodes an EEA advanced-mode default-denied state', () => {
    const d = decodeGcd('13p3p3p3p1l1')!;
    expect(d.ad_storage).toMatchObject({ default: 'denied', update: 'none', effective: 'denied' });
    expect(defaultsSet(d)).toBe(true);
  });

  it('maps every letter of the published table', () => {
    expect(decodeLetter('m')).toMatchObject({ default: 'not set', update: 'denied', effective: 'denied' });
    expect(decodeLetter('n')).toMatchObject({ default: 'not set', update: 'granted', effective: 'granted' });
    expect(decodeLetter('q')).toMatchObject({ default: 'denied', update: 'denied', effective: 'denied' });
    expect(decodeLetter('r')).toMatchObject({ default: 'denied', update: 'granted', effective: 'granted' });
    expect(decodeLetter('t')).toMatchObject({ default: 'granted', update: 'none', effective: 'granted' });
    expect(decodeLetter('u')).toMatchObject({ default: 'granted', update: 'denied', effective: 'denied' });
    expect(decodeLetter('v')).toMatchObject({ default: 'granted', update: 'granted', effective: 'granted' });
    expect(decodeLetter('z').default).toBe('unknown');
  });

  it('decodes gcs and tolerates absence', () => {
    expect(decodeGcs('G100')).toEqual({ ad_storage: 'denied', analytics_storage: 'denied' });
    expect(decodeGcs('G111')).toEqual({ ad_storage: 'granted', analytics_storage: 'granted' });
    expect(decodeGcs(undefined)).toBeNull();
    expect(decodeGcd('')).toBeNull();
    expect(decodeConsent({})).toBeUndefined();
    expect(decodeConsent({ gcd: '13l3l3l3l1l1', dma: '0', npa: '0' })?.decoded?.ad_storage?.letter).toBe('l');
  });
});
