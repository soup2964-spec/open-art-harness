/**
 * zod validators for the canonical contracts. They accept exactly what the JSON
 * Schemas in src/schemas/ accept (tests run both on the same good and bad rows)
 * and additionally enforce cross-field invariants JSON Schema cannot express.
 *
 * Drift guard: each export is annotated with its TypeScript type from types.ts, and
 * DRIFT_GUARDS at the bottom checks that every zod object's inferred output has exactly
 * the keys and types of its interface. tsc fails if either side drifts. Never cast a
 * schema through `unknown`: that switches the guard off.
 */

import { z } from 'zod';
import {
  BILLING_INTERVALS,
  CANONICAL_EVENT_NAMES,
  CLICK_ID_KEYS_CURRENT,
  CLICK_ID_KEYS_EXTENDED,
  CONSENT_SOURCES,
  CONSENT_STATES,
  PLAN_TIERS,
  PLATFORMS,
  PURCHASE_EVENT_NAMES,
  PURCHASE_VALUE_ESTIMAND,
  SOURCE_SYSTEMS,
  UTM_KEYS,
  type UtmKey,
} from './constants.js';
import type {
  AudienceMember,
  ClickIdStoreRecord,
  ClickIdStoreRecordExtended,
  Consent,
  ConversionLedgerEvent,
  ExperimentExposure,
  PlatformEventMappingRow,
  PredictedProfit,
  PurchaseFeatureSnapshot,
  PurchaseValueScore,
} from './types.js';

const utc = z.iso.datetime();
const userId = z.string().min(1).max(128).regex(/^\S+$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const flagKey = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const planTier = z.enum(PLAN_TIERS);
const PURCHASE_REF = '(in_[A-Za-z0-9]+|cs_(live|test)_[A-Za-z0-9]+)';

const clickIdEntry = z.strictObject({
  value: z.string().regex(/^[A-Za-z0-9._-]{1,1000}$/),
  created_at: utc.nullable(),
});

const clickIds = z.strictObject(
  Object.fromEntries(CLICK_ID_KEYS_EXTENDED.map((k) => [k, clickIdEntry.optional()])) as Record<
    (typeof CLICK_ID_KEYS_EXTENDED)[number],
    z.ZodOptional<typeof clickIdEntry>
  >,
);

const utm = z.strictObject(
  Object.fromEntries(UTM_KEYS.map((k) => [k, z.string().max(500).nullable().optional()])) as Record<
    (typeof UTM_KEYS)[number],
    z.ZodOptional<z.ZodNullable<z.ZodString>>
  >,
);

const consentState = z.enum(CONSENT_STATES);
const consentObject = z.strictObject({
  ad_storage: consentState,
  ad_user_data: consentState,
  ad_personalization: consentState,
  analytics_storage: consentState,
  region: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/).nullable(),
  source: z.enum(CONSENT_SOURCES),
  /** Global Privacy Control observed. Optional: rows written before it existed stay valid. */
  gpc: z.boolean().optional(),
  /** US-state sale/sharing opt-out recorded. Optional for the same reason. */
  opt_out_sale_sharing: z.boolean().optional(),
});
export const ConsentSchema: z.ZodType<Consent> = consentObject;

const generation = z.strictObject({
  business_type: z.string().regex(/^[A-Za-z0-9.-]+:[A-Za-z0-9-]+$/),
  model_id: z.string().min(1),
  credits: z.int().min(0),
});

const lead = z.strictObject({
  hubspot_portal_id: z.int(),
  form_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  lifecycle_stage: z.string().nullable(),
  previous_lifecycle_stage: z.string().nullable(),
  lead_source: z.string().nullable(),
  lead_source_detail: z.string().nullable(),
  company_size: z.string().nullable(),
});

