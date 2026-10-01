/**
 * TypeScript types for the canonical openart-signal contracts.
 * Each type mirrors a JSON Schema in src/schemas/ and a zod validator in
 * src/validators.ts (validators.ts is typed against these interfaces, so tsc
 * fails if they drift). Snake_case field names = warehouse columns.
 */

import type {
  BillingInterval,
  CanonicalEventName,
  ClickIdKey,
  ConsentSource,
  ConsentState,
  Platform,
  PlanTier,
  PurchaseValueEstimand,
  SourceSystem,
  UtmKey,
} from './constants.js';

/** RFC 3339 UTC timestamp ending in Z. */
export type UtcTimestamp = string;

export interface ClickIdEntry {
  value: string;
  /** When the id was first seen (from the store's ms-epoch ts), or null if unknown. */
  created_at: UtcTimestamp | null;
}

export type ClickIds = Partial<Record<ClickIdKey, ClickIdEntry>>;
export type Utm = Partial<Record<UtmKey, string | null>>;

export interface Consent {
  ad_storage: ConsentState;
  ad_user_data: ConsentState;
  ad_personalization: ConsentState;
  analytics_storage: ConsentState;
  /** ISO 3166-1 alpha-2, optionally with subdivision (US-CA). */
  region: string | null;
  source: ConsentSource;
  /**
   * Global Privacy Control (Sec-GPC: 1) observed for this user. true blocks ad sharing in
   * every region, a CMP grant included. Absent = not observed or not recorded.
   */
  gpc?: boolean;
  /**
   * US-state "do not sell or share my personal information" opt-out (CCPA/CPRA and
   * similar state laws). true blocks ad sharing in every region. Absent = none recorded.
   */
  opt_out_sale_sharing?: boolean;
}

export interface GenerationRef {
  /** Ledger reference.businessType, "<model-id>:<mode>". */
  business_type: string;
  model_id: string;
  credits: number;
}

export interface LeadContext {
  hubspot_portal_id: number;
  form_id: string | null;
  contact_id: string | null;
  lifecycle_stage: string | null;
  previous_lifecycle_stage: string | null;
  lead_source: string | null;
  lead_source_detail: string | null;
  company_size: string | null;
}

/** One canonical conversion row (fct_conversion_ledger). See conversion-ledger-event.schema.json. */
export interface ConversionLedgerEvent {
  schema_version: 1;
  event_id: string;
  event_name: CanonicalEventName;
  occurred_at: UtcTimestamp;
  source_system: SourceSystem;
  source_event_id: string;
  user_id: string | null;
  device_id: string | null;
  order_id: string | null;
  adjusts_event_id: string | null;
  adjusts_order_id: string | null;
  /** Signed Stripe minor units: purchases >= 0, refunds/chargebacks < 0, null for non-cash events. */
  cash_value_minor: number | null;
  currency: string | null;
  invoice_id: string | null;
  subscription_id: string | null;
  checkout_session_id: string | null;
  charge_id: string | null;
  plan_tier: PlanTier | null;
  plan_tier_code: number | null;
  billing_interval: BillingInterval | null;
  previous_plan_tier: PlanTier | null;
  credit_pack_quantity: number | null;
  is_first_purchase: boolean | null;
  is_business: boolean | null;
  generation: GenerationRef | null;
  lead: LeadContext | null;
  click_ids: ClickIds;
  utm: Utm;
  ga_client_id: string | null;
  ga_session_id: string | null;
  tolt_referral: string | null;
  consent: Consent;
  /** flag_key -> arm */
  experiment_arms: Record<string, string>;
}

/** Body of POST /api/user/ad-click-ids as the Suite sends it today. *_created_at = ms epoch. */
export interface ClickIdStoreRecord {
  gclid?: string;
  gclid_created_at?: number;
  fbclid?: string;
  fbclid_created_at?: number;
  msclkid?: string;
  msclkid_created_at?: number;
  ttclid?: string;
  ttclid_created_at?: number;
}

/** Backward-compatible superset of ClickIdStoreRecord. */
export interface ClickIdStoreRecordExtended extends ClickIdStoreRecord {
  gbraid?: string;
  gbraid_created_at?: number;
  wbraid?: string;
  wbraid_created_at?: number;
  rdt_cid?: string;
  rdt_cid_created_at?: number;
  twclid?: string;
  twclid_created_at?: number;
  li_fat_id?: string;
  li_fat_id_created_at?: number;
  oppref?: string;
  oppref_created_at?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  utm_id?: string;
  landing_url?: string;
  referrer?: string;
  context_captured_at?: number;
}

/** Recommended feature keys for PredictedProfit.features (all optional; extra scalar keys allowed). */
export interface FeatureSnapshot {
  plan_tier?: string | null;
  billing_interval?: string | null;
  arm_create_image?: string | null;
  arm_create_video?: string | null;
  generations_24h?: number;
  video_generations_24h?: number;
  credits_consumed_24h?: number;
  generation_cost_24h_usd?: number;
  paid_within_24h?: boolean;
  first_purchase_value_usd?: number | null;
  acquisition_channel?: string | null;
  [key: string]: number | string | boolean | null | undefined;
}

