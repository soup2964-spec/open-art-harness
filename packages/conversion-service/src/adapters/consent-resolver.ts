/**
 * ConsentResolver.
 *
 * 1. resolveRowConsent: which consent block the canonical row records (source > stored CMP
 *    state > unknown state in the user's known region).
 * 2. decidePlatformConsent: whether a platform may receive the event and with which
 *    platform-native consent fields.
 *
 * Policy (defaults; OpenArt's legal/product decision, research/08 §1.7 and §6.3):
 *  - Global Privacy Control or a US-state "do not sell or share" opt-out: never sent anywhere,
 *    a CMP grant and CONSENT_OPT_OUT_HANDLING=restrict included (contracts adSharingOptedOut).
 *  - An explicit "denied" counts whatever its source (cmp, regional_default or none).
 *  - EEA, UK, CH and EU territories with their own ISO codes (contracts CONSENT_REQUIRED_REGIONS,
 *    the single source of truth; "UK" and subdivisions like GB-ENG are normalised): send only with an
 *    explicit CMP grant of ad_storage AND ad_user_data. Without a CMP today, these rows are withheld.
 *  - Unknown region: withheld (fail closed), like edge-attribution's default.
 *  - The decision is taken when a record is queued AND again right before it is sent, against the
 *    row's consent merged with the user's current state (mergeConsentForSend): a withdrawal between
 *    the two stops the send.
 *  - Elsewhere without a CMP signal (OpenArt today): send, asserting nothing — Google gets
 *    no consent object (the tag's gcd is "not set" too), Microsoft keeps its default,
 *    Meta gets data_processing_options [] (explicitly no LDU).
 *  - Explicit CMP opt-out outside the EEA/UK/CH:
 *      optOutHandling 'drop' (default)  -> not sent anywhere
 *      optOutHandling 'restrict'        -> sent only where a limited-use mode exists:
 *        Google adUserData/adPersonalization DENIED, Meta LDU (US only), TikTok
 *        limited_data_use (needs the IP), Reddit data_processing_options LDU, Microsoft
 *        adStorageConsent "D"; LinkedIn and X have no such field, so they are dropped.
 */

import type { Consent, ConsentState, Platform } from '@openart-signal/contracts';
import { CONSENT_REQUIRED_REGIONS, adSharingOptedOut, consentCountry, isExplicitlyDenied, unknownConsent } from '@openart-signal/contracts';
import type { RequestContext } from '../types.js';
import type { UserContext } from './user-context.js';

/** The contracts single source of truth (EEA incl. outermost regions, GB/UK, CH). */
export const REGULATED_COUNTRIES: ReadonlySet<string> = CONSENT_REQUIRED_REGIONS;

export interface ConsentPolicy {
  regulatedCountries: ReadonlySet<string>;
  unknownRegion: 'block' | 'allow';
  optOutHandling: 'drop' | 'restrict';
}

export const DEFAULT_CONSENT_POLICY: ConsentPolicy = {
  regulatedCountries: REGULATED_COUNTRIES,
  unknownRegion: 'block',
  optOutHandling: 'drop',
};

function mergeSignal(recorded: ConsentState, current: ConsentState, currentIsCmp: boolean): ConsentState {
  if (recorded === 'denied' || current === 'denied') return 'denied';
  if (currentIsCmp && current !== 'unknown') return current;
  return recorded;
}

/**
 * Consent for a send-time re-check: the row's consent (what was true when the event happened) merged
 * with the user's CURRENT state. A denial or opt-out from either side wins, so a withdrawal before the
 * send stops it and a later grant never overrides a denial recorded with the event. A current CMP grant
 * fills in signals the row did not know.
 */
export function mergeConsentForSend(recorded: Consent, current: Consent | null | undefined): Consent {
  if (!current) return recorded;
  const cmp = current.source === 'cmp';
  const merged: Consent = {
    ad_storage: mergeSignal(recorded.ad_storage, current.ad_storage, cmp),
    ad_user_data: mergeSignal(recorded.ad_user_data, current.ad_user_data, cmp),
    ad_personalization: mergeSignal(recorded.ad_personalization, current.ad_personalization, cmp),
    analytics_storage: mergeSignal(recorded.analytics_storage, current.analytics_storage, cmp),
    region: recorded.region ?? current.region,
    source: cmp ? 'cmp' : recorded.source,
  };
  if (recorded.gpc !== undefined || current.gpc !== undefined) merged.gpc = recorded.gpc === true || current.gpc === true;
  if (recorded.opt_out_sale_sharing !== undefined || current.opt_out_sale_sharing !== undefined) {
    merged.opt_out_sale_sharing = recorded.opt_out_sale_sharing === true || current.opt_out_sale_sharing === true;
  }
  return merged;
}

export function resolveRowConsent(rowConsent: Consent, fromSource: boolean, user: UserContext | null): Consent {
  if (fromSource) return rowConsent;
  if (user?.consent) return user.consent;
  if (rowConsent.region) return rowConsent;
  return unknownConsent(user?.region ?? null);
}

