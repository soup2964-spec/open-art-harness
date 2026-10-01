/**
 * Service-level types. Canonical shapes (ConversionLedgerEvent, Consent, ClickIds,
 * PlatformEventMappingRow, PredictedProfit...) come from @openart-signal/contracts.
 */

import type { CanonicalEventName, Consent, ConversionLedgerEvent, Platform } from '@openart-signal/contracts';

/**
 * Raw personal data found in a source record (a HubSpot email, a Stripe invoice
 * customer_email) or returned by the user store. It lives only in memory during
 * ingestion and is hashed per platform before anything is persisted or sent.
 */
export interface RawIdentity {
  email?: string | null;
  phone?: string | null;
}

/**
 * Browser/request context captured by OpenArt's backend (signup request, checkout form
 * POST) or the user store. Never hashed (platforms want these raw) and never logged.
 */
export interface RequestContext {
  client_ip_address?: string | null;
  client_user_agent?: string | null;
  /** Page URL without a query string (the success URL carries the uid). */
  event_source_url?: string | null;
  /** Meta `_fbc` cookie value, when the backend read one. */
  fbc?: string | null;
  /** Meta `_fbp` cookie value. */
  fbp?: string | null;
  /** TikTok `_ttp` cookie value. */
  ttp?: string | null;
  /** Reddit `_rdt_uuid` cookie value. */
  rdt_uuid?: string | null;
}

/** Per-platform SHA-256 hex digests. Email normalisation differs per platform (contracts normalization.ts). */
export interface HashedIdentity {
  email: Partial<Record<Platform, string>>;
  phone: Partial<Record<Platform, string>>;
  /** SHA-256 of the LOWER-CASED uid, exactly as the Meta pixel sends external_id (contracts metaExternalId). */
  external_id: string | null;
}

/** One source record normalised to a canonical row plus the transient data needed to send it. */
export interface NormalizedEvent {
  row: ConversionLedgerEvent;
  identity: RawIdentity;
  /** Identity hashed earlier (e.g. at HubSpot form time) when no raw value is available now. */
  hashedIdentity?: HashedIdentity;
  context: RequestContext;
  /** True when the source carried an explicit consent block (e.g. the backend passed the CMP state). */
  consentFromSource: boolean;
}

/**
 * How a sent value was obtained. Recorded on every send (outbox meta.value_basis) and, where the
 * platform accepts custom parameters (Meta custom_data), tagged on the payload itself.
 */
export type ValueBasis =
  /** PurchaseValueScore.predicted_profit_90d: E[gross_profit_90d | purchase], scored at purchase time. */
  | 'predicted_profit_90d'
  /** An acquisition purchase whose purchase-time score did not exist within VALUE_SCORE_SLA_MS: its cash. */
  | 'cash_fallback'
  /** A later purchase (renewal, upgrade, add-on): cash by design; predicted value belongs on the acquisition only. */
  | 'cash';

/** The value a platform receives for a conversion (major units). */
export interface ResolvedValue {
  /** What the platform receives: the estimate or cash, or the floor when the estimate is at or below it. */
  value: number;
  currency: string;
  basis: ValueBasis;
  /** True when the floor was sent in place of a lower (possibly negative) estimate. Never silent. */
  floored: boolean;
  /** The estimate or cash before flooring, in `currency`. */
  raw_value: number;
  model_version: string | null;
  /** Meta custom_data.predicted_ltv (the sent predicted value); null unless basis is predicted_profit_90d. */
  predicted_ltv: number | null;
  /** False when no FX rate existed and the value stayed in its original currency (never mixed). */
  in_reporting_currency: boolean;
  /**
   * An acquisition purchase still inside VALUE_SCORE_SLA_MS without a purchase-time score: the value is
   * provisional cash and every send is held (hold_gate value_score) until the decision is made.
   */
  pending: boolean;
}

/** A canonical row ready for dispatch: enriched, validated, identity hashed, value resolved. */
export interface EnrichedEvent {
  row: ConversionLedgerEvent;
  identity: HashedIdentity;
  context: RequestContext;
  /** fbc from the request, else built server-side from the stored fbclid (contracts buildMetaFbc). */
  fbc: string | null;
  value: ResolvedValue | null;
}

export type OutboxAction = 'SEND' | 'ADJUST';

export type OutboxStatus =
  /** Waiting to be sent (next_attempt_at_ms says when). */
  | 'pending'
  /** Waiting on a gate (web fix live, dedup verification, multi-source confirmation). */
  | 'held'
  /** Claimed by a drain; lease_until_ms bounds it. */
  | 'in_flight'
  /** Accepted by the platform (live mode). */
  | 'sent'
  /** 2xx from a validation-only or test-routed request (Google validateOnly, test_event_code, test_id): not recorded by the platform. Terminal. */
  | 'validated'
  /** Written to the dry-run out dir; nothing left the process. */
  | 'dry_run'
  /** Deliberately not sent (policy, consent, window, mapping). Terminal. */
  | 'skipped'
  /** Failed permanently or ran out of retries/window. Terminal. */
  | 'dead';

export type HoldGate = 'web_fix' | 'google_multi_source' | 'reddit_dedup' | 'value_score';

export interface OutboxHistoryEntry {
  at_ms: number;
  status: OutboxStatus;
  reason: string | null;
}

/**
 * One (platform, event_id) delivery. The key mirrors the credit ledger's idempotencyKey
 * pattern `<businessType>:<ACTION>:<businessId>` as `<platform>:<ACTION>:<event_id>`.
 */
export interface OutboxRecord {
  key: string;
  platform: Platform;
  action: OutboxAction;
  event_id: string;
  canonical_event: CanonicalEventName;
  /** The OpenArt uid (erasure queries and the send-time consent re-check). */
  user_id: string | null;
  /** Consent as recorded on the canonical row; re-checked against the user's current state at send time. */
  consent: Consent | null;
  occurred_at_ms: number;
  status: OutboxStatus;
  reason: string | null;
  hold_gate: HoldGate | null;
  attempts: number;
  next_attempt_at_ms: number;
  /** Earliest send time (Google adjustments: 24 h after the original conversion). */
  not_before_ms: number | null;
  /** Latest send time (platform max age / dedup window). */
  deadline_ms: number | null;
  lease_until_ms: number | null;
  /** Records with the same batch key can share one request. */
  batch_key: string;
  /** The platform's per-event object, exactly as it goes into the request body. Blanked (null) once terminal. */
  item: unknown;
  /** Extra data a gate or adjustment needs at send time. */
  meta: Record<string, string | number | boolean | null>;
  created_at_ms: number;
  updated_at_ms: number;
  last_error: string | null;
  history: OutboxHistoryEntry[];
  /** RFC 3339 time after which the document may be deleted (Firestore TTL policy). */
  expire_at: string;
}

export function outboxKey(platform: Platform, action: OutboxAction, eventId: string): string {
  return `${platform}:${action}:${eventId}`;
}