/**
 * One row of fct_predicted_profit_24h (USD, major units), scored at signup + 24h.
 *
 * Estimand: PREDICTED_PROFIT_ESTIMAND, "unconditional E[90d profit per exposed user]".
 * Every exposed user gets a row, payers and non-payers alike, so arm means are the right
 * readout for experiments and the bandit. It is NOT an ad conversion value: a purchase
 * event is already conditioned on the purchase, so sending this number with a purchase
 * understates buyers. Ad values come from PurchaseValueScore.
 */
export interface PredictedProfit {
  user_id: string;
  computed_at: UtcTimestamp;
  horizon_days: 90;
  feature_window_hours: 24;
  currency: 'USD';
  predicted_revenue: number;
  predicted_generation_cost: number;
  predicted_fees: number;
  /** Expected refund + chargeback loss in USD. */
  predicted_refund_risk: number;
  refund_probability: number | null;
  predicted_profit: number;
  model_version: string;
  features: Record<string, number | string | boolean | null>;
}

/**
 * Point-in-time features behind a PurchaseValueScore. `as_of` is the feature cut-off and
 * must be <= the purchase's occurred_at, and so must every `*_at` timestamp feature. No
 * feature may use information from after the purchase.
 */
export interface PurchaseFeatureSnapshot {
  as_of: UtcTimestamp;
  [key: string]: number | string | boolean | null;
}

/**
 * One row of fct_purchase_value_score: the purchase-time conditional value of ONE purchase.
 *
 * Estimand: PURCHASE_VALUE_ESTIMAND, "E[gross_profit_90d | purchase]". It is the expected
 * gross profit of this purchase's user over the 90 days from occurred_at, this purchase
 * included, given that the purchase happened and given only what was known at
 * occurred_at. conversion-service sends this value to ad platforms with the purchase. The
 * browser pixel should send it too, so the pixel's copy and the server's copy of the same
 * event carry the same number.
 *
 * All money fields are in `currency`, major units. validators.ts enforces, within 0.01:
 * predicted_profit_90d = predicted_revenue_90d - predicted_generation_cost_90d -
 * predicted_fees_90d - predicted_refund_risk, and interval_low <= predicted_profit_90d <=
 * interval_high. The interval is the model's uncertainty about the estimand (the
 * conditional mean). It is not the spread of individual outcomes.
 */
export interface PurchaseValueScore {
  /** purchase_<invoiceId>, or purchase_<checkoutSessionId> for an invoice-less one-time pack. */
  event_id: string;
  invoice_id: string | null;
  user_id: string;
  /** The purchase time (ledger occurred_at). */
  occurred_at: UtcTimestamp;
  /** When the score was computed; >= occurred_at. */
  scored_at: UtcTimestamp;
  estimand: PurchaseValueEstimand;
  horizon_days: 90;
  predicted_revenue_90d: number;
  predicted_generation_cost_90d: number;
  predicted_fees_90d: number;
  /** Expected refund + chargeback loss (money, not a probability). */
  predicted_refund_risk: number;
  /** May be negative: some purchases lose money. */
  predicted_profit_90d: number;
  interval_low: number;
  interval_high: number;
  /** This purchase's cash (amount paid), converted to `currency`. */
  cash_value: number;
  currency: string;
  model_version: string;
  /** The scoring run that produced this row. */
  run_id: string;
  /** Where the fitted parameters live (URI or table@version), for reproducibility. */
  fitted_params_ref: string;
  features_snapshot: PurchaseFeatureSnapshot;
}

export type ExposureSource = 'amplitude_exposure_event' | 'amplitude_user_property' | 'launchdarkly';

export interface ExperimentExposure {
  user_id: string;
  flag_key: string;
  arm: string;
  first_exposed_at: UtcTimestamp;
  source?: ExposureSource;
  device_id?: string | null;
}

export interface AudienceIdentifiers {
  email_sha256?: string;
  phone_sha256?: string;
  external_id_sha256?: string;
}

export interface AudienceMember {
  platform: Platform;
  list_name: string;
  action: 'add' | 'remove';
  reason: string;
  identifiers: AudienceIdentifiers;
  value: number | null;
  user_id: string | null;
  computed_at: UtcTimestamp;
}

export interface BrowserTwin {
  /** Event/trigger the browser sends today. */
  event: string;
  /** Dedup/order id the browser sends, as a template (null = none). */
  id_template: string | null;
  /** True when the browser hashes the id before sending (Reddit conversionId). */
  id_hashed: boolean;
  /** What the browser puts in value today. */
  value_sent: string;
  /** Which purchases/signups trigger it. */
  scope: string;
  evidence: string;
}

export interface PlatformEventMappingRow {
  canonical_event: CanonicalEventName;
  platform: Platform;
  send: boolean;
  delivery: 'server_event' | 'server_adjustment' | 'none';
  status: 'twin_observed' | 'server_only' | 'not_sent';
  platform_event_name: string | null;
  destination: string | null;
  action_source: string | null;
  dedup_key_field: string | null;
  dedup_key_template: string | null;
  value_field: string | null;
  currency_field: string | null;
  user_data_fields: string[];
  click_id_fields: string[];
  consent_fields: string[];
  event_time_field: string | null;
  max_event_age_days: number | null;
  browser_twin: BrowserTwin | null;
  requires_web_fix: boolean;
  notes: string;
  sources: string[];
}