export type GoogleConsentStatus = 'CONSENT_GRANTED' | 'CONSENT_DENIED' | 'CONSENT_STATUS_UNSPECIFIED';

export interface MetaConsentFields {
  data_processing_options: string[];
  data_processing_options_country?: number;
  data_processing_options_state?: number;
}

export interface RedditLdu {
  modes: ['LDU'];
  country: string;
  region?: string;
}

export type PlatformConsentDecision =
  | { send: false; reason: string }
  | {
      send: true;
      mode: 'granted' | 'unspecified' | 'restricted';
      /** Data Manager consent object; null = omit (no signal collected). */
      google: { adUserData: GoogleConsentStatus; adPersonalization: GoogleConsentStatus } | null;
      meta: MetaConsentFields;
      tiktokLimitedDataUse: boolean;
      reddit: RedditLdu | null;
      /** UET CAPI adStorageConsent; null = omit (Microsoft's default is granted). */
      microsoftAdStorage: 'G' | 'D' | null;
    };

function googleStatus(state: Consent['ad_user_data']): GoogleConsentStatus {
  if (state === 'granted') return 'CONSENT_GRANTED';
  if (state === 'denied') return 'CONSENT_DENIED';
  return 'CONSENT_STATUS_UNSPECIFIED';
}

/** Meta's LDU state codes: 1000 = California per the server-event reference; 0 = let Meta geolocate. */
function metaLduState(region: string): number {
  return region === 'US-CA' ? 1000 : 0;
}

/** Permissiveness of a queued item's consent claims: an item may be sent only under a mode at least as permissive. */
export const CONSENT_MODE_RANK: Readonly<Record<'restricted' | 'unspecified' | 'granted', number>> = { restricted: 0, unspecified: 1, granted: 2 };

export function decidePlatformConsent(
  consent: Consent,
  platform: Platform,
  policy: ConsentPolicy,
  context: Pick<RequestContext, 'client_ip_address'>,
): PlatformConsentDecision {
  // GPC / sale-sharing opt-out: nothing is shared with an ad platform, whatever else is recorded.
  if (adSharingOptedOut(consent)) return { send: false, reason: 'gpc_or_sale_opt_out' };
  const country = consentCountry(consent.region);
  // Any "denied" counts, whatever its source (a regional default or an unattributed denial included).
  const explicitDenied = isExplicitlyDenied(consent);
  const explicitGranted = consent.source === 'cmp' && !explicitDenied && consent.ad_user_data === 'granted' && consent.ad_storage === 'granted';
  const regulated = country !== null && (policy.regulatedCountries.has(country) || (country === 'GB' && policy.regulatedCountries.has('UK')));

  if (!explicitGranted && explicitDenied && (regulated || country === null || policy.optOutHandling === 'drop')) {
    return { send: false, reason: 'consent_denied' };
  }
  if (!country && policy.unknownRegion === 'block' && !explicitGranted) return { send: false, reason: 'consent_region_unknown' };

  if (explicitGranted) {
    return {
      send: true,
      mode: 'granted',
      google: { adUserData: 'CONSENT_GRANTED', adPersonalization: googleStatus(consent.ad_personalization) },
      meta: { data_processing_options: [] },
      tiktokLimitedDataUse: false,
      reddit: null,
      microsoftAdStorage: 'G',
    };
  }
  if (regulated) return { send: false, reason: explicitDenied ? 'consent_denied' : 'consent_required_regulated_region' };

  if (!explicitDenied) {
    return {
      send: true,
      mode: 'unspecified',
      google: null,
      meta: { data_processing_options: [] },
      tiktokLimitedDataUse: false,
      reddit: null,
      microsoftAdStorage: null,
    };
  }

  // Explicit opt-out outside the regulated regions.
  if (policy.optOutHandling === 'drop') return { send: false, reason: 'consent_denied' };
  const region = consent.region ?? '';
  const base = {
    send: true as const,
    mode: 'restricted' as const,
    google: { adUserData: 'CONSENT_DENIED' as const, adPersonalization: 'CONSENT_DENIED' as const },
    meta: { data_processing_options: ['LDU'], data_processing_options_country: 1, data_processing_options_state: metaLduState(region) },
    tiktokLimitedDataUse: true,
    reddit: { modes: ['LDU'] as ['LDU'], country: country ?? 'US', ...(region.includes('-') ? { region } : {}) },
    microsoftAdStorage: 'D' as const,
  };
  switch (platform) {
    case 'meta':
      return country === 'US' ? base : { send: false, reason: 'meta_ldu_us_only' };
    case 'tiktok':
      return context.client_ip_address ? base : { send: false, reason: 'tiktok_ldu_requires_ip' };
    case 'linkedin':
    case 'x':
      return { send: false, reason: 'consent_denied_no_limited_mode' };
    default:
      return base;
  }
}
