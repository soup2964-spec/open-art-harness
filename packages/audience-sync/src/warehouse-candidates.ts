/**
 * Adapter for packages/warehouse `fct_audience_candidates` AS BUILT TODAY: one row per
 * (user, warehouse list) with flags, flattened consent columns and the Meta external id, but
 * no contact columns. audience-sync's native input is one row per scored user with contact data
 * (types.ts), because it builds its own lists (two seeds, four suppression lists) and hashes
 * email/phone per destination. This adapter:
 *   - collapses the list rows to one user-grain candidate (rejecting rows that disagree),
 *   - joins email/phone from a restricted contact table (user_id -> email, phone_e164),
 *   - rebuilds the contracts Consent block from the flattened consent columns,
 *   - applies the warehouse's own `upload_allowed` gate on top of the consent gate,
 *   - cross-checks `external_id_sha256` against audience-sync's EXTERN_ID hashing.
 * Known gap (reported as a warning): the mart only contains users who are on at least one of the
 * warehouse's lists, so users with positive predicted profit outside its seed share are absent.
 */

import { CONSENT_SOURCES, CONSENT_STATES, hashExternalIdFor } from '@openart-signal/contracts';
import { z } from 'zod';
import { parseAudienceCandidates, type AudienceCandidateRow } from './types.js';

export const WarehouseAudienceRowSchema = z.looseObject({
  user_id: z.string().min(1),
  list_name: z.string().min(1),
  predicted_profit: z.number().nullable(),
  is_active_subscriber: z.boolean(),
  has_refund: z.boolean(),
  has_chargeback: z.boolean(),
  has_fraud_dispute: z.boolean(),
  consent_region: z.string().regex(/^[A-Z]{2}$/).nullable(),
  consent_source: z.enum(CONSENT_SOURCES),
  ad_user_data: z.enum(CONSENT_STATES),
  ad_personalization: z.enum(CONSENT_STATES),
  upload_allowed: z.boolean(),
  external_id_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  computed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/),
  /** Global Privacy Control / US-state sale-sharing opt-out (contracts Consent); NULL or absent = not recorded. */
  gpc: z.boolean().nullable().optional(),
  opt_out_sale_sharing: z.boolean().nullable().optional(),
});

export type WarehouseAudienceRow = z.infer<typeof WarehouseAudienceRowSchema>;

export interface ContactRow {
  user_id: string;
  email: string | null;
  phone_e164: string | null;
}

export interface WarehouseAdapterResult {
  candidates: AudienceCandidateRow[];
  warnings: string[];
  excludedByUploadAllowed: number;
  usersWithoutContact: number;
}

/** DuckDB/BigQuery TIMESTAMP text ("2026-09-28 00:00:00", UTC) -> RFC 3339 with Z. */
function toUtc(ts: string): string {
  const iso = ts.replace(' ', 'T').replace(/\.\d+/, '');
  return iso.endsWith('Z') ? iso : `${iso}Z`;
}

const USER_FIELDS = [
  'predicted_profit',
  'is_active_subscriber',
  'has_refund',
  'has_chargeback',
  'has_fraud_dispute',
  'consent_region',
  'consent_source',
  'ad_user_data',
  'ad_personalization',
  'upload_allowed',
  'external_id_sha256',
  'computed_at',
  'gpc',
  'opt_out_sale_sharing',
] as const;

export function candidatesFromWarehouseRows(input: readonly unknown[], contacts: Iterable<ContactRow>, o: { respectUploadAllowed?: boolean } = {}): WarehouseAdapterResult {
  const respect = o.respectUploadAllowed ?? true;
  const byUser = new Map<string, WarehouseAudienceRow>();
  input.forEach((raw, i) => {
    const parsed = WarehouseAudienceRowSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`fct_audience_candidates row ${i}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    const r = parsed.data;
    const prev = byUser.get(r.user_id);
    if (prev) {
      for (const f of USER_FIELDS) {
        if ((prev[f] ?? null) !== (r[f] ?? null)) throw new Error(`fct_audience_candidates rows for ${r.user_id} disagree on ${f} (${String(prev[f])} vs ${String(r[f])})`);
      }
      return;
    }
    if (r.external_id_sha256 !== null && r.external_id_sha256 !== hashExternalIdFor('meta', r.user_id)) {
      throw new Error(`fct_audience_candidates external_id_sha256 for ${r.user_id} is not SHA-256(lower(uid)); the warehouse and audience-sync would upload different EXTERN_IDs`);
    }
    byUser.set(r.user_id, r);
  });

  const contactOf = new Map<string, ContactRow>();
  for (const c of contacts) contactOf.set(c.user_id, c);
  let excludedByUploadAllowed = 0;
  let usersWithoutContact = 0;
  const rows: AudienceCandidateRow[] = [];
  for (const r of byUser.values()) {
    if (respect && !r.upload_allowed) {
      excludedByUploadAllowed += 1;
      continue;
    }
    const contact = contactOf.get(r.user_id);
    if (!contact || (!contact.email && !contact.phone_e164)) usersWithoutContact += 1;
    rows.push({
      user_id: r.user_id,
      email: contact?.email ?? null,
      phone_e164: contact?.phone_e164 ?? null,
      country: r.consent_region,
      computed_at: toUtc(r.computed_at),
      predicted_profit: r.predicted_profit,
      model_version: 'warehouse:fct_audience_candidates',
      is_active_subscriber: r.is_active_subscriber,
      has_refund: r.has_refund,
      has_chargeback: r.has_chargeback,
      is_fraud: r.has_fraud_dispute,
      consent: {
        ad_storage: 'unknown',
        ad_user_data: r.ad_user_data,
        ad_personalization: r.ad_personalization,
        analytics_storage: 'unknown',
        region: r.consent_region,
        source: r.consent_source,
        ...(typeof r.gpc === 'boolean' ? { gpc: r.gpc } : {}),
        ...(typeof r.opt_out_sale_sharing === 'boolean' ? { opt_out_sale_sharing: r.opt_out_sale_sharing } : {}),
      },
    });
  }
  const warnings = [
    `fct_audience_candidates holds only users on at least one warehouse list (${byUser.size} users here); users with positive predicted profit outside its seed share are absent, so oa_seed_positive_predicted_profit only covers these users. Exposing one row per scored user would close the gap.`,
  ];
  if (usersWithoutContact > 0) warnings.push(`${usersWithoutContact} users have no email or phone in the contact table: Google and TikTok cannot match them (Meta still can through EXTERN_ID).`);
  if (excludedByUploadAllowed > 0) warnings.push(`${excludedByUploadAllowed} users dropped because the warehouse marked them upload_allowed = false.`);
  return { candidates: parseAudienceCandidates(rows), warnings, excludedByUploadAllowed, usersWithoutContact };
}
