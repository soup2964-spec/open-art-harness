/**
 * Per-platform identifier normalisation before SHA-256.
 *
 * Email normalisation is NOT portable across platforms (research/08 §6.3), so
 * every hashed identifier is computed per destination:
 *   google_ads  lowercase, strip all whitespace; gmail.com/googlemail.com: drop dots and +suffix (Data Manager API)
 *   meta        trim, lowercase
 *   tiktok      trim, lowercase
 *   reddit      lowercase; drop dots and +suffix in the local part for every domain
 *   linkedin    lowercase, no whitespace
 *   x           trim (lowercase advisable)
 *   microsoft   trim, drop dots and +alias in the local part, lowercase
 * Phones must already carry a country code (E.164). Meta wants digits only.
 */

import type { Platform } from './constants.js';
import { sha256Hex } from './sha256.js';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function splitEmail(email: string): [string, string] {
  const at = email.lastIndexOf('@');
  if (at <= 0 || !EMAIL_SHAPE.test(email)) throw new Error('not an email address');
  return [email.slice(0, at), email.slice(at + 1)];
}

function stripDotsAndPlus(local: string): string {
  const withoutPlus = local.split('+')[0] ?? '';
  return withoutPlus.replace(/\./g, '');
}

/** Normalise an email the way `platform` expects before hashing. Throws on non-emails. */
export function normalizeEmailFor(platform: Platform, email: string): string {
  if (typeof email !== 'string') throw new Error('not an email address');
  const lowered = email.trim().toLowerCase();
  const compact = lowered.replace(/\s+/g, '');
  const [local, domain] = splitEmail(platform === 'google_ads' || platform === 'linkedin' ? compact : lowered);
  let normalizedLocal = local;
  if (platform === 'google_ads' && GOOGLE_CONSUMER_DOMAINS.has(domain)) normalizedLocal = stripDotsAndPlus(local);
  if (platform === 'reddit' || platform === 'microsoft') normalizedLocal = stripDotsAndPlus(local);
  if (normalizedLocal.length === 0) throw new Error('not an email address');
  return `${normalizedLocal}@${domain}`;
}

/** SHA-256 hex of the platform-normalised email. */
export function hashEmailFor(platform: Platform, email: string): string {
  return sha256Hex(normalizeEmailFor(platform, email));
}

/** Normalise a phone number already carrying a country code. Meta: digits only; others: `+` + digits. */
export function normalizePhoneFor(platform: Platform, phone: string): string {
  const cleaned = String(phone).trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) {
    throw new Error('phone must be E.164 (leading + and country code, 7-15 digits)');
  }
  return platform === 'meta' ? cleaned.slice(1) : cleaned;
}

/** SHA-256 hex of the platform-normalised phone number. */
export function hashPhoneFor(platform: Platform, phone: string): string {
  return sha256Hex(normalizePhoneFor(platform, phone));
}

/**
 * Meta `external_id` exactly as OpenArt's pixel sends it: SHA-256 of the
 * LOWER-CASED uid (research/10 §7). Hashing the raw, case-sensitive uid would
 * not match the browser event.
 */
export function metaExternalId(userId: string): string {
  if (!userId) throw new Error('user_id required');
  return sha256Hex(userId.toLowerCase());
}

/**
 * Hashed external id for any platform. Uses Meta's observed rule (lower-cased uid)
 * everywhere so one user maps to one external id across destinations.
 */
export function hashExternalIdFor(_platform: Platform, userId: string): string {
  return metaExternalId(userId);
}
