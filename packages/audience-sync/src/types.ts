/**
 * Input interface: rows of the warehouse mart `fct_audience_candidates` (one row per user,
 * latest state), built by packages/warehouse from fct_predicted_profit_24h (contracts
 * PredictedProfit), the Stripe-derived conversion ledger and the per-user consent record.
 *
 *   user_id               OpenArt uid (lineage only: never sent; Meta gets SHA-256(lower(uid)))
 *   email, phone_e164     PLAINTEXT contact data from the restricted dataset; hashed here,
 *                         per destination, because normalisation differs by platform
 *   country               ISO 3166-1 alpha-2 of the account (signup / billing country)
 *   computed_at           when the row was computed (RFC 3339, UTC)
 *   predicted_profit      PredictedProfit.predicted_profit in USD (null = not scored yet)
 *   model_version         PredictedProfit.model_version
 *   is_active_subscriber  a paid subscription is active now
 *   has_refund            any refund on any charge (Stripe charge.refunded)
 *   has_chargeback        any dispute (Stripe charge.dispute.created)
 *   is_fraud              risk flag (fraudulent disputes, card-testing rules, farmed promo accounts)
 *   consent               contracts Consent block: Consent Mode v2 signals + region + source
 */

import { ConsentSchema, type Consent } from '@openart-signal/contracts';
import { z } from 'zod';

export interface AudienceCandidateRow {
  user_id: string;
  email: string | null;
  phone_e164: string | null;
  country: string | null;
  computed_at: string;
  predicted_profit: number | null;
  model_version: string;
  is_active_subscriber: boolean;
  has_refund: boolean;
  has_chargeback: boolean;
  is_fraud: boolean;
  consent: Consent;
}

export const AUDIENCE_CANDIDATE_COLUMNS = [
  'user_id',
  'email',
  'phone_e164',
  'country',
  'computed_at',
  'predicted_profit',
  'model_version',
  'is_active_subscriber',
  'has_refund',
  'has_chargeback',
  'is_fraud',
  'consent',
] as const satisfies ReadonlyArray<keyof AudienceCandidateRow>;

export const AudienceCandidateRowSchema = z.strictObject({
  user_id: z.string().min(1).max(128).regex(/^\S+$/),
  email: z.string().max(320).nullable(),
  phone_e164: z.string().max(32).nullable(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  computed_at: z.iso.datetime(),
  predicted_profit: z.number().refine(Number.isFinite, 'must be finite').nullable(),
  model_version: z.string().min(1).max(128),
  is_active_subscriber: z.boolean(),
  has_refund: z.boolean(),
  has_chargeback: z.boolean(),
  is_fraud: z.boolean(),
  consent: ConsentSchema,
});

/** Validate untrusted mart rows; throws with the row index, column and reason. */
export function parseAudienceCandidates(input: readonly unknown[]): AudienceCandidateRow[] {
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const parsed = AudienceCandidateRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`fct_audience_candidates row ${i}: ${parsed.error.issues.map((x) => `${x.path.join('.') || '(row)'}: ${x.message}`).join('; ')}`);
    }
    if (seen.has(parsed.data.user_id)) throw new Error(`fct_audience_candidates row ${i}: duplicate user_id ${parsed.data.user_id}`);
    seen.add(parsed.data.user_id);
    return parsed.data as AudienceCandidateRow;
  });
}

export const AUDIENCE_PLATFORMS = ['google_ads', 'meta', 'tiktok'] as const;
export type AudiencePlatform = (typeof AUDIENCE_PLATFORMS)[number];
