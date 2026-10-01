/**
 * PlatformEventMapping: canonical event x platform -> what openart-signal sends.
 *
 * Rule: where OpenArt's browser already sends a conversion (research/11 sealed replay,
 * research/02 §3.2), the server event reuses the SAME event name and dedup id so the
 * platform dedupes it; where the browser sends a twin WITHOUT a usable id, the row is
 * flagged requires_web_fix (packages/web-fixes adds the id) because the server event
 * would otherwise double count. API field names: research/08 B1-B3 and §6.3; rows marked
 * "(verify)" name fields the research did not quote verbatim.
 * Templates: {user_id} {invoice_id} {event_id} {order_id} {adjusts_order_id} (ledger row values).
 * Purchases after the first use {order_id}/{event_id} so invoice-less one-time packs work too.
 */

import type { CanonicalEventName, Platform } from './constants.js';
import { CANONICAL_EVENT_NAMES, OPENART, PLATFORMS } from './constants.js';
import type { BrowserTwin, PlatformEventMappingRow } from './types.js';

type Defaults = Pick<
  PlatformEventMappingRow,
  | 'destination'
  | 'action_source'
  | 'dedup_key_field'
  | 'value_field'
  | 'currency_field'
  | 'user_data_fields'
  | 'click_id_fields'
  | 'consent_fields'
  | 'event_time_field'
  | 'max_event_age_days'
  | 'sources'
>;

