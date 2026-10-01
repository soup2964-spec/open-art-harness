// Google consent-mode signals on attempted Google hits.
//
// gcd — "Google Consent Default": always sent to Google services, whether or not consent mode is
//   implemented (developers.google.com/tag-platform/security/concepts/consent-mode). Google does not
//   publish the letter codes. The community decode used here is Markus Baersch's, published in
//   Simo Ahava, "Consent Mode V2 For Google Tags" (https://www.simoahava.com/analytics/consent-mode-v2-google-tags/),
//   corroborated by https://www.giancampo.com/2024/02/understanding-new-gcd-parameter-in-ga4.html
//   (both checked 2026-09-29, see research/08_best_practice.md §1.7 and research/01 §T2).
//   One letter per signal, in the order ad_storage, analytics_storage, ad_user_data, ad_personalization;
//   the digits between letters (1/3/5) and any trailing letters are undocumented.
//
//        | no update | update→denied | update→granted
//   none |     l     |      m        |       n
//   deny |     p     |      q        |       r
//   grant|     t     |      u        |       v
//
// gcs — "G1<ad_storage><analytics_storage>" with 1 = granted, 0 = denied; only sent when consent
//   mode is active (same Simo Ahava source). OpenArt today: gcd=13l3l3l3l1l1 and no gcs = no consent mode.
import type { ConsentSignalState, ConsentSignals } from '../types.js';

export const GCD_SOURCE = {
  primary: 'Simo Ahava, "Consent Mode V2 For Google Tags" (decode by Markus Baersch) — https://www.simoahava.com/analytics/consent-mode-v2-google-tags/',
  corroborating: 'https://www.giancampo.com/2024/02/understanding-new-gcd-parameter-in-ga4.html',
  googleStatement: 'https://developers.google.com/tag-platform/security/concepts/consent-mode — gcd "is always sent to Google services, regardless of whether consent mode is activated or not"',
  checked: '2026-09-29',
};

export const GCD_LETTERS: Record<string, { default: ConsentSignalState['default']; update: ConsentSignalState['update'] }> = {
  l: { default: 'not set', update: 'none' },
  m: { default: 'not set', update: 'denied' },
  n: { default: 'not set', update: 'granted' },
  p: { default: 'denied', update: 'none' },
  q: { default: 'denied', update: 'denied' },
  r: { default: 'denied', update: 'granted' },
  t: { default: 'granted', update: 'none' },
  u: { default: 'granted', update: 'denied' },
  v: { default: 'granted', update: 'granted' },
};

export const GCD_SIGNALS = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'] as const;

export function decodeLetter(letter: string): ConsentSignalState {
  const m = GCD_LETTERS[letter];
  if (!m) return { letter, default: 'unknown', update: 'unknown', effective: 'unknown' };
  const effective: ConsentSignalState['effective'] = m.update === 'granted' ? 'granted' : m.update === 'denied' ? 'denied' : m.default === 'granted' ? 'granted' : m.default === 'denied' ? 'denied' : 'not set';
  return { letter, default: m.default, update: m.update, effective };
}

export function decodeGcd(gcd: string | undefined | null): ConsentSignals['decoded'] {
  if (!gcd) return null;
  const letters = gcd.match(/[a-z]/g) || [];
  if (letters.length < 4) return null;
  const [a, b, c, d, ...rest] = letters;
  return {
    ad_storage: decodeLetter(a!),
    analytics_storage: decodeLetter(b!),
    ad_user_data: decodeLetter(c!),
    ad_personalization: decodeLetter(d!),
    extra: rest.map(decodeLetter),
  };
}

export function decodeGcs(gcs: string | undefined | null): ConsentSignals['gcsDecoded'] {
  const m = /^G1([01])([01])$/.exec(gcs || '');
  if (!m) return null;
  return { ad_storage: m[1] === '1' ? 'granted' : 'denied', analytics_storage: m[2] === '1' ? 'granted' : 'denied' };
}

export function decodeConsent(p: { gcd?: string; gcs?: string; dma?: string; npa?: string }): ConsentSignals | undefined {
  if (!p.gcd && !p.gcs) return undefined;
  return { gcd: p.gcd, gcs: p.gcs, dma: p.dma, npa: p.npa, decoded: decodeGcd(p.gcd), gcsDecoded: decodeGcs(p.gcs) };
}

/** True when every one of the four v2 signals carries a default (i.e. consent mode is initialised). */
export function defaultsSet(decoded: ConsentSignals['decoded']): boolean {
  if (!decoded) return false;
  return GCD_SIGNALS.every((s) => {
    const st = decoded[s];
    return !!st && (st.default === 'denied' || st.default === 'granted');
  });
}
