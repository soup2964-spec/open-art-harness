/**
 * Small, runtime-agnostic helpers for building canonical rows consistently.
 */

import { CLICK_ID_KEYS_EXTENDED, UTM_KEYS } from './constants.js';
import type { ClickIdStoreRecordExtended, ClickIds, Consent, ConversionLedgerEvent, Utm } from './types.js';

/** Column order of fct_conversion_ledger (= conversion-ledger-event.schema.json `required`). */
export const CONVERSION_LEDGER_COLUMNS = [
  'schema_version',
  'event_id',
  'event_name',
  'occurred_at',
  'source_system',
  'source_event_id',
  'user_id',
  'device_id',
  'order_id',
  'adjusts_event_id',
  'adjusts_order_id',
  'cash_value_minor',
  'currency',
  'invoice_id',
  'subscription_id',
  'checkout_session_id',
  'charge_id',
  'plan_tier',
  'plan_tier_code',
  'billing_interval',
  'previous_plan_tier',
  'credit_pack_quantity',
  'is_first_purchase',
  'is_business',
  'generation',
  'lead',
  'click_ids',
  'utm',
  'ga_client_id',
  'ga_session_id',
  'tolt_referral',
  'consent',
  'experiment_arms',
] as const satisfies ReadonlyArray<keyof ConversionLedgerEvent>;

/** Return the row with keys in CONVERSION_LEDGER_COLUMNS order (stable JSON / DDL order). */
export function orderLedgerRow(row: ConversionLedgerEvent): ConversionLedgerEvent {
  const out: Record<string, unknown> = {};
  for (const col of CONVERSION_LEDGER_COLUMNS) out[col] = row[col];
  return out as unknown as ConversionLedgerEvent;
}

/** Consent block for traffic with no CMP signal (OpenArt today: gcd=13l3l3l3l1l1). */
export function unknownConsent(region: string | null = null): Consent {
  return {
    ad_storage: 'unknown',
    ad_user_data: 'unknown',
    ad_personalization: 'unknown',
    analytics_storage: 'unknown',
    region,
    source: 'none',
  };
}

/** Attribution fields of a ledger row with nothing captured. */
export function emptyAttribution(): Pick<
  ConversionLedgerEvent,
  'click_ids' | 'utm' | 'ga_client_id' | 'ga_session_id' | 'tolt_referral'
> {
  return { click_ids: {}, utm: {}, ga_client_id: null, ga_session_id: null, tolt_referral: null };
}

/** ms epoch -> RFC 3339 UTC (second precision is kept to the millisecond). */
export function epochMsToUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/** Convert a (current or extended) /api/user/ad-click-ids body to ledger click_ids. */
export function clickIdsFromStoreRecord(record: ClickIdStoreRecordExtended): ClickIds {
  const out: ClickIds = {};
  const rec = record as Record<string, unknown>;
  for (const key of CLICK_ID_KEYS_EXTENDED) {
    const value = rec[key];
    if (typeof value !== 'string') continue;
    const ts = rec[`${key}_created_at`];
    out[key] = { value, created_at: typeof ts === 'number' ? epochMsToUtc(ts) : null };
  }
  return out;
}

/** Extract ledger utm from an extended store record. */
export function utmFromStoreRecord(record: ClickIdStoreRecordExtended): Utm {
  const out: Utm = {};
  const rec = record as Record<string, unknown>;
  for (const key of UTM_KEYS) {
    const value = rec[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Meta `fbc` built server-side from a stored fbclid: `fb.1.<creationTimeMs>.<fbclid>`.
 * subdomainIndex 1 and the first-seen time are Meta's documented rule for servers
 * that do not read an _fbc cookie (research/12 C6). Never hash or modify the fbclid.
 */
export function buildMetaFbc(fbclid: string, firstSeenMs: number): string {
  if (!fbclid) throw new Error('fbclid required');
  if (!Number.isInteger(firstSeenMs) || firstSeenMs < 1_000_000_000_000) {
    throw new Error('firstSeenMs must be a millisecond epoch');
  }
  return `fb.1.${firstSeenMs}.${fbclid}`;
}