const ledgerBase = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.string().min(5).max(300).regex(/^\S+$/),
  event_name: z.enum(CANONICAL_EVENT_NAMES),
  occurred_at: utc,
  source_system: z.enum(SOURCE_SYSTEMS),
  source_event_id: z.string().min(1),
  user_id: userId.nullable(),
  device_id: z.string().min(1).nullable(),
  order_id: z.string().regex(new RegExp(`^sub_${PURCHASE_REF}$`)).nullable(),
  adjusts_event_id: z.string().regex(new RegExp(`^purchase_${PURCHASE_REF}$`)).nullable(),
  adjusts_order_id: z.string().regex(new RegExp(`^sub_${PURCHASE_REF}$`)).nullable(),
  cash_value_minor: z.int().nullable(),
  currency: currency.nullable(),
  invoice_id: z.string().regex(/^in_[A-Za-z0-9]+$/).nullable(),
  subscription_id: z.string().regex(/^sub_[A-Za-z0-9]+$/).nullable(),
  checkout_session_id: z.string().regex(/^cs_(live|test)_[A-Za-z0-9]+$/).nullable(),
  charge_id: z.string().regex(/^(ch|py)_[A-Za-z0-9]+$/).nullable(),
  plan_tier: planTier.nullable(),
  plan_tier_code: z.int().nullable(),
  billing_interval: z.enum(BILLING_INTERVALS).nullable(),
  previous_plan_tier: planTier.nullable(),
  credit_pack_quantity: z.int().min(1).nullable(),
  is_first_purchase: z.boolean().nullable(),
  is_business: z.boolean().nullable(),
  generation: generation.nullable(),
  lead: lead.nullable(),
  click_ids: clickIds,
  utm,
  ga_client_id: z.string().nullable(),
  ga_session_id: z.string().nullable(),
  tolt_referral: z.string().nullable(),
  consent: consentObject,
  experiment_arms: z.record(flagKey, z.string().min(1)),
});

const PURCHASES = new Set<string>(PURCHASE_EVENT_NAMES);
const NON_CASH = new Set<string>([
  'signup',
  'activation_first_generation',
  'checkout_started',
  'enterprise_lead',
  'lead_stage_change',
]);

/** Per-event rules (mirrors the schema's allOf) plus cross-field id invariants. */
function ledgerIssues(e: z.infer<typeof ledgerBase>): string[] {
  const issues: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) issues.push(msg);
  };
  const name = e.event_name;
  if (e.cash_value_minor !== null) need(e.currency !== null, 'currency is required when cash_value_minor is set');
  if (NON_CASH.has(name)) {
    need(e.cash_value_minor === null, `${name} carries no cash`);
    need(e.order_id === null, `${name} has no order_id`);
  }
  if (name !== 'refund' && name !== 'chargeback') {
    need(e.adjusts_event_id === null && e.adjusts_order_id === null, 'only refunds/chargebacks adjust a purchase');
  }
  if (name === 'signup') {
    need(e.user_id !== null && e.event_id === `reg_${e.user_id}`, 'signup event_id must be reg_<user_id>');
  }
  if (name === 'activation_first_generation') {
    need(e.user_id !== null && e.event_id === `activation_${e.user_id}`, 'activation event_id must be activation_<user_id>');
    need(e.generation !== null, 'activation needs generation');
  }
  if (name === 'checkout_started') need(e.event_id.startsWith('checkout_'), 'checkout_started id must start checkout_');
  if (PURCHASES.has(name)) {
    need(e.source_system === 'stripe', 'purchases come from Stripe');
    need(e.user_id !== null, 'purchases need user_id');
    need(e.cash_value_minor !== null && e.cash_value_minor >= 0, 'purchase cash_value_minor must be >= 0');
    const ref = e.event_id.startsWith('purchase_') ? e.event_id.slice('purchase_'.length) : null;
    need(new RegExp(`^${PURCHASE_REF}$`).test(ref ?? ''), 'purchase event_id must be purchase_<invoiceId|checkoutSessionId>');
    need(e.order_id === `sub_${ref}`, 'order_id must be sub_<same id as event_id>');
    if (e.invoice_id !== null) need(ref === e.invoice_id, 'event_id must use invoice_id when an invoice exists');
    if (name !== 'purchase_one_time_pack') {
      need(e.invoice_id !== null && e.subscription_id !== null, `${name} needs invoice_id and subscription_id`);
      need(e.plan_tier !== null && e.billing_interval !== null, `${name} needs plan_tier and billing_interval`);
    }
    if (name === 'purchase_add_on') need(e.credit_pack_quantity !== null, 'purchase_add_on needs credit_pack_quantity');
  }
  if (name === 'refund' || name === 'chargeback') {
    need(e.source_system === 'stripe', `${name} comes from Stripe`);
    need(e.cash_value_minor !== null && e.cash_value_minor < 0, `${name} cash_value_minor must be < 0`);
    need(e.charge_id !== null, `${name} needs charge_id`);
    need(e.order_id === null, `${name} has no order_id of its own (use adjusts_order_id)`);
    if (e.adjusts_event_id !== null || e.adjusts_order_id !== null) {
      need(
        e.adjusts_event_id !== null &&
          e.adjusts_order_id !== null &&
          e.adjusts_event_id.slice('purchase_'.length) === e.adjusts_order_id.slice('sub_'.length),
        'adjusts_event_id and adjusts_order_id must reference the same purchase',
      );
    }
  }
  if (name === 'refund') {
    need(
      e.charge_id !== null && new RegExp(`^refund_${e.charge_id}_[1-9][0-9]*$`).test(e.event_id),
      'refund event_id must be refund_<charge_id>_<cumulative amount refunded>',
    );
  }
  if (name === 'chargeback') need(e.event_id.startsWith('chargeback_'), 'chargeback id must start chargeback_');
  if (name === 'enterprise_lead' || name === 'lead_stage_change') {
    need(e.source_system === 'hubspot', `${name} comes from HubSpot`);
    need(e.lead !== null, `${name} needs lead context`);
    need(e.event_id.startsWith(name === 'enterprise_lead' ? 'lead_' : 'leadstage_'), `${name} id prefix`);
    if (name === 'lead_stage_change') need(e.lead?.lifecycle_stage != null, 'lead_stage_change needs lifecycle_stage');
  }
  return issues;
}

