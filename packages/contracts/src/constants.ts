/**
 * Canonical enumerations and OpenArt's real, public identifiers.
 *
 * Every OpenArt identifier below was observed in shipped code, the live GTM
 * container or a sealed/logged-in capture; the evidence path is given next to
 * each group (paths are relative to openart_2026-09-29/). Nothing here is a
 * secret: pixel ids, conversion labels and tier codes are all public client-side.
 */

// ---------------------------------------------------------------------------
// Canonical conversion-ledger event names (snake_case, OpenArt convention).
// ---------------------------------------------------------------------------

export const CANONICAL_EVENT_NAMES = [
  'signup',
  'activation_first_generation',
  'checkout_started',
  'purchase_first',
  'purchase_renewal',
  'purchase_upgrade',
  'purchase_add_on',
  'purchase_one_time_pack',
  'refund',
  'chargeback',
  'enterprise_lead',
  'lead_stage_change',
] as const;
export type CanonicalEventName = (typeof CANONICAL_EVENT_NAMES)[number];

/** Money-in events. Each maps 1:1 to a paid Stripe invoice (or a payment-mode Checkout Session). */
export const PURCHASE_EVENT_NAMES = [
  'purchase_first',
  'purchase_renewal',
  'purchase_upgrade',
  'purchase_add_on',
  'purchase_one_time_pack',
] as const satisfies readonly CanonicalEventName[];
export type PurchaseEventName = (typeof PURCHASE_EVENT_NAMES)[number];

/** Money-out events. `cash_value_minor` is negative. */
export const ADJUSTMENT_EVENT_NAMES = ['refund', 'chargeback'] as const satisfies readonly CanonicalEventName[];
export type AdjustmentEventName = (typeof ADJUSTMENT_EVENT_NAMES)[number];

export const LEAD_EVENT_NAMES = ['enterprise_lead', 'lead_stage_change'] as const satisfies readonly CanonicalEventName[];

// ---------------------------------------------------------------------------
// Ad platforms that openart-signal feeds server-side.
// ---------------------------------------------------------------------------

