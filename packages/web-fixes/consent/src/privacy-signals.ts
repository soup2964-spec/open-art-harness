/**
 * Browser-observable privacy signals, read the same way by every web fix that stores or sends ad
 * identifiers: the Consent Mode defaults (on-page form), the click-ID shim and the HubSpot form
 * fill. The GTM template repeats the same logic in sandboxed JS (consent-defaults.ts).
 *
 *  - Global Privacy Control: `navigator.globalPrivacyControl === true` (the JS side of `Sec-GPC: 1`,
 *    which packages/edge-attribution reads).
 *  - A US "do not sell or share" opt-out, where a mechanism leaves it in the browser:
 *      - `oa_consent` (the CMP-agnostic cookie edge-attribution reads) with `opt_out_sale_sharing: true`;
 *      - the IAB CCPA US Privacy string cookie `usprivacy` with the opt-out-of-sale flag `Y` ("1YYN").
 *  - An explicit Consent Mode `ad_storage` choice: `window.__oaConsent` (set inline before the
 *    shim), else `oa_consent`.
 *
 * `adConsentDecision` applies the order edge-attribution's default policy uses, so the browser
 * and the edge treat one visitor the same way.
 */
import { readCookie } from '../../app-patches/src/click-id-keys';

/** CMP decision cookie shared with packages/edge-attribution (URI-encoded JSON of Consent Mode signals). */
export const CONSENT_COOKIE = 'oa_consent';
/** IAB CCPA US Privacy string (`1YYN` = notice given, opted out of sale, LSPA covered). */
export const US_PRIVACY_COOKIE = 'usprivacy';

export type ConsentValue = 'granted' | 'denied';

export interface PrivacySignals {
  /** Explicit Consent Mode `ad_storage` choice, when one is recorded. */
  adStorage?: ConsentValue;
  /** Global Privacy Control. */
  gpc: boolean;
  /** A US "do not sell or share my personal information" opt-out recorded in a cookie. */
  optOutSaleSharing: boolean;
}

export interface PrivacySignalWindow {
  document: { cookie: string };
  navigator?: { globalPrivacyControl?: unknown } | null;
  __oaConsent?: { ad_storage?: unknown } | null;
}

/**
 * - `granted`: explicit ad_storage grant (it also overrides GPC: the visitor opted back in).
 * - `denied`: explicit ad_storage denial.
 * - `opt_out`: GPC or a sale/sharing opt-out without an explicit grant; a recorded sale/sharing
 *   opt-out wins over a grant, because US CMPs often grant ad_storage by default.
 * - `none`: no signal (today's behaviour).
 */
export type AdConsentDecision = 'granted' | 'denied' | 'opt_out' | 'none';

const asConsentValue = (v: unknown): ConsentValue | undefined => (v === 'granted' || v === 'denied' ? v : undefined);

/** true = opted out of sale, false = not opted out, null = no usable string (`-`, wrong version, garbage). */
export function parseUsPrivacyString(raw: string | null | undefined): boolean | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (!/^1[YN-]{3}$/.test(s)) return null;
  const flag = s.charAt(2);
  return flag === 'Y' ? true : flag === 'N' ? false : null;
}

function parseConsentCookie(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Never throws: an unreadable signal counts as absent. */
export function readPrivacySignals(win: PrivacySignalWindow): PrivacySignals {
  let cookie = '';
  try {
    cookie = String(win.document.cookie ?? '');
  } catch {
    cookie = '';
  }
  let gpc = false;
  try {
    gpc = win.navigator?.globalPrivacyControl === true;
  } catch {
    gpc = false;
  }
  const stored = parseConsentCookie(readCookie(cookie, CONSENT_COOKIE));
  let explicit: ConsentValue | undefined;
  try {
    explicit = asConsentValue(win.__oaConsent?.ad_storage);
  } catch {
    explicit = undefined;
  }
  const adStorage = explicit ?? asConsentValue(stored?.ad_storage);
  const optOutSaleSharing = stored?.opt_out_sale_sharing === true || parseUsPrivacyString(readCookie(cookie, US_PRIVACY_COOKIE)) === true;
  const out: PrivacySignals = { gpc, optOutSaleSharing };
  if (adStorage) out.adStorage = adStorage;
  return out;
}

export function adConsentDecision(s: PrivacySignals): AdConsentDecision {
  if (s.adStorage === 'denied') return 'denied';
  if (s.optOutSaleSharing) return 'opt_out';
  if (s.adStorage === 'granted') return 'granted';
  if (s.gpc) return 'opt_out';
  return 'none';
}

/** Ad identifiers may be stored or sent: an explicit grant, or no signal at all (today's behaviour). */
export function allowsAdIdentifiers(decision: AdConsentDecision): boolean {
  return decision === 'granted' || decision === 'none';
}
