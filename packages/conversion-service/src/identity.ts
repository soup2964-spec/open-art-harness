/**
 * Hash raw identifiers once per destination. Normalisation is NOT portable across
 * platforms (contracts normalization.ts, research/08 §6.3), so each platform gets its
 * own digest. Raw values never leave this function.
 */

import { PLATFORMS, hashEmailFor, hashPhoneFor, metaExternalId } from '@openart-signal/contracts';
import type { HashedIdentity, RawIdentity } from './types.js';

export function hashIdentity(raw: RawIdentity, userId: string | null): HashedIdentity {
  const email: HashedIdentity['email'] = {};
  const phone: HashedIdentity['phone'] = {};
  for (const platform of PLATFORMS) {
    if (raw.email) {
      try {
        email[platform] = hashEmailFor(platform, raw.email);
      } catch {
        // Not an email address: send nothing rather than a hash that can never match.
      }
    }
    if (raw.phone) {
      try {
        phone[platform] = hashPhoneFor(platform, raw.phone);
      } catch {
        // Not E.164: same rule.
      }
    }
  }
  return { email, phone, external_id: userId ? metaExternalId(userId) : null };
}

export const EMPTY_IDENTITY: HashedIdentity = Object.freeze({ email: {}, phone: {}, external_id: null }) as HashedIdentity;