export const PLATFORMS = ['google_ads', 'meta', 'tiktok', 'reddit', 'linkedin', 'x', 'microsoft'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Where a canonical row was derived from. */
export const SOURCE_SYSTEMS = ['stripe', 'credit_ledger', 'amplitude', 'hubspot', 'app_backend'] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

// ---------------------------------------------------------------------------
// Plans. Canonical tier = OpenArt's internal tierKey lower-cased, which is also
// the Amplitude `subscription_tier` value ("essential" observed in
// crawl/loggedin_billing/evidence_api_samples_REDACTED.json). Marketing names
// differ: essential=Starter, advanced=Plus, infinite=Pro.
// Codes are the `tier` values the checkout form posts (research/10 §5.1) and the
// enum in raw/bundles/js/…pages___app-a1820d4f2194dce7.js.
// ---------------------------------------------------------------------------

export const PLAN_TIERS = ['essential', 'advanced', 'infinite', 'wonder', 'team', 'business'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const PLAN_DISPLAY_NAMES: Readonly<Record<PlanTier, string>> = {
  essential: 'Starter',
  advanced: 'Plus',
  infinite: 'Pro',
  wonder: 'Wonder',
  team: 'Team',
  business: 'Business',
};

/** Observed `tier` form codes. Business has one code per credit size. */
export const PLAN_TIER_CODES = {
  free: 0,
  essential: 1000,
  advanced: 2000,
  infinite: 3000,
  wonder: 3500,
  team: 4000,
  business_50k: 4450,
  business_100k: 4500,
  business_150k: 4550,
  business_250k: 4600,
  business_500k: 4650,
  business_750k: 4700,
  business_1m: 4750,
  trial: 10000,
} as const;

/** Map a posted tier code to the canonical tier (null for free/trial/unknown). */
export function planTierFromCode(code: number): PlanTier | null {
  if (code === PLAN_TIER_CODES.essential) return 'essential';
  if (code === PLAN_TIER_CODES.advanced) return 'advanced';
  if (code === PLAN_TIER_CODES.infinite) return 'infinite';
  if (code === PLAN_TIER_CODES.wonder) return 'wonder';
  if (code === PLAN_TIER_CODES.team) return 'team';
  if (code >= PLAN_TIER_CODES.business_50k && code <= PLAN_TIER_CODES.business_1m) return 'business';
  return null;
}

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

// ---------------------------------------------------------------------------
// Click ids, UTMs, consent.
// ---------------------------------------------------------------------------

/** Keys the Suite keeps in `oa_ad_clids` and POSTs to /api/user/ad-click-ids today (research/02 §3.3). */
export const CLICK_ID_KEYS_CURRENT = ['gclid', 'fbclid', 'msclkid', 'ttclid'] as const;
/** Extended store: adds ids the Astro shim or vendor pixels capture but the store drops (research/01 T3). */
export const CLICK_ID_KEYS_EXTENDED = [
  ...CLICK_ID_KEYS_CURRENT,
  'gbraid',
  'wbraid',
  'rdt_cid',
  'twclid',
  'li_fat_id',
  'oppref',
] as const;
export type CurrentClickIdKey = (typeof CLICK_ID_KEYS_CURRENT)[number];
export type ClickIdKey = (typeof CLICK_ID_KEYS_EXTENDED)[number];

/** Value regex the Suite applies before storing a click id (raw/bundles/js/…91db8069961c7577.js module 162070). */
export const CLICK_ID_VALUE_PATTERN_CURRENT = '^[A-Za-z0-9._-]{1,512}$';
/** Extended regex: TikTok documents ttclid values up to 1,000 characters (research/08 B3). */
export const CLICK_ID_VALUE_PATTERN_EXTENDED = '^[A-Za-z0-9._-]{1,1000}$';

/** The six UTM keys Amplitude's attribution plugin stores (research/01 T4). */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

/** Google Consent Mode v2 signals. OpenArt sends none today (gcd=13l3l3l3l1l1, research/11 §3.3). */
export const CONSENT_SIGNALS = ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'] as const;
export type ConsentSignal = (typeof CONSENT_SIGNALS)[number];
export const CONSENT_STATES = ['granted', 'denied', 'unknown'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];
/** Where a consent state came from: a CMP, a regional default, or nothing (today's reality). */
export const CONSENT_SOURCES = ['cmp', 'regional_default', 'none'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

// ---------------------------------------------------------------------------
// Value estimands. Two different questions, two different contracts:
//  - PredictedProfit (fct_predicted_profit_24h) is scored at signup + 24h for EVERY
//    exposed user, payers and non-payers alike. It is right for experiment and bandit
//    readouts, and wrong as an ad conversion value, because a purchase event is already
//    conditioned on the purchase.
//  - PurchaseValueScore is scored at purchase time, conditioned on that purchase. It is
//    the only value an ad platform should receive.
// ---------------------------------------------------------------------------

/** Estimand of PredictedProfit: for experiment/bandit readouts, never for ad values. */
export const PREDICTED_PROFIT_ESTIMAND = 'unconditional E[90d profit per exposed user]' as const;
/** Estimand of PurchaseValueScore: the value sent with purchase conversions. */
export const PURCHASE_VALUE_ESTIMAND = 'E[gross_profit_90d | purchase]' as const;
export type PurchaseValueEstimand = typeof PURCHASE_VALUE_ESTIMAND;

// ---------------------------------------------------------------------------
// Default-model experiment (LaunchDarkly flags mirrored to Amplitude as ab_<flag>).
// Arms observed in SSR bootstraps and Amplitude identifies (research/12 V4).
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_FLAGS = {
  createImage: 'suite-default-model-create-image',
  createVideo: 'suite-default-model-create-video',
  animateVideo: 'suite-default-model-animate-video',
  imageVariations: 'suite-default-model-image-variations',
} as const;

export const OBSERVED_ARMS = {
  'suite-default-model-create-image': ['nano-banana-pro', 'gpt-image-2-5', 'nano-banana-2', 'gpt-image-2'],
  'suite-default-model-create-video': ['byte-plus-seedance-2', 'byte-plus-seedance-2-5', 'wan3-0'],
} as const;

/** Amplitude user-property name for a flag (buildAmplitudeExperimentAssignmentUserProperties). */
export function amplitudeAbProperty(flagKey: string): string {
  return `ab_${flagKey}`;
}

// ---------------------------------------------------------------------------
// OpenArt's public identifiers (evidence noted per group).
// ---------------------------------------------------------------------------

export const OPENART = {
  /** research/02 §2, research/11 §7 */
  gtm: { containerId: 'GTM-56CMP8K', version: 25, googleTagGatewayPath: '/4vu8/' },
  /** research/02 §2.1 tags 15/17/19 */
  googleAds: {
    primaryAccount: 'AW-11252321380',
    secondaryAccount: 'AW-16854695811',
    purchaseLabels: { 'AW-11252321380': 'OfGcCJisoLQZEOSYw_Up', 'AW-16854695811': '4Rf-CM6EhJMcEIP_-OQ-' },
    /** Listens for `new_user_signed_up`, which nothing emits (research/11 claim 1). */
    signupLabel: { 'AW-11252321380': 'rVk2CJ7Ot8EZEOSYw_Up' },
  },
  ga4: { measurementId: 'G-QYRJB9TLG7', serverKeyEvent: 'purchase_first_server' },
  meta: { pixelId: '843671884361709', capiGateway: true },
  tiktok: { pixelCode: 'D9QOQ5JC77U6RO6J21IG', advertiserId: '7670743239628161042' },
  reddit: { pixelId: 'a2_j6xo78gpljnf' },
  linkedin: { partnerId: '10481401', conversionIds: { purchase: '29290225', signup: '29290241' } },
  x: { pixelId: 'qwghh', eventIds: { purchase: 'tw-qwghh-13vj24', signup: 'tw-qwghh-13vj22' } },
  microsoft: { uetTagId: '187107444' },
  openaiAds: { pixelId: 'MCEntnyMVfgRfepXXsrQLE', events: { signup: 'registration_completed', purchase: 'subscription_created' } },
  /** raw/enterprise/hs_form_render_definition.json */
  hubspot: { portalId: 244977254, enterpriseFormId: '9f0b1fda-34f1-4364-93d5-bdc196c44004' },
  /** research/10 §4 (derivable from the public publishable key) */
  stripe: { accountId: 'acct_1JnWMnKVhG51tYSB' },
  cookies: {
    deviceId: 'oa_device_id',
    clickIds: 'oa_ad_clids',
    signupUid: 'oa_signup_uid',
    metaSignupUid: 'oa_pixel_signup_uid',
    openaiSignupUid: 'oa_oaiq_signup_uid',
    country: 'country_code',
  },
  /** Max-Age of oa_ad_clids (90 days), Domain .openart.ai. */
  clickIdCookieMaxAgeSeconds: 7_776_000,
  endpoints: {
    adClickIds: '/api/user/ad-click-ids',
    stripeSubscription: '/api/stripe/subscription',
    checkoutSessionInvoice: '/legacy/api/stripe/checkout-session-invoice',
    creditLogs: '/suite/api/credits/logs',
    myInfo: '/suite/api/user/my-info',
    oneTimePackCheckout: '/suite/api/one-time-pack/checkout',
    updateCreditPack: '/api/stripe/update_credit_pack',
  },
} as const;