export const ConversionLedgerEventSchema: z.ZodType<ConversionLedgerEvent> = ledgerBase.superRefine((e, ctx) => {
  for (const message of ledgerIssues(e)) ctx.addIssue({ code: 'custom', message });
});

// ---------------------------------------------------------------------------
// Click-id store
// ---------------------------------------------------------------------------

const epochMs = z.int().min(1_000_000_000_000).max(99_999_999_999_999);

function pairedIds(keys: readonly string[], record: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const k of keys) {
    if ((record[k] === undefined) !== (record[`${k}_created_at`] === undefined)) {
      issues.push(`${k} and ${k}_created_at must be sent together`);
    }
  }
  return issues;
}

/** Shape of "<id>" + "<id>_created_at" pairs, typed per key so zod infers the real record type. */
type ClickIdPairShape<K extends string, V extends z.ZodType> = { [P in K]: z.ZodOptional<V> } & {
  [P in K as `${P}_created_at`]: z.ZodOptional<typeof epochMs>;
};

function clickIdPairShape<K extends string, V extends z.ZodType>(keys: readonly K[], value: V): ClickIdPairShape<K, V> {
  const shape: Record<string, z.ZodType> = {};
  for (const k of keys) {
    shape[k] = value.optional();
    shape[`${k}_created_at`] = epochMs.optional();
  }
  return shape as ClickIdPairShape<K, V>;
}

const clickIdStoreRecordObject = z.strictObject(
  clickIdPairShape(CLICK_ID_KEYS_CURRENT, z.string().regex(/^[A-Za-z0-9._-]{1,512}$/)),
);

export const ClickIdStoreRecordSchema: z.ZodType<ClickIdStoreRecord> = clickIdStoreRecordObject.superRefine((rec, ctx) => {
  if (Object.keys(rec).length < 2) ctx.addIssue({ code: 'custom', message: 'at least one click id' });
  for (const message of pairedIds(CLICK_ID_KEYS_CURRENT, rec)) ctx.addIssue({ code: 'custom', message });
});

const utmStoreShape = Object.fromEntries(UTM_KEYS.map((k) => [k, z.string().min(1).max(500).optional()])) as Record<
  UtmKey,
  z.ZodOptional<z.ZodString>
>;

const clickIdStoreRecordExtendedObject = z.strictObject({
  ...clickIdPairShape(CLICK_ID_KEYS_EXTENDED, z.string().regex(/^[A-Za-z0-9._-]{1,1000}$/)),
  ...utmStoreShape,
  landing_url: z.url().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  context_captured_at: epochMs.optional(),
});

export const ClickIdStoreRecordExtendedSchema: z.ZodType<ClickIdStoreRecordExtended> =
  clickIdStoreRecordExtendedObject.superRefine((rec, ctx) => {
    if (Object.keys(rec).length < 1) ctx.addIssue({ code: 'custom', message: 'empty record' });
    for (const message of pairedIds(CLICK_ID_KEYS_EXTENDED, rec)) ctx.addIssue({ code: 'custom', message });
    const hasContext = [...UTM_KEYS, 'landing_url' as const, 'referrer' as const].some((k) => rec[k] !== undefined);
    if (hasContext && rec.context_captured_at === undefined) {
      ctx.addIssue({ code: 'custom', message: 'utm/landing/referrer need context_captured_at' });
    }
  });

// ---------------------------------------------------------------------------
// Predicted profit, purchase value, exposures, audiences, mapping rows
// ---------------------------------------------------------------------------

const featureName = z.string().regex(/^[a-z][a-z0-9_]*$/);
const featureValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);

