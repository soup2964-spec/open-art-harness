/**
 * Consent gate for audience uploads, on the shared contracts policy (consent-regions.ts), so this
 * package, edge-attribution, conversion-service and the warehouse agree on one region list:
 *
 *   1. a Global Privacy Control signal or a US-state "do not sell or share" opt-out blocks the user
 *      everywhere, a CMP grant included;
 *   2. any explicit "denied" signal blocks the user, whatever its source (CMP, regional default);
 *   3. in a consent-required region (contracts CONSENT_REQUIRED_REGIONS: the EEA, the UK,
 *      Switzerland and the EU territories geolocation reports separately, such as RE, GF, GP, MQ,
 *      YT, MF and AX) only EXPLICIT grants count: ad_user_data AND ad_personalization granted by a
 *      CMP. Google requires both for Customer Match lists used in the EEA. The stricter of the
 *      consent region and the account country wins, and an unknown region counts as
 *      consent-required (fail closed);
 *   4. elsewhere the user is eligible by default.
 * Rule 4 relies on opt-outs reaching the warehouse: edge-attribution records Sec-GPC and the
 * consent defaults record the opt-out. A user whose opt-out was never captured cannot be honoured,
 * so the plan report counts default-eligible users with no opt-out signal recorded.
 */

import { adSharingOptedOut, CONSENT_REQUIRED_REGIONS, CONSENT_SIGNALS, consentCountry, isExplicitlyDenied } from '@openart-signal/contracts';
import type { AudienceCandidateRow } from './types.js';

export { CONSENT_REQUIRED_REGIONS };

export type ConsentReason =
  | 'granted'
  | 'default_eligible'
  | 'opted_out_gpc_or_sale_sharing'
  | 'explicit_denial'
  | 'consent_required_needs_cmp_grant'
  | 'unknown_region_needs_cmp_grant';

export type ConsentVerdict =
  | { eligible: true; reason: 'granted' | 'default_eligible' }
  | { eligible: false; reason: Exclude<ConsentReason, 'granted' | 'default_eligible'> };

export function consentEligibility(c: Pick<AudienceCandidateRow, 'consent' | 'country'>): ConsentVerdict {
  if (adSharingOptedOut(c.consent)) return { eligible: false, reason: 'opted_out_gpc_or_sale_sharing' };
  if (isExplicitlyDenied(c.consent, CONSENT_SIGNALS)) return { eligible: false, reason: 'explicit_denial' };
  const regionCountry = consentCountry(c.consent.region);
  const accountCountry = consentCountry(c.country);
  const unknown = regionCountry === null && accountCountry === null;
  const required = unknown || [regionCountry, accountCountry].some((x) => x !== null && CONSENT_REQUIRED_REGIONS.has(x));
  if (!required) return { eligible: true, reason: 'default_eligible' };
  const explicitGrant = c.consent.source === 'cmp' && c.consent.ad_user_data === 'granted' && c.consent.ad_personalization === 'granted';
  if (explicitGrant) return { eligible: true, reason: 'granted' };
  return { eligible: false, reason: unknown ? 'unknown_region_needs_cmp_grant' : 'consent_required_needs_cmp_grant' };
}

/** A default-eligible user for whom neither GPC nor the sale/sharing opt-out was ever recorded. */
export function optOutSignalMissing(c: Pick<AudienceCandidateRow, 'consent'>): boolean {
  return c.consent.gpc === undefined && c.consent.opt_out_sale_sharing === undefined;
}
