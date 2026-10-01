/**
 * Consent policy primitives shared by every openart-signal package. This is the single
 * source of truth: edge-attribution, conversion-service, audience-sync and the warehouse
 * should import from here instead of keeping their own country lists.
 *
 *  - CONSENT_REQUIRED_REGIONS: where only an explicit opt-in (a CMP grant) allows ad use of
 *    personal data. This is Google's EU user consent policy scope, the EEA (EU27 + IS, LI,
 *    NO) plus the UK and Switzerland, together with the EU territories that geolocation
 *    reports under their own codes (outermost regions, Åland, the Canary Islands, Ceuta
 *    and Melilla).
 *  - requiresConsent(country): membership test that normalises case, ISO 3166-2
 *    subdivisions ("GB-ENG") and the "UK" alias, and fails closed on unknown regions.
 *  - isExplicitlyDenied / adSharingOptedOut / blocksAdSharing: the denial semantics. An
 *    explicit "denied" counts whatever its source (cmp, regional_default or none), and a
 *    Global Privacy Control signal or a US-state "do not sell or share" opt-out blocks ad
 *    sharing in every region, a CMP grant included.
 */

import type { ConsentSignal } from './constants.js';
import type { Consent } from './types.js';

/** EU member states. */
export const EU27_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const;

/** EFTA states that are in the EEA. */
export const EEA_EFTA_COUNTRIES = ['IS', 'LI', 'NO'] as const;

/**
 * EU territory that geolocation reports under its own code: the outermost regions
 * Réunion, French Guiana, Guadeloupe, Martinique, Mayotte and Saint-Martin, plus Åland
 * and the reserved codes some providers use for the Canary Islands (IC) and Ceuta and
 * Melilla (EA). The Azores and Madeira geolocate as PT. Saint-Barthélemy (BL) and
 * Saint-Pierre-et-Miquelon (PM) are overseas countries and territories, not EU territory.
 */
export const EU_SPECIAL_TERRITORIES = ['RE', 'GF', 'GP', 'MQ', 'YT', 'MF', 'AX', 'IC', 'EA'] as const;

/** Outside the EEA but in Google's EU user consent policy scope. GB is the ISO code; UK is an alias. */
export const EEA_ADJACENT_CONSENT_COUNTRIES = ['GB', 'UK', 'CH'] as const;

/** Every country code where only an explicit opt-in allows ad use of personal data. */
export const CONSENT_REQUIRED_REGIONS: ReadonlySet<string> = new Set<string>([
  ...EU27_COUNTRIES,
  ...EEA_EFTA_COUNTRIES,
  ...EU_SPECIAL_TERRITORIES,
  ...EEA_ADJACENT_CONSENT_COUNTRIES,
]);

/** Geolocation placeholders that mean "unknown": Cloudflare's XX (no data) and T1 (Tor), and ZZ. */
const UNKNOWN_COUNTRY_CODES: ReadonlySet<string> = new Set(['XX', 'T1', 'ZZ']);

/**
 * The upper-case alpha-2 country of a consent region ("gb-eng" -> "GB", "uk" -> "GB"), or
 * null when the region is missing or unusable (empty, malformed, XX, T1, ZZ).
 */
export function consentCountry(region: string | null | undefined): string | null {
  if (typeof region !== 'string') return null;
  const country = (region.trim().toUpperCase().split('-')[0] ?? '').trim();
  if (!/^[A-Z]{2}$/.test(country) || UNKNOWN_COUNTRY_CODES.has(country)) return null;
  return country === 'UK' ? 'GB' : country;
}

export interface RequiresConsentOptions {
  /**
   * How to treat a missing or unusable region. 'required' (default) fails closed, the
   * same way edge-attribution and conversion-service do. 'not_required' is for callers
   * that make their own unknown-region decision.
   */
  unknown?: 'required' | 'not_required';
}

/** True when ad use of this user's data needs an explicit opt-in (a CMP grant). */
export function requiresConsent(country: string | null | undefined, options: RequiresConsentOptions = {}): boolean {
  const c = consentCountry(country);
  if (c === null) return (options.unknown ?? 'required') === 'required';
  return CONSENT_REQUIRED_REGIONS.has(c);
}

/** The signals whose denial withholds a conversion from ad platforms. */
export const AD_DENIAL_SIGNALS = ['ad_storage', 'ad_user_data'] as const satisfies readonly ConsentSignal[];

/**
 * True when any of `signals` is explicitly "denied", whatever the source. A regional
 * default of "denied", or a denial recorded without a CMP, is still a denial.
 */
export function isExplicitlyDenied(consent: Consent, signals: readonly ConsentSignal[] = AD_DENIAL_SIGNALS): boolean {
  return signals.some((s) => consent[s] === 'denied');
}

/** Global Privacy Control observed, or a US-state "do not sell or share" opt-out recorded. */
export function adSharingOptedOut(consent: Pick<Consent, 'gpc' | 'opt_out_sale_sharing'>): boolean {
  return consent.gpc === true || consent.opt_out_sale_sharing === true;
}

/**
 * True when the user's data must not be shared with ad platforms at all: an explicit
 * denial from any source, or a GPC or sale/sharing opt-out. This holds in every region
 * and overrides a CMP grant. Callers may still use platform limited-data-use modes for an
 * explicit denial if their policy allows it, but never for GPC or an opt-out.
 */
export function blocksAdSharing(consent: Consent): boolean {
  return adSharingOptedOut(consent) || isExplicitlyDenied(consent);
}