const G = OPENART.googleAds;
const PLATFORM_DEFAULTS: Record<Platform, Defaults> = {
  google_ads: {
    destination: `${G.primaryAccount} conversion action (Google Data Manager API ingestEvents)`,
    action_source: null,
    dedup_key_field: 'transactionId',
    value_field: 'conversionValue',
    currency_field: 'currency',
    user_data_fields: [
      'userData.userIdentifiers[].emailAddress (SHA-256 hex, google_ads normalisation)',
      'userData.userIdentifiers[].phoneNumber (SHA-256, E.164)',
    ],
    click_id_fields: ['adIdentifiers.gclid', 'adIdentifiers.gbraid', 'adIdentifiers.wbraid'],
    consent_fields: ['consent.adUserData', 'consent.adPersonalization'],
    event_time_field: 'eventTimestamp',
    max_event_age_days: 90,
    sources: ['research/08 §1.2-§1.4', 'https://developers.google.com/data-manager/api/devguides/events/google-ads/online/send-events'],
  },
  meta: {
    destination: `pixel ${OPENART.meta.pixelId} via Conversions API (direct, or the existing CAPI Gateway /capi/{pixel}/events)`,
    action_source: 'website',
    dedup_key_field: 'event_id',
    value_field: 'custom_data.value',
    currency_field: 'custom_data.currency',
    user_data_fields: [
      'user_data.em (SHA-256, trim+lowercase)',
      'user_data.ph (SHA-256, digits with country code)',
      'user_data.external_id (SHA-256 of the LOWER-CASED uid, as the pixel sends)',
      'user_data.fbp',
      'user_data.client_ip_address',
      'user_data.client_user_agent',
    ],
    click_id_fields: ['user_data.fbc (fb.1.<fbclid_created_at ms>.<fbclid>, never hashed)'],
    consent_fields: ['data_processing_options (LDU)', 'opt_out'],
    event_time_field: 'event_time',
    max_event_age_days: 7,
    sources: ['research/08 §2.1-§2.4', 'https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event'],
  },
  tiktok: {
    destination: `Events API 2.0 POST /open_api/v1.3/event/track/, event_source=web, event_source_id=${OPENART.tiktok.pixelCode}`,
    action_source: null,
    dedup_key_field: 'event_id',
    value_field: 'properties.value',
    currency_field: 'properties.currency',
    user_data_fields: [
      'user.email (SHA-256, trim+lowercase)',
      'user.phone (SHA-256, E.164)',
      'user.external_id (SHA-256)',
      'user.ttp (_ttp cookie)',
      'user.ip',
      'user.user_agent',
    ],
    click_id_fields: ['user.ttclid'],
    consent_fields: ['limited_data_use'],
    event_time_field: 'event_time',
    max_event_age_days: null,
    sources: ['research/08 B3 TikTok', 'https://business-api.tiktok.com/portal/docs?id=1771101303285761'],
  },
  reddit: {
    destination: `CAPI v3 POST /api/v3/pixels/${OPENART.reddit.pixelId}/conversion_events`,
    action_source: 'WEBSITE',
    dedup_key_field: 'metadata.conversion_id',
    value_field: 'metadata.value',
    currency_field: 'metadata.currency',
    user_data_fields: [
      'user.email (SHA-256; lowercase, strip dots and +suffix in local part)',
      'user.external_id',
      'user.uuid (_rdt_uuid)',
      'user.ip_address',
      'user.user_agent',
    ],
    click_id_fields: ['click_id (rdt_cid)'],
    consent_fields: ['user.data_processing_options (LDU)'],
    event_time_field: 'event_at',
    max_event_age_days: 7,
    sources: ['research/08 B3 Reddit', 'https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration'],
  },
  linkedin: {
    destination: `Conversions API POST /rest/conversionEvents, one conversion rule per source (Insight Tag partner ${OPENART.linkedin.partnerId})`,
    action_source: null,
    dedup_key_field: 'eventId',
    value_field: 'conversionValue.amount',
    currency_field: 'conversionValue.currencyCode',
    user_data_fields: ['user.userIds[SHA256_EMAIL]', 'user.userInfo (first/last name, company, title, country)'],
    click_id_fields: ['user.userIds[LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID] (li_fat_id)'],
    consent_fields: [],
    event_time_field: 'conversionHappenedAt',
    max_event_age_days: 90,
    sources: ['research/08 B3 LinkedIn', 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api?view=li-lms-2026-09'],
  },
  x: {
    destination: `Conversion API POST /12/measurement/conversions/${OPENART.x.pixelId}`,
    action_source: null,
    dedup_key_field: 'conversion_id',
    value_field: 'value (verify)',
    currency_field: 'price_currency (verify)',
    user_data_fields: ['identifiers[].hashed_email (SHA-256, trim+lowercase)', 'identifiers[].hashed_phone_number (SHA-256, E.164)', 'identifiers[].ip_address + user_agent (only with a second identifier)'],
    click_id_fields: ['identifiers[].twclid'],
    consent_fields: [],
    event_time_field: 'conversion_time',
    max_event_age_days: null,
    sources: ['research/08 B3 X', 'https://docs.x.com/x-ads-api/measurement/web-conversions'],
  },
  microsoft: {
    destination: `UET Conversions API POST https://capi.uet.microsoft.com/v1/${OPENART.microsoft.uetTagId}/events (staged rollout)`,
    action_source: null,
    dedup_key_field: 'eventId',
    value_field: 'customData.value (verify)',
    currency_field: 'customData.currency (verify)',
    user_data_fields: ['userData.em (SHA-256; trim, strip dots and +alias, lowercase)', 'userData.ph (SHA-256, E.164)', 'userData.externalId', 'userData.anonymousId (UET VID via ID Sync)'],
    click_id_fields: ['userData.msclkid'],
    consent_fields: ['adStorageConsent (G/D; default granted)'],
    event_time_field: 'eventTime',
    max_event_age_days: 7,
    sources: ['research/08 B3 Microsoft', 'https://learn.microsoft.com/en-us/advertising/guides/uet-conversion-api-integration?view=bingads-13'],
  },
};

type Spec = Partial<Omit<PlatformEventMappingRow, 'canonical_event' | 'platform'>> & {
  send: boolean;
};

const NOT_SENT = (notes: string): Spec => ({ send: false, notes });
const twin = (t: BrowserTwin): Pick<Spec, 'browser_twin' | 'status'> => ({ browser_twin: t, status: 'twin_observed' });
const REPLAY = 'research/11 §3.1 (sealed replay of GTM-56CMP8K v25)';

/** Server-only event whose dedup key is the canonical event_id. */
const serverOnly = (name: string, notes: string, extra: Partial<Spec> = {}): Spec => ({
  send: true,
  status: 'server_only',
  platform_event_name: name,
  dedup_key_template: '{event_id}',
  notes,
  ...extra,
});

const PURCHASE_LATER = (event: string, name: Record<Platform, string>): Record<Platform, Spec> => ({
  google_ads: serverOnly(name.google_ads, `No browser twin (${event} never reaches the browser). Use a SECONDARY conversion action so it informs value without changing what campaigns optimise for; transactionId sub_{invoice_id} keeps it unique per invoice.`, { dedup_key_template: '{order_id}' }),
  meta: serverOnly(name.meta, `No browser twin. Custom event; Meta's documented action_source for auto-pay renewals is system_generated. ≤7-day send window.`, { action_source: event === 'purchase_renewal' ? 'system_generated' : 'website', dedup_key_template: '{event_id}' }),
  tiktok: serverOnly(name.tiktok, 'No browser twin. Custom event (reporting/audiences, not an optimisation event).', { dedup_key_template: '{order_id}' }),
  reddit: serverOnly(name.reddit, 'No browser twin. type CUSTOM with custom_event_name; ≤7 days.', { dedup_key_template: '{order_id}' }),
  linkedin: NOT_SENT('Not sent: LinkedIn is used for B2B leads; post-purchase subscription events add noise there.'),
  x: NOT_SENT('Not sent: needs a new Events Manager event per type and X optimises on the purchase twin only.'),
  microsoft: serverOnly(name.microsoft, 'No browser twin. Custom UET event via CAPI (eventName distinct from purchase).', { dedup_key_template: '{order_id}' }),
});

const custom = (n: string): Record<Platform, string> => ({
  google_ads: `${G.primaryAccount} secondary conversion action "${n}" (to create)`,
  meta: n,
  tiktok: n,
  reddit: `CUSTOM:${n}`,
  linkedin: n,
  x: n,
  microsoft: n,
});

const SPECS: Record<CanonicalEventName, Record<Platform, Spec>> = {
  signup: {
    google_ads: {
      send: true,
      status: 'server_only',
      platform_event_name: `${G.primaryAccount}/${G.signupLabel['AW-11252321380']}`,
      dedup_key_template: 'reg_{user_id}',
      value_field: null,
      currency_field: null,
      browser_twin: { event: 'new_user_signed_up (GTM tag 17)', id_template: null, id_hashed: false, value_sent: 'value=0, auto oid GG_<random>', scope: 'never fires: nothing emits new_user_signed_up', evidence: 'research/11 claim 1' },
      notes: 'The browser tag is dead, so the server event is the only signup Google gets. If web-fixes revives the trigger, it must also set orderId reg_<uid>, or the two will double count.',
    },
    meta: {
      send: true,
      platform_event_name: 'CompleteRegistration',
      dedup_key_template: 'reg_{user_id}',
      value_field: null,
      currency_field: null,
      ...twin({ event: 'fbq track CompleteRegistration', id_template: 'reg_{user_id}', id_hashed: false, value_sent: 'none', scope: 'every signup (oa_pixel_signup_uid cookie)', evidence: 'research/02 §3.4' }),
      notes: 'Same event_name + event_id as the pixel: Meta dedupes within 48 h, keeping the first received.',
    },
    tiktok: {
      send: true,
      platform_event_name: 'CompleteRegistration',
      dedup_key_template: 'reg_{user_id}',
      value_field: null,
      currency_field: null,
      requires_web_fix: true,
      ...twin({ event: 'CompleteRegistration (GTM tag 79)', id_template: null, id_hashed: false, value_sent: 'none', scope: 'every signup', evidence: `${REPLAY}: event_id ""` }),
      notes: 'The browser sends event_id "", so a server event_id cannot match; set event_id reg_<uid> in the tag first.',
    },
    reddit: {
      send: true,
      platform_event_name: 'SIGN_UP',
      dedup_key_template: 'reg_{user_id}',
      value_field: null,
      currency_field: null,
      requires_web_fix: true,
      ...twin({ event: 'SignUp (GTM tag 57)', id_template: null, id_hashed: false, value_sent: 'none', scope: 'every signup', evidence: `${REPLAY}: em only, no conversionId` }),
      notes: 'No conversionId on the pixel; session fallback needs <5 min gaps. Add conversionId reg_<uid> to the tag.',
    },
    linkedin: {
      send: true,
      platform_event_name: `conversion rule (server) paired with Insight conversion ${OPENART.linkedin.conversionIds.signup}`,
      dedup_key_template: 'reg_{user_id}',
      value_field: null,
      currency_field: null,
      requires_web_fix: true,
      ...twin({ event: `Insight conversion ${OPENART.linkedin.conversionIds.signup} (GTM tag 72)`, id_template: null, id_hashed: false, value_sent: 'none', scope: 'every signup', evidence: `${REPLAY}: conversionId only, eventId ""` }),
      notes: 'LinkedIn keeps the Insight Tag event when eventIds match; with eventId "" it cannot match. Set eventId reg_<uid> in the tag.',
    },
    x: {
      send: true,
      platform_event_name: OPENART.x.eventIds.signup,
      dedup_key_template: 'reg_{user_id}',
      value_field: null,
      currency_field: null,
      requires_web_fix: true,
      ...twin({ event: `${OPENART.x.eventIds.signup} (GTM tag 76)`, id_template: null, id_hashed: false, value_sent: 'none', scope: 'every signup', evidence: `${REPLAY}: email hash, event={}` }),
      notes: 'No conversion_id on the pixel event; add conversion_id reg_<uid> to the tag before sending server twins.',
    },
    microsoft: serverOnly('signup', 'No UET signup today; custom CAPI event.', { dedup_key_template: 'reg_{user_id}', value_field: null, currency_field: null }),
  },
  activation_first_generation: {
    google_ads: serverOnly(custom('activation_first_generation').google_ads, 'New signal: first generation (credit ledger). Secondary action for observation/audiences.', { value_field: null, currency_field: null }),
    meta: serverOnly('activation_first_generation', 'New custom event; candidate optimisation event for low-volume ad sets.', { value_field: null, currency_field: null }),
    tiktok: serverOnly('activation_first_generation', 'New custom event.', { value_field: null, currency_field: null }),
    reddit: serverOnly('CUSTOM:activation_first_generation', 'New custom event.', { value_field: null, currency_field: null }),
    linkedin: NOT_SENT('Not sent: B2B lead channel.'),
    x: NOT_SENT('Not sent: needs a new Events Manager event; low volume.'),
    microsoft: NOT_SENT('Not sent: search channel optimises on purchases.'),
  },
  checkout_started: {
    google_ads: serverOnly(custom('begin_checkout').google_ads, 'Intent signal from Amplitude subscription_started (no ad platform receives checkout intent today).', { value_field: null, currency_field: null }),
    meta: serverOnly('InitiateCheckout', 'Standard event; never sent by the browser (not found in any bundle).', { value_field: null, currency_field: null }),
    tiktok: serverOnly('InitiateCheckout', 'Standard event; never sent by the browser.', { value_field: null, currency_field: null }),
    reddit: NOT_SENT('Not sent: no matching standard type; keep Reddit on SIGN_UP/PURCHASE.'),
    linkedin: NOT_SENT('Not sent: B2B lead channel.'),
    x: NOT_SENT('Not sent.'),
    microsoft: NOT_SENT('Not sent.'),
  },
  purchase_first: {
    google_ads: {
      send: true,
      platform_event_name: `${G.primaryAccount}/${G.purchaseLabels['AW-11252321380']}`,
      dedup_key_template: 'sub_{invoice_id}',
      ...twin({ event: 'purchase (GTM tags 15 and 19: both accounts)', id_template: 'sub_{invoice_id}', id_hashed: false, value_sent: 'first-invoice amount (fallback: stale list price + unstable Date.now() id)', scope: 'every subscription checkout', evidence: `${REPLAY} S3; research/02 §3.2` }),
      notes: `Data Manager multi-source: same transactionId overrides the tag value without a second count (14-day trial per action; allowlist per page summary). ${G.secondaryAccount}/${G.purchaseLabels['AW-16854695811']} receives the same oid: send to the account whose action is primary.`,
    },
    meta: {
      send: true,
      platform_event_name: 'Purchase',
      dedup_key_template: 'purchase_{invoice_id}',
      ...twin({ event: 'fbq track Purchase', id_template: 'purchase_{invoice_id}', id_hashed: false, value_sent: 'ltvValueMajor if the backend supplies it, else invoice amount', scope: 'first valid purchase only (isFirstPurchase)', evidence: 'research/02 §3.2' }),
      notes: 'Send only rows with is_first_purchase=true to keep one Purchase definition; win-back subscriptions have no pixel twin. Pixel and CAPI values should match for value optimisation.',
    },
    tiktok: {
      send: true,
      platform_event_name: 'Purchase',
      dedup_key_template: 'sub_{invoice_id}',
      ...twin({ event: 'Purchase (GTM tag 78 on first_purchase)', id_template: 'sub_{invoice_id}', id_hashed: false, value_sent: 'ltvValueMajor else amount', scope: 'first valid purchase only', evidence: `${REPLAY} S4` }),
      notes: 'Dedup key = event_source_id + event + event_id; first received wins within 48 h.',
    },
    reddit: {
      send: true,
      platform_event_name: 'PURCHASE',
      dedup_key_template: 'sub_{invoice_id}',
      ...twin({ event: 'Purchase (GTM tag 35)', id_template: 'sub_{invoice_id}', id_hashed: true, value_sent: 'invoice amount (m.valueDecimal)', scope: 'every subscription checkout', evidence: `${REPLAY} S3: m.conversionId = SHA-256(transaction id)` }),
      notes: 'The pixel hashes conversionId client-side; whether Reddit hashes a plaintext CAPI conversion_id before matching is undocumented: verify in the Reddit dedup log before relying on it. ≤2 days for dedup.',
    },
    linkedin: {
      send: true,
      platform_event_name: `conversion rule (server) paired with Insight conversion ${OPENART.linkedin.conversionIds.purchase}`,
      dedup_key_template: 'sub_{invoice_id}',
      requires_web_fix: true,
      ...twin({ event: `Insight conversion ${OPENART.linkedin.conversionIds.purchase} (GTM tag 58)`, id_template: null, id_hashed: false, value_sent: 'none', scope: 'every subscription checkout', evidence: `${REPLAY} S3: no value, currency, order or event id` }),
      notes: 'Set eventId sub_<invoiceId> (and value) on the Insight tag; LinkedIn then keeps the tag event and discards the matching CAPI event.',
    },
    x: {
      send: true,
      platform_event_name: OPENART.x.eventIds.purchase,
      dedup_key_template: 'sub_{invoice_id}',
      ...twin({ event: `${OPENART.x.eventIds.purchase} (GTM tag 75) + automatic gtm_purchase`, id_template: 'sub_{invoice_id}', id_hashed: false, value_sent: 'invoice amount', scope: 'every subscription checkout', evidence: `${REPLAY} S3` }),
      notes: 'X also emits an automatic gtm_purchase with order_id; make sure only one is a counted conversion in X Events Manager.',
    },
    microsoft: {
      send: true,
      platform_event_name: 'purchase',
      dedup_key_template: 'sub_{invoice_id}',
      requires_web_fix: true,
      ...twin({ event: "uetq.push('event','purchase')", id_template: null, id_hashed: false, value_sent: 'revenue_value = invoice amount; transaction_id sub_{invoice_id}', scope: 'every subscription checkout', evidence: `${REPLAY} S7` }),
      notes: 'UET CAPI dedup needs the same tagId + eventId + eventName; the browser call carries transaction_id but no event id, so add one before sending server twins.',
    },
  },
  purchase_renewal: PURCHASE_LATER('purchase_renewal', custom('purchase_renewal')),
  purchase_upgrade: PURCHASE_LATER('purchase_upgrade', custom('purchase_upgrade')),
  purchase_add_on: PURCHASE_LATER('purchase_add_on', custom('purchase_add_on')),
  purchase_one_time_pack: PURCHASE_LATER('purchase_one_time_pack', custom('purchase_one_time_pack')),
  refund: {
    google_ads: {
      send: true,
      delivery: 'server_adjustment',
      status: 'server_only',
      platform_event_name: 'conversion adjustment (value restatement)',
      dedup_key_template: '{adjusts_order_id}',
      notes: 'Data Manager adjustment on the original transactionId restates value (retraction is not documented); affects bidding only within 7 days of the original conversion.',
      sources: ['research/08 §1.3-§1.4', 'https://developers.google.com/data-manager/api/devguides/events/google-ads/conversion-adjustments'],
    },
    meta: NOT_SENT('No adjustment API: suppress refunders via audiences and exclude them from value/pLTV training.'),
    tiktok: NOT_SENT('No adjustment API.'),
    reddit: NOT_SENT('No adjustment API.'),
    linkedin: NOT_SENT('No adjustment API.'),
    x: NOT_SENT('No adjustment API.'),
    microsoft: {
      send: true,
      delivery: 'server_adjustment',
      status: 'server_only',
      platform_event_name: 'OnlineConversionAdjustment (Restate, or Retract on a full refund)',
      dedup_key_field: 'transactionId',
      dedup_key_template: '{adjusts_order_id}',
      notes: 'Restate changes value; Retract removes the conversion. Offline adjustments ≤90 days.',
      sources: ['research/08 B3 Microsoft', 'https://learn.microsoft.com/en-us/advertising/campaign-management-service/onlineconversionadjustment?view=bingads-13'],
    },
  },
  chargeback: {
    google_ads: {
      send: true,
      delivery: 'server_adjustment',
      status: 'server_only',
      platform_event_name: 'conversion adjustment (value restatement)',
      dedup_key_template: '{adjusts_order_id}',
      notes: 'As refund. Disputes often land after the 7-day bidding window; they still correct reporting.',
      sources: ['research/08 §1.4'],
    },
    meta: NOT_SENT('No adjustment API: suppress via audiences.'),
    tiktok: NOT_SENT('No adjustment API.'),
    reddit: NOT_SENT('No adjustment API.'),
    linkedin: NOT_SENT('No adjustment API.'),
    x: NOT_SENT('No adjustment API.'),
    microsoft: {
      send: true,
      delivery: 'server_adjustment',
      status: 'server_only',
      platform_event_name: 'OnlineConversionAdjustment (Retract)',
      dedup_key_field: 'transactionId',
      dedup_key_template: '{adjusts_order_id}',
      notes: 'Retract the disputed purchase.',
      sources: ['research/08 B3 Microsoft'],
    },
  },
  enterprise_lead: {
    google_ads: serverOnly(custom('enterprise_lead').google_ads, 'The /enterprise HubSpot form has hidden gclid/gbraid/wbraid (filled only when the ad landed on /enterprise) and no browser conversion (research/00 B2-B3). Offline/EC-for-leads via Data Manager.', { value_field: null, currency_field: null }),
    meta: serverOnly('Lead', 'No browser Lead event exists (not found in code).', { value_field: null, currency_field: null }),
    tiktok: NOT_SENT('Not sent: consumer channel.'),
    reddit: NOT_SENT('Not sent: consumer channel.'),
    linkedin: serverOnly('LEAD conversion rule', 'Form has no li_fat_id field; match on SHA256_EMAIL until edge-attribution fills it.', { value_field: null, currency_field: null }),
    x: NOT_SENT('Not sent.'),
    microsoft: serverOnly('enterprise_lead', 'B2B search leads.', { value_field: null, currency_field: null }),
  },
  lead_stage_change: {
    google_ads: serverOnly(custom('qualified_lead').google_ads, 'Offline conversion when HubSpot lifecyclestage reaches SQL; keyed on the lead gclid/email.', { value_field: null, currency_field: null }),
    meta: NOT_SENT('Not sent: Meta Conversion Leads needs a Meta lead_id; website-form leads have none.'),
    tiktok: NOT_SENT('Not sent.'),
    reddit: NOT_SENT('Not sent.'),
    linkedin: serverOnly('QUALIFIED_LEAD / SALES_QUALIFIED_LEAD conversion rule', 'LinkedIn supports MQL/SQL conversion types (API 202608+).', { value_field: null, currency_field: null }),
    x: NOT_SENT('Not sent.'),
    microsoft: NOT_SENT('Not sent.'),
  },
};

function buildRow(event: CanonicalEventName, platform: Platform): PlatformEventMappingRow {
  const spec = SPECS[event][platform];
  const d = PLATFORM_DEFAULTS[platform];
  if (!spec.send) {
    return {
      canonical_event: event,
      platform,
      send: false,
      delivery: 'none',
      status: 'not_sent',
      platform_event_name: null,
      destination: null,
      action_source: null,
      dedup_key_field: null,
      dedup_key_template: null,
      value_field: null,
      currency_field: null,
      user_data_fields: [],
      click_id_fields: [],
      consent_fields: [],
      event_time_field: null,
      max_event_age_days: null,
      browser_twin: spec.browser_twin ?? null,
      requires_web_fix: false,
      notes: spec.notes ?? '',
      sources: spec.sources ?? d.sources,
    };
  }
  return {
    canonical_event: event,
    platform,
    send: true,
    delivery: spec.delivery ?? 'server_event',
    status: spec.status ?? 'server_only',
    platform_event_name: spec.platform_event_name ?? null,
    destination: spec.destination ?? d.destination,
    action_source: spec.action_source !== undefined ? spec.action_source : d.action_source,
    dedup_key_field: spec.dedup_key_field ?? d.dedup_key_field,
    dedup_key_template: spec.dedup_key_template ?? '{event_id}',
    value_field: spec.value_field !== undefined ? spec.value_field : d.value_field,
    currency_field: spec.currency_field !== undefined ? spec.currency_field : d.currency_field,
    user_data_fields: spec.user_data_fields ?? d.user_data_fields,
    click_id_fields: spec.click_id_fields ?? d.click_id_fields,
    consent_fields: spec.consent_fields ?? d.consent_fields,
    event_time_field: spec.event_time_field ?? d.event_time_field,
    max_event_age_days: spec.max_event_age_days !== undefined ? spec.max_event_age_days : d.max_event_age_days,
    browser_twin: spec.browser_twin ?? null,
    requires_web_fix: spec.requires_web_fix ?? false,
    notes: spec.notes ?? '',
    sources: spec.sources ?? d.sources,
  };
}

/** The full table: 12 canonical events x 7 platforms = 84 rows. */
export const PLATFORM_EVENT_MAPPING: readonly PlatformEventMappingRow[] = CANONICAL_EVENT_NAMES.flatMap((e) =>
  PLATFORMS.map((p) => buildRow(e, p)),
);

export function getPlatformMapping(event: CanonicalEventName, platform: Platform): PlatformEventMappingRow {
  const row = PLATFORM_EVENT_MAPPING.find((r) => r.canonical_event === event && r.platform === platform);
  if (!row) throw new Error(`no mapping for ${event} x ${platform}`);
  return row;
}

/** Fill a dedup template with a ledger row's values. */
export function renderDedupKey(template: string, values: Record<string, string | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === null || v === undefined || v === '') throw new Error(`missing ${key} for dedup template ${template}`);
    return v;
  });
}

const CSV_COLUMNS: Array<keyof PlatformEventMappingRow> = [
  'canonical_event',
  'platform',
  'send',
  'delivery',
  'status',
  'platform_event_name',
  'destination',
  'action_source',
  'dedup_key_field',
  'dedup_key_template',
  'value_field',
  'currency_field',
  'user_data_fields',
  'click_id_fields',
  'consent_fields',
  'event_time_field',
  'max_event_age_days',
  'browser_twin',
  'requires_web_fix',
  'notes',
  'sources',
];

function csvCell(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ''
      : Array.isArray(value)
        ? value.join(' | ')
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV rendering of the table (fixtures/seeds/platform_event_mapping.csv) for warehouse seeds. */
export function platformMappingCsv(): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of PLATFORM_EVENT_MAPPING) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}
