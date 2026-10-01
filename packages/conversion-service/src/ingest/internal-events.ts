/**
 * POST /events: internal calls from OpenArt's backend for the non-Stripe conversions.
 *
 * The body is one envelope or an array (<=100). Each envelope carries a SOURCE record in
 * the contracts shape, validated against the contracts JSON Schema, plus optional request
 * context the backend already has (CMP consent, device id, IP/UA, first-party cookies):
 *
 *   credit_ledger_entry              trial ADD (USER_SIGNUP_TRIAL)       -> signup
 *                                    first CONSUME of a capability       -> activation_first_generation
 *   amplitude_event                  subscription_started                -> checkout_started (checkout_<uuid>)
 *   checkout_session_created         the /api/stripe/subscription form   -> checkout_started (checkout_<cs>)
 *   hubspot_form_submission          /enterprise form                    -> enterprise_lead
 *   hubspot_contact_property_change  lifecyclestage reaches a conversion stage -> lead_stage_change
 */

import { z } from 'zod';
import {
  BILLING_INTERVALS,
  ClickIdStoreRecordExtendedSchema,
  ConsentSchema,
  OPENART,
  PLAN_TIERS,
  TIER_CODE,
  activationEventId,
  checkoutStartedEventId,
  clickIdsFromStoreRecord,
  emptyAttribution,
  enterpriseLeadEventId,
  leadStageChangeEventId,
  modelIdFromBusinessType,
  planTierFromCode,
  signupEventId,
  unknownConsent,
} from '@openart-signal/contracts';
import type { ClickIds, ConversionLedgerEvent, LeadContext, PlanTier } from '@openart-signal/contracts';
import type { DocumentStore } from '../adapters/document-store.js';
import { hashIdentity } from '../identity.js';
import { RETENTION, expireAt } from '../retention.js';
import { parseUtc, systemClock, toUtc } from '../time.js';
import type { Clock } from '../time.js';
import { sanitizeEventSourceUrl } from '../url.js';
import type { HashedIdentity, NormalizedEvent, RequestContext } from '../types.js';
import { validateSource } from './source-schemas.js';
import type { SourceSchemaName } from './source-schemas.js';

const nullableString = (max: number) => z.string().min(1).max(max).nullable().optional();

export const RequestContextSchema = z.strictObject({
  /** Raw identity the backend knows for this user; hashed per platform immediately, never stored raw. */
  email: nullableString(320),
  phone: nullableString(32),
  device_id: nullableString(128),
  client_ip_address: z.union([z.ipv4(), z.ipv6()]).nullable().optional(),
  client_user_agent: nullableString(2048),
  /** Kept only when https; query string, fragment and credentials are stripped (sanitizeEventSourceUrl). */
  event_source_url: z.string().max(2048).nullable().optional(),
  fbc: nullableString(1024),
  fbp: nullableString(512),
  ttp: nullableString(512),
  rdt_uuid: nullableString(512),
  /** The CMP state at the time of the event (contracts Consent block). */
  consent: ConsentSchema.optional(),
  /** ISO country (or US-CA style subdivision) when no CMP state exists. */
  region: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/).nullable().optional(),
  /** Click ids captured with the request (contracts ClickIdStoreRecordExtended). */
  click_ids: z.unknown().optional(),
});
export type InternalRequestContext = z.infer<typeof RequestContextSchema>;

const CheckoutCreatedSchema = z.strictObject({
  user_id: z.string().min(1).max(128).regex(/^\S+$/),
  checkout_session_id: z.string().regex(/^cs_(live|test)_[A-Za-z0-9]+$/),
  /** The `tier` code the pricing form posts (1000, 2000, 3000, 3500, ...). */
  tier: z.int(),
  billing_interval: z.enum(BILLING_INTERVALS),
  occurred_at: z.iso.datetime(),
  ga_client_id: z.string().max(256).nullable().optional(),
  ga_session_id: z.string().max(256).nullable().optional(),
  gclid: z.string().regex(/^[A-Za-z0-9._-]{1,1000}$/).nullable().optional(),
  tolt_referral: z.string().max(256).nullable().optional(),
});

