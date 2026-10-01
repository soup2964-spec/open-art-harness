/**
 * Per-destination hashed identifiers, always through the contracts' normalisation
 * (normalization.ts), because email normalisation is not portable across platforms:
 *   google_ads  lowercase, strip all whitespace; gmail/googlemail drop dots and +suffix; phone E.164 "+..."
 *   meta        trim + lowercase; phone digits only (no "+"); EXTERN_ID = SHA-256(lower-cased uid),
 *               exactly the external_id OpenArt's pixel sends, so list members match pixel events
 *   tiktok      trim + lowercase; phone E.164 "+..."
 * Output is lowercase 64-char hex. Invalid emails/phones are skipped, never "repaired".
 */

import { hashEmailFor, hashExternalIdFor, hashPhoneFor, type AudienceIdentifiers } from '@openart-signal/contracts';
import type { AudienceCandidateRow, AudiencePlatform } from './types.js';

export type IdentifierKey = keyof AudienceIdentifiers;

function attempt(f: () => string): string | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

export function identifiersFor(
  platform: AudiencePlatform,
  c: Pick<AudienceCandidateRow, 'user_id' | 'email' | 'phone_e164'>,
  keys: readonly IdentifierKey[] = ['email_sha256', 'phone_sha256', 'external_id_sha256'],
): AudienceIdentifiers {
  const out: AudienceIdentifiers = {};
  if (keys.includes('email_sha256') && c.email) {
    const email = c.email;
    const h = attempt(() => hashEmailFor(platform, email));
    if (h) out.email_sha256 = h;
  }
  if (keys.includes('phone_sha256') && c.phone_e164) {
    const phone = c.phone_e164;
    const h = attempt(() => hashPhoneFor(platform, phone));
    if (h) out.phone_sha256 = h;
  }
  // Only Meta matches on an advertiser external id in customer-list audiences (EXTERN_ID).
  if (keys.includes('external_id_sha256') && platform === 'meta' && c.user_id) out.external_id_sha256 = hashExternalIdFor('meta', c.user_id);
  return out;
}

/** Stable key of a member's identifiers: the unit a platform list is diffed on. */
export function memberKey(ids: AudienceIdentifiers): string {
  return JSON.stringify(
    Object.entries(ids)
      .filter(([, v]) => typeof v === 'string')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