const predictedProfitObject = z.strictObject({
  user_id: userId,
  computed_at: utc,
  horizon_days: z.literal(90),
  feature_window_hours: z.literal(24),
  currency: z.literal('USD'),
  predicted_revenue: z.number().min(0),
  predicted_generation_cost: z.number().min(0),
  predicted_fees: z.number().min(0),
  predicted_refund_risk: z.number().min(0),
  refund_probability: z.number().min(0).max(1).nullable(),
  predicted_profit: z.number(),
  model_version: z.string().min(1).max(128),
  features: z.record(featureName, featureValue),
});

/** Estimand: unconditional E[90d profit per exposed user]. For experiment/bandit readouts, never ad values. */
export const PredictedProfitSchema: z.ZodType<PredictedProfit> = predictedProfitObject.superRefine((p, ctx) => {
  const expected = p.predicted_revenue - p.predicted_generation_cost - p.predicted_fees - p.predicted_refund_risk;
  if (Math.abs(expected - p.predicted_profit) > 0.01) {
    ctx.addIssue({ code: 'custom', message: `predicted_profit ${p.predicted_profit} != components ${expected}` });
  }
});

const MONEY_TOLERANCE = 0.01;
const PURCHASE_EVENT_ID = new RegExp(['^purchase_', PURCHASE_REF, '$'].join(''));

const purchaseFeatureSnapshotObject = z.object({ as_of: utc }).catchall(featureValue);

const purchaseValueScoreObject = z.strictObject({
  event_id: z.string().regex(PURCHASE_EVENT_ID),
  invoice_id: z.string().regex(/^in_[A-Za-z0-9]+$/).nullable(),
  user_id: userId,
  occurred_at: utc,
  scored_at: utc,
  estimand: z.literal(PURCHASE_VALUE_ESTIMAND),
  horizon_days: z.literal(90),
  predicted_revenue_90d: z.number().min(0),
  predicted_generation_cost_90d: z.number().min(0),
  predicted_fees_90d: z.number().min(0),
  predicted_refund_risk: z.number().min(0),
  predicted_profit_90d: z.number(),
  interval_low: z.number(),
  interval_high: z.number(),
  cash_value: z.number().min(0),
  currency,
  model_version: z.string().min(1).max(128),
  run_id: z.string().min(1).max(256),
  fitted_params_ref: z.string().min(1).max(1024),
  features_snapshot: purchaseFeatureSnapshotObject,
});

function purchaseValueIssues(s: z.infer<typeof purchaseValueScoreObject>): string[] {
  const issues: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) issues.push(msg);
  };
  const ref = s.event_id.slice('purchase_'.length);
  if (s.invoice_id !== null) need(ref === s.invoice_id, 'event_id must be purchase_<invoice_id>');
  else need(ref.startsWith('cs_'), 'an invoice-less score must be purchase_<checkoutSessionId>');
  const occurred = Date.parse(s.occurred_at);
  need(Date.parse(s.scored_at) >= occurred, 'scored_at must be >= occurred_at (scored at purchase, never before)');
  const expected = s.predicted_revenue_90d - s.predicted_generation_cost_90d - s.predicted_fees_90d - s.predicted_refund_risk;
  need(
    Math.abs(expected - s.predicted_profit_90d) <= MONEY_TOLERANCE,
    `predicted_profit_90d ${s.predicted_profit_90d} != components ${expected}`,
  );
  need(s.interval_low <= s.interval_high, 'interval_low must be <= interval_high');
  need(
    s.predicted_profit_90d >= s.interval_low - MONEY_TOLERANCE && s.predicted_profit_90d <= s.interval_high + MONEY_TOLERANCE,
    'predicted_profit_90d must lie inside [interval_low, interval_high]',
  );
  need(
    Date.parse(s.features_snapshot.as_of) <= occurred,
    'features_snapshot.as_of must be <= occurred_at (point-in-time features only)',
  );
  for (const [key, value] of Object.entries(s.features_snapshot)) {
    need(featureName.safeParse(key).success, `feature name ${key} must be snake_case`);
    if (key !== 'as_of' && key.endsWith('_at') && typeof value === 'string') {
      const t = Date.parse(value);
      need(!(Number.isFinite(t) && t > occurred), `feature ${key} is after occurred_at (post-purchase leakage)`);
    }
  }
  return issues;
}

/** Estimand: E[gross_profit_90d | purchase], scored at purchase time. The value ad platforms receive. */
export const PurchaseValueScoreSchema: z.ZodType<PurchaseValueScore> = purchaseValueScoreObject.superRefine((s, ctx) => {
  for (const message of purchaseValueIssues(s)) ctx.addIssue({ code: 'custom', message });
});