const ctx = RequestContextSchema.optional();
const EnvelopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('credit_ledger_entry'), entry: z.unknown(), context: ctx }),
  z.strictObject({ kind: z.literal('amplitude_event'), row: z.unknown(), context: ctx }),
  z.strictObject({ kind: z.literal('checkout_session_created'), checkout: CheckoutCreatedSchema, context: ctx }),
  z.strictObject({
    kind: z.literal('hubspot_form_submission'),
    submission: z.unknown(),
    /** The HubSpot contact the submission created or updated, when the backend knows it. */
    contact_id: z.string().regex(/^\d+$/).nullable().optional(),
    portal_id: z.int().optional(),
    form_id: z.string().min(1).optional(),
    context: ctx,
  }),
  z.strictObject({ kind: z.literal('hubspot_contact_property_change'), change: z.unknown(), context: ctx }),
]);

export type InternalEventEnvelope = z.infer<typeof EnvelopeSchema>;

const INNER: Record<string, { field: string; schema: SourceSchemaName }> = {
  credit_ledger_entry: { field: 'entry', schema: 'creditLedgerEntry' },
  amplitude_event: { field: 'row', schema: 'amplitudeExportRow' },
  hubspot_form_submission: { field: 'submission', schema: 'hubspotFormSubmission' },
  hubspot_contact_property_change: { field: 'change', schema: 'hubspotContactPropertyChange' },
};

export const MAX_EVENTS_PER_REQUEST = 100;

export type ParseResult = { ok: true; envelopes: InternalEventEnvelope[] } | { ok: false; error: string };

export function parseInternalEventsBody(body: unknown): ParseResult {
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0) return { ok: false, error: 'empty batch' };
  if (list.length > MAX_EVENTS_PER_REQUEST) return { ok: false, error: `at most ${MAX_EVENTS_PER_REQUEST} events per request` };
  const envelopes: InternalEventEnvelope[] = [];
  for (const [i, item] of list.entries()) {
    const parsed = EnvelopeSchema.safeParse(item);
    if (!parsed.success) {
      return { ok: false, error: `events[${i}]: ${parsed.error.issues.slice(0, 5).map((x) => `${x.path.join('.') || '/'} ${x.message}`).join('; ')}` };
    }
    const env = parsed.data;
    const inner = INNER[env.kind];
    if (inner) {
      const check = validateSource(inner.schema, (env as Record<string, unknown>)[inner.field]);
      if (!check.valid) return { ok: false, error: `events[${i}] ${env.kind}: ${check.errors.join('; ')}` };
    }
    if (env.context?.click_ids !== undefined) {
      const clicks = ClickIdStoreRecordExtendedSchema.safeParse(env.context.click_ids);
      if (!clicks.success) return { ok: false, error: `events[${i}].context.click_ids: ${clicks.error.issues[0]?.message ?? 'invalid'}` };
    }
    envelopes.push(env);
  }
  return { ok: true, envelopes };
}

export type InternalMapResult =
  | { kind: 'rows'; rows: NormalizedEvent[] }
  | { kind: 'ignore'; reason: string }
  | { kind: 'state'; note: string };

/** Source-record dedupe key for the webhook inbox. */
export function internalInboxKey(env: InternalEventEnvelope): string {
  switch (env.kind) {
    case 'credit_ledger_entry':
      return `ledger:${(env.entry as { id: string }).id}`;
    case 'amplitude_event':
      return `amplitude:${(env.row as { uuid: string }).uuid}`;
    case 'checkout_session_created':
      return `checkout:${env.checkout.checkout_session_id}`;
    case 'hubspot_form_submission':
      return `hubspot_form:${(env.submission as { conversionId: string }).conversionId}`;
    case 'hubspot_contact_property_change':
      return `hubspot_change:${(env.change as { eventId: number }).eventId}`;
    default: {
      const never: never = env;
      throw new Error(`unknown envelope ${String(never)}`);
    }
  }
}

interface ContactState {
  contact_id: string;
  portal_id: number;
  lifecycle_stage: string | null;
  lifecycle_changed_at_ms: number;
  lead_source: string | null;
  lead_source_detail: string | null;
  company_size: string | null;
  form_id: string | null;
  identity: HashedIdentity | null;
  click_ids: ClickIds;
  /** Retention (refreshed on every write). */
  expire_at: string;
}

export const HUBSPOT_CONTACTS = 'hubspot_contacts';

export interface InternalEventMapperOptions {
  /** lifecyclestage values that are a conversion (the mapping's Google/LinkedIn rows target SQL). */
  leadConversionStages?: readonly string[];
}

