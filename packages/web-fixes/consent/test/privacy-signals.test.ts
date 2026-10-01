import { describe, expect, it } from 'vitest';
import {
  CONSENT_COOKIE,
  US_PRIVACY_COOKIE,
  adConsentDecision,
  parseUsPrivacyString,
  readPrivacySignals,
  type PrivacySignals,
  type PrivacySignalWindow,
} from '../src/privacy-signals';

const oaConsent = (obj: unknown) => `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(obj))}`;
const win = (cookie: string, extra: Partial<PrivacySignalWindow> = {}): PrivacySignalWindow => ({ document: { cookie }, navigator: {}, ...extra });

describe('parseUsPrivacyString (IAB CCPA "usprivacy" cookie)', () => {
  it('reads the third character: opted out of sale (Y), not opted out (N), not applicable (-)', () => {
    expect(parseUsPrivacyString('1YYN')).toBe(true);
    expect(parseUsPrivacyString('1NYY')).toBe(true);
    expect(parseUsPrivacyString('1YNN')).toBe(false);
    expect(parseUsPrivacyString('1---')).toBeNull();
    expect(parseUsPrivacyString('1yyn')).toBe(true);
  });

  it('rejects anything that is not a version-1 string', () => {
    for (const bad of ['', 'YYN', '2YYN', '1YYNX', '1Y?N', '<img src=x>', undefined, null]) expect(parseUsPrivacyString(bad), String(bad)).toBeNull();
  });
});

describe('readPrivacySignals', () => {
  it('GPC is navigator.globalPrivacyControl === true (and nothing else)', () => {
    expect(readPrivacySignals(win('', { navigator: { globalPrivacyControl: true } })).gpc).toBe(true);
    for (const v of [false, 'true', 1, undefined]) expect(readPrivacySignals(win('', { navigator: { globalPrivacyControl: v } })).gpc).toBe(false);
    expect(readPrivacySignals(win('', { navigator: null })).gpc).toBe(false);
  });

  it('a US sale/sharing opt-out comes from oa_consent.opt_out_sale_sharing === true or usprivacy', () => {
    expect(readPrivacySignals(win(oaConsent({ opt_out_sale_sharing: true }))).optOutSaleSharing).toBe(true);
    expect(readPrivacySignals(win(oaConsent({ opt_out_sale_sharing: 'yes' }))).optOutSaleSharing).toBe(false);
    expect(readPrivacySignals(win(`${US_PRIVACY_COOKIE}=1YYN`)).optOutSaleSharing).toBe(true);
    expect(readPrivacySignals(win(`${US_PRIVACY_COOKIE}=1YNN`)).optOutSaleSharing).toBe(false);
    expect(readPrivacySignals(win('')).optOutSaleSharing).toBe(false);
  });

  it('ad_storage comes from window.__oaConsent first, else the oa_consent cookie', () => {
    expect(readPrivacySignals(win(oaConsent({ ad_storage: 'denied' }))).adStorage).toBe('denied');
    expect(readPrivacySignals(win(oaConsent({ ad_storage: 'denied' }), { __oaConsent: { ad_storage: 'granted' } })).adStorage).toBe('granted');
    expect(readPrivacySignals(win(oaConsent({ ad_storage: 'maybe' }))).adStorage).toBeUndefined();
    expect(readPrivacySignals(win('oa_consent=%7Bnot-json')).adStorage).toBeUndefined();
  });

  it('never throws on hostile environments', () => {
    const hostile = {
      get document(): { cookie: string } {
        throw new Error('SecurityError');
      },
      get navigator(): never {
        throw new Error('SecurityError');
      },
    } as unknown as PrivacySignalWindow;
    expect(readPrivacySignals(hostile)).toEqual({ gpc: false, optOutSaleSharing: false });
  });
});

describe('adConsentDecision (the order edge-attribution’s default policy applies)', () => {
  const cases: Array<[PrivacySignals, ReturnType<typeof adConsentDecision>]> = [
    [{ gpc: false, optOutSaleSharing: false }, 'none'],
    [{ gpc: true, optOutSaleSharing: false }, 'opt_out'],
    [{ gpc: false, optOutSaleSharing: true }, 'opt_out'],
    // An explicit grant is the visitor opting back in over GPC...
    [{ adStorage: 'granted', gpc: true, optOutSaleSharing: false }, 'granted'],
    // ...but not over a recorded "do not sell or share" (a US CMP may grant ad_storage by default).
    [{ adStorage: 'granted', gpc: false, optOutSaleSharing: true }, 'opt_out'],
    [{ adStorage: 'denied', gpc: false, optOutSaleSharing: true }, 'denied'],
    [{ adStorage: 'denied', gpc: false, optOutSaleSharing: false }, 'denied'],
  ];
  for (const [signals, expected] of cases) {
    it(`${JSON.stringify(signals)} -> ${expected}`, () => expect(adConsentDecision(signals)).toBe(expected));
  }
});