const experimentExposureObject = z.strictObject({
  user_id: userId,
  flag_key: flagKey,
  arm: z.string().min(1).max(128),
  first_exposed_at: utc,
  source: z.enum(['amplitude_exposure_event', 'amplitude_user_property', 'launchdarkly']).optional(),
  device_id: z.string().nullable().optional(),
});
export const ExperimentExposureSchema: z.ZodType<ExperimentExposure> = experimentExposureObject;

const audienceMemberObject = z.strictObject({
  platform: z.enum(PLATFORMS),
  list_name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,127}$/),
  action: z.enum(['add', 'remove']),
  reason: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  identifiers: z
    .strictObject({
      email_sha256: sha256.optional(),
      phone_sha256: sha256.optional(),
      external_id_sha256: sha256.optional(),
    })
    .refine((ids) => Object.keys(ids).length > 0, 'at least one hashed identifier'),
  value: z.number().min(0).nullable(),
  user_id: userId.nullable(),
  computed_at: utc,
});
export const AudienceMemberSchema: z.ZodType<AudienceMember> = audienceMemberObject;

const browserTwin = z.strictObject({
  event: z.string(),
  id_template: z.string().nullable(),
  id_hashed: z.boolean(),
  value_sent: z.string(),
  scope: z.string(),
  evidence: z.string(),
});

const platformEventMappingObject = z.strictObject({
  canonical_event: z.enum(CANONICAL_EVENT_NAMES),
  platform: z.enum(PLATFORMS),
  send: z.boolean(),
  delivery: z.enum(['server_event', 'server_adjustment', 'none']),
  status: z.enum(['twin_observed', 'server_only', 'not_sent']),
  platform_event_name: z.string().nullable(),
  destination: z.string().nullable(),
  action_source: z.string().nullable(),
  dedup_key_field: z.string().nullable(),
  dedup_key_template: z.string().nullable(),
  value_field: z.string().nullable(),
  currency_field: z.string().nullable(),
  user_data_fields: z.array(z.string()),
  click_id_fields: z.array(z.string()),
  consent_fields: z.array(z.string()),
  event_time_field: z.string().nullable(),
  max_event_age_days: z.int().min(1).nullable(),
  browser_twin: browserTwin.nullable(),
  requires_web_fix: z.boolean(),
  notes: z.string(),
  sources: z.array(z.string()).min(1),
});

export const PlatformEventMappingRowSchema: z.ZodType<PlatformEventMappingRow> = platformEventMappingObject.superRefine(
  (row, ctx) => {
    if (row.send) {
      if (row.delivery === 'none') ctx.addIssue({ code: 'custom', message: 'sent rows need a delivery' });
      if (!row.platform_event_name || !row.dedup_key_field || !row.dedup_key_template) {
        ctx.addIssue({ code: 'custom', message: 'sent rows need event name and dedup key' });
      }
    } else if (row.delivery !== 'none' || row.status !== 'not_sent') {
      ctx.addIssue({ code: 'custom', message: 'unsent rows must be delivery none / status not_sent' });
    }
  },
);

// ---------------------------------------------------------------------------
// Compile-time drift guard
// ---------------------------------------------------------------------------

/**
 * true only when A and B have the same keys and are mutually assignable. The key check
 * catches an optional field that exists on one side only, which plain assignability
 * (and a `z.ZodType<T>` annotation) lets through.
 */
type Exactly<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? [A] extends [B]
      ? [B] extends [A]
        ? true
        : false
      : false
    : false
  : false;

/** tsc fails here ("Type 'true' is not assignable to type 'false'") if a validator drifts from types.ts. */
const DRIFT_GUARDS: [
  Exactly<z.output<typeof consentObject>, Consent>,
  Exactly<z.output<typeof ledgerBase>, ConversionLedgerEvent>,
  Exactly<z.output<typeof clickIdStoreRecordObject>, ClickIdStoreRecord>,
  Exactly<z.output<typeof clickIdStoreRecordExtendedObject>, ClickIdStoreRecordExtended>,
  Exactly<z.output<typeof predictedProfitObject>, PredictedProfit>,
  Exactly<z.output<typeof purchaseFeatureSnapshotObject>, PurchaseFeatureSnapshot>,
  Exactly<z.output<typeof purchaseValueScoreObject>, PurchaseValueScore>,
  Exactly<z.output<typeof experimentExposureObject>, ExperimentExposure>,
  Exactly<z.output<typeof audienceMemberObject>, AudienceMember>,
  Exactly<z.output<typeof platformEventMappingObject>, PlatformEventMappingRow>,
] = [true, true, true, true, true, true, true, true, true, true];
void DRIFT_GUARDS;