function baseRow(source: ConversionLedgerEvent['source_system']): ConversionLedgerEvent {
  return {
    schema_version: 1,
    event_id: '',
    event_name: 'signup',
    occurred_at: '',
    source_system: source,
    source_event_id: '',
    user_id: null,
    device_id: null,
    order_id: null,
    adjusts_event_id: null,
    adjusts_order_id: null,
    cash_value_minor: null,
    currency: null,
    invoice_id: null,
    subscription_id: null,
    checkout_session_id: null,
    charge_id: null,
    plan_tier: null,
    plan_tier_code: null,
    billing_interval: null,
    previous_plan_tier: null,
    credit_pack_quantity: null,
    is_first_purchase: null,
    is_business: null,
    generation: null,
    lead: null,
    ...emptyAttribution(),
    consent: unknownConsent(null),
    experiment_arms: {},
  };
}

/** Apply backend request context: consent, device id, click ids; split off transient data. */
function withContext(row: ConversionLedgerEvent, context: InternalRequestContext | undefined, extraEmail: string | null = null): NormalizedEvent {
  const c = context ?? {};
  const out: ConversionLedgerEvent = { ...row };
  let consentFromSource = false;
  if (c.consent) {
    out.consent = c.consent;
    consentFromSource = true;
  } else if (c.region) {
    out.consent = unknownConsent(c.region);
  }
  if (c.device_id && !out.device_id) out.device_id = c.device_id;
  if (c.click_ids) out.click_ids = { ...clickIdsFromStoreRecord(c.click_ids as never), ...out.click_ids };
  const requestContext: RequestContext = {};
  for (const key of ['client_ip_address', 'client_user_agent', 'fbc', 'fbp', 'ttp', 'rdt_uuid'] as const) {
    const v = c[key];
    if (typeof v === 'string') requestContext[key] = v;
  }
  const pageUrl = sanitizeEventSourceUrl(c.event_source_url);
  if (pageUrl) requestContext.event_source_url = pageUrl;
  return {
    row: out,
    identity: { email: c.email ?? extraEmail, phone: c.phone ?? null },
    context: requestContext,
    consentFromSource,
  };
}

function formValues(submission: { values: Array<{ name: string; value: string }> }): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of submission.values) if (typeof v.value === 'string' && v.value.length > 0) m.set(v.name, v.value);
  return m;
}

const CLICK_VALUE = /^[A-Za-z0-9._-]{1,1000}$/;

export class InternalEventMapper {
  private readonly conversionStages: ReadonlySet<string>;

  constructor(
    private readonly store: DocumentStore,
    options: InternalEventMapperOptions = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.conversionStages = new Set(options.leadConversionStages ?? ['salesqualifiedlead']);
  }

  private expiry(): string {
    return expireAt(this.clock(), RETENTION.stateDays);
  }

  async map(env: InternalEventEnvelope): Promise<InternalMapResult> {
    switch (env.kind) {
      case 'credit_ledger_entry':
        return this.ledgerEntry(env.entry as LedgerEntryLike, env.context);
      case 'amplitude_event':
        return this.amplitude(env.row as AmplitudeRowLike, env.context);
      case 'checkout_session_created':
        return this.checkoutCreated(env.checkout, env.context);
      case 'hubspot_form_submission':
        return this.hubspotForm(env);
      case 'hubspot_contact_property_change':
        return this.hubspotChange(env.change as HubspotChangeLike, env.context);
      default: {
        const never: never = env;
        throw new Error(`unknown envelope ${String(never)}`);
      }
    }
  }

