/**
 * Offline Stripe webhook signature verification with the stripe library's static
 * `Stripe.webhooks.constructEvent` (no API key, no client, no network). Several endpoint
 * secrets can be configured for rotation; the injected clock drives the tolerance check.
 */

import Stripe from 'stripe';
import type { StripeEvent } from '../ingest/stripe-types.js';

export type StripeVerifyResult = { ok: true; event: StripeEvent } | { ok: false; reason: string };

export function verifyStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secrets: readonly string[],
  toleranceSeconds: number,
  nowMs: number,
): StripeVerifyResult {
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  let lastError = 'no_secret_configured';
  for (const secret of secrets) {
    try {
      const event = Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret, toleranceSeconds, undefined, nowMs);
      return { ok: true, event: event as unknown as StripeEvent };
    } catch (err) {
      lastError = (err as Error).message.split('\n')[0] ?? 'signature_invalid';
    }
  }
  return { ok: false, reason: `invalid_signature: ${lastError}` };
}