  private ledgerEntry(entry: LedgerEntryLike, context: InternalRequestContext | undefined): InternalMapResult {
    const occurred = toUtc(parseUtc(entry.createdAt));
    if (entry.type === 'ADD' && entry.reference.businessType === 'USER_SIGNUP_TRIAL') {
      return {
        kind: 'rows',
        rows: [
          withContext(
            { ...baseRow('credit_ledger'), event_id: signupEventId(entry.userId), event_name: 'signup', occurred_at: occurred, source_event_id: entry.id, user_id: entry.userId },
            context,
          ),
        ],
      };
    }
    if (entry.type === 'CONSUME' && /^[A-Za-z0-9.-]+:[A-Za-z0-9-]+$/.test(entry.reference.businessType)) {
      const businessType = entry.reference.businessType;
      return {
        kind: 'rows',
        rows: [
          withContext(
            {
              ...baseRow('credit_ledger'),
              event_id: activationEventId(entry.userId),
              event_name: 'activation_first_generation',
              occurred_at: occurred,
              source_event_id: entry.id,
              user_id: entry.userId,
              generation: { business_type: businessType, model_id: modelIdFromBusinessType(businessType), credits: Math.abs(entry.amount) },
            },
            context,
          ),
        ],
      };
    }
    return { kind: 'ignore', reason: `ledger_entry_not_mapped:${entry.type}:${entry.reference.businessType}` };
  }

  private amplitude(row: AmplitudeRowLike, context: InternalRequestContext | undefined): InternalMapResult {
    if (row.event_type !== 'subscription_started') return { kind: 'ignore', reason: `amplitude_event_not_mapped:${row.event_type}` };
    if (!row.user_id) return { kind: 'ignore', reason: 'checkout_without_user' };
    const props = row.event_properties ?? {};
    const tier = (PLAN_TIERS as readonly string[]).includes(String(props.subscription_tier)) ? (props.subscription_tier as PlanTier) : null;
    const interval = props.subscription_interval === 'month' || props.subscription_interval === 'year' ? props.subscription_interval : null;
    const out: ConversionLedgerEvent = {
      ...baseRow('amplitude'),
      event_id: checkoutStartedEventId(row.uuid),
      event_name: 'checkout_started',
      occurred_at: toUtc(parseUtc(row.event_time)),
      source_event_id: row.uuid,
      user_id: row.user_id,
      device_id: row.device_id,
      plan_tier: tier,
      plan_tier_code: tier && tier in TIER_CODE ? TIER_CODE[tier as keyof typeof TIER_CODE] : null,
      billing_interval: interval,
    };
    return { kind: 'rows', rows: [withContext(out, context)] };
  }

  private checkoutCreated(c: z.infer<typeof CheckoutCreatedSchema>, context: InternalRequestContext | undefined): InternalMapResult {
    const tier = planTierFromCode(c.tier);
    const out: ConversionLedgerEvent = {
      ...baseRow('app_backend'),
      event_id: checkoutStartedEventId(c.checkout_session_id),
      event_name: 'checkout_started',
      occurred_at: toUtc(parseUtc(c.occurred_at)),
      source_event_id: c.checkout_session_id,
      user_id: c.user_id,
      checkout_session_id: c.checkout_session_id,
      plan_tier: tier,
      plan_tier_code: c.tier,
      billing_interval: c.billing_interval,
      ga_client_id: c.ga_client_id ?? null,
      ga_session_id: c.ga_session_id ?? null,
      tolt_referral: c.tolt_referral ?? null,
      click_ids: c.gclid ? { gclid: { value: c.gclid, created_at: null } } : {},
    };
    return { kind: 'rows', rows: [withContext(out, context)] };
  }

  private async hubspotForm(env: Extract<InternalEventEnvelope, { kind: 'hubspot_form_submission' }>): Promise<InternalMapResult> {
    const submission = env.submission as HubspotFormLike;
    const values = formValues(submission);
    const clickIds: ClickIds = {};
    for (const key of ['gclid', 'gbraid', 'wbraid'] as const) {
      const v = values.get(key);
      if (v && CLICK_VALUE.test(v)) clickIds[key] = { value: v, created_at: null };
    }
    const portalId = env.portal_id ?? OPENART.hubspot.portalId;
    const formId = env.form_id ?? OPENART.hubspot.enterpriseFormId;
    const contactId = env.contact_id ?? null;
    const lead: LeadContext = {
      hubspot_portal_id: portalId,
      form_id: formId,
      contact_id: contactId,
      lifecycle_stage: 'lead',
      previous_lifecycle_stage: null,
      lead_source: values.get('lead_source') ?? null,
      lead_source_detail: values.get('lead_source_detail') ?? null,
      company_size: values.get('company_size') ?? null,
    };
    const email = values.get('email') ?? null;
    const row: ConversionLedgerEvent = {
      ...baseRow('hubspot'),
      event_id: enterpriseLeadEventId(submission.conversionId),
      event_name: 'enterprise_lead',
      occurred_at: toUtc(submission.submittedAt),
      source_event_id: submission.conversionId,
      lead,
      click_ids: clickIds,
    };
    if (contactId) {
      const existing = await this.store.get<ContactState>(HUBSPOT_CONTACTS, contactId);
      const next: ContactState = {
        contact_id: contactId,
        portal_id: portalId,
        lifecycle_stage: existing?.data.lifecycle_stage ?? 'lead',
        lifecycle_changed_at_ms: existing?.data.lifecycle_changed_at_ms ?? submission.submittedAt,
        lead_source: lead.lead_source,
        lead_source_detail: lead.lead_source_detail,
        company_size: lead.company_size,
        form_id: formId,
        // Hashed now: later lifecycle changes carry no email, and raw PII is never stored.
        identity: email ? hashIdentity({ email, phone: values.get('phone') ?? null }, null) : (existing?.data.identity ?? null),
        click_ids: { ...(existing?.data.click_ids ?? {}), ...clickIds },
        expire_at: this.expiry(),
      };
      await this.store.put(HUBSPOT_CONTACTS, contactId, next);
    }
    const normalized = withContext(row, env.context, email);
    if (!normalized.identity.phone && values.get('phone')) normalized.identity.phone = values.get('phone') ?? null;
    return { kind: 'rows', rows: [normalized] };
  }

  private async hubspotChange(change: HubspotChangeLike, context: InternalRequestContext | undefined): Promise<InternalMapResult> {
    if (change.propertyName !== 'lifecyclestage') return { kind: 'ignore', reason: `hubspot_property_not_mapped:${change.propertyName}` };
    const contactId = String(change.objectId);
    const existing = (await this.store.get<ContactState>(HUBSPOT_CONTACTS, contactId))?.data ?? null;
    const isNewer = !existing || change.occurredAt >= existing.lifecycle_changed_at_ms;
    const previousStage = existing?.lifecycle_stage ?? null;
    if (isNewer) {
      await this.store.put(HUBSPOT_CONTACTS, contactId, {
        contact_id: contactId,
        portal_id: change.portalId,
        lifecycle_stage: change.propertyValue,
        lifecycle_changed_at_ms: change.occurredAt,
        lead_source: existing?.lead_source ?? null,
        lead_source_detail: existing?.lead_source_detail ?? null,
        company_size: existing?.company_size ?? null,
        form_id: existing?.form_id ?? null,
        identity: existing?.identity ?? null,
        click_ids: existing?.click_ids ?? {},
        expire_at: this.expiry(),
      } satisfies ContactState);
    }
    if (!this.conversionStages.has(change.propertyValue)) return { kind: 'state', note: `lifecycle_stage_recorded:${change.propertyValue}` };
    const row: ConversionLedgerEvent = {
      ...baseRow('hubspot'),
      event_id: leadStageChangeEventId(contactId, change.propertyValue),
      event_name: 'lead_stage_change',
      occurred_at: toUtc(change.occurredAt),
      source_event_id: String(change.eventId),
      lead: {
        hubspot_portal_id: change.portalId,
        form_id: null,
        contact_id: contactId,
        lifecycle_stage: change.propertyValue,
        previous_lifecycle_stage: isNewer ? previousStage : null,
        lead_source: existing?.lead_source ?? null,
        lead_source_detail: existing?.lead_source_detail ?? null,
        company_size: existing?.company_size ?? null,
      },
      click_ids: existing?.click_ids ?? {},
    };
    const normalized = withContext(row, context);
    if (existing?.identity) normalized.hashedIdentity = existing.identity;
    return { kind: 'rows', rows: [normalized] };
  }
}

interface LedgerEntryLike {
  id: string;
  type: string;
  amount: number;
  reference: { businessType: string; businessId: string };
  createdAt: string;
  userId: string;
}

interface AmplitudeRowLike {
  uuid: string;
  event_type: string;
  event_time: string;
  user_id: string | null;
  device_id: string;
  event_properties: Record<string, unknown>;
}

interface HubspotFormLike {
  conversionId: string;
  submittedAt: number;
  pageUrl: string;
  values: Array<{ name: string; value: string }>;
}

interface HubspotChangeLike {
  eventId: number;
  portalId: number;
  occurredAt: number;
  objectId: number;
  propertyName: string;
  propertyValue: string;
}
