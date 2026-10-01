/**
 * Service configuration from environment variables.
 *
 * Safety: the service is DRY-RUN unless all three are set:
 *   CONVERSION_SERVICE_MODE=live
 *   LIVE_PLATFORMS=<comma list>          (only these platforms go live; the rest stay dry-run)
 *   LIVE_CONFIRM=send-real-conversions-to-ad-platforms
 * Live mode also refuses: example/placeholder/short secrets, an implicit GOOGLE_VALIDATE_ONLY when
 * google_ads is live, an unsigned Pub/Sub path, and any Stripe livemode other than live. Storage
 * (Firestore + BigQuery required) is checked by wiring.assertLiveStorage; platform credentials by
 * live.assertLiveCredentials.
 */

import { CANONICAL_EVENT_NAMES, OPENART, PLATFORMS, getPlatformMapping } from '@openart-signal/contracts';
import type { CanonicalEventName, Platform } from '@openart-signal/contracts';
import { DEFAULT_CONSENT_POLICY } from './adapters/consent-resolver.js';
import type { ConsentPolicy } from './adapters/consent-resolver.js';

export const LIVE_CONFIRMATION = 'send-real-conversions-to-ad-platforms';

/** CONSENT_UNKNOWN_REGION=allow sends users whose country is unknown without a consent check; it needs this exact ack. */
export const UNKNOWN_REGION_ACK = 'send-unknown-region-users-without-a-consent-check';

/** Secrets that appear in this repo's README, Dockerfile or tests. Live mode refuses them. */
export const KNOWN_EXAMPLE_SECRETS: ReadonlySet<string> = new Set([
  'whsec_local',
  'whsec_test_a',
  'whsec_offline_test_secret_not_a_real_key',
  'local-hmac-key-0123456789abcdef0123',
  'offline-test-hmac-key-0123456789abcdef',
  'k1-0123456789abcdef0123456789abcdef',
]);

/** Markers of a value someone typed as a placeholder (not a random secret). */
export const PLACEHOLDER_SECRET = /(example|changeme|change-me|change_me|placeholder|not[_-]a[_-]real|dummy|replace[_-]?me|your[_-]token|0123456789)/i;

/** Throws (naming the variable, never the value) unless a live secret looks real. */
export function assertLiveSecret(name: string, value: string, minLength: number): void {
  if (KNOWN_EXAMPLE_SECRETS.has(value) || PLACEHOLDER_SECRET.test(value)) {
    throw new Error(`${name}: an example or placeholder value is not allowed in live mode`);
  }
  if (value.length < minLength) throw new Error(`${name}: too short for live mode (at least ${minLength} characters)`);
}

export type Mode = 'dry_run' | 'live';

export interface OutboxSettings {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  leaseMs: number;
  /** Claimed records' leases are renewed this often while a drain is still sending. */
  leaseRenewMs: number;
  /** Records a drain evaluates concurrently (Firestore round trips overlap). */
  claimConcurrency: number;
  /** Max time a request handler spends draining after ingest before returning. */
  drainBudgetMs: number;
}

export interface ServiceConfig {
  mode: Mode;
  livePlatforms: ReadonlySet<Platform>;
  /** Per-platform kill switch (e.g. a destination OpenArt's own backend already feeds). */
  enabledPlatforms: ReadonlySet<Platform>;
  dryRunOutDir: string;
  port: number;
  maxBodyBytes: number;
  stripe: {
    webhookSecrets: string[];
    toleranceSeconds: number;
    pubsubToleranceSeconds: number;
    /** Which Stripe events count: live mode accepts only livemode=true (a test purchase never reaches an ad platform). */
    livemode: 'live' | 'test' | 'any';
  };
  internalAuth: { hmacSecrets: string[]; toleranceSeconds: number };
  /** OIDC push auth (Pub/Sub push, Cloud Scheduler). null = those routes accept only the internal HMAC. */
  oidc: { audience: string; pubsubServiceAccount: string | null; schedulerServiceAccount: string | null } | null;
  /** After an ingest request: drain in the background (async), before responding (sync), or not at all. */
  drainAfterIngest: 'async' | 'sync' | 'off';
  /**
   * Pub/Sub path: require the forwarded Stripe-Signature attribute (their handler publishes raw body +
   * header). Default true; live mode refuses false (an unsigned push would let anyone who can publish
   * to the topic inject purchases).
   */
  pubsubRequireStripeSignature: boolean;
  consent: ConsentPolicy;
  /** `${canonical_event}:${platform}` -> ms from which the browser tag sends the dedup id. */
  webFixesLive: ReadonlyMap<string, number>;
  leadConversionStages: string[];
  eventSourceUrls: Record<CanonicalEventName, string>;
  outbox: OutboxSettings;
  parking: {
    maxParkMs: number;
    /** A parked event whose replay keeps failing is dead-lettered after this many sweeps. */
    maxSweepAttempts: number;
  };
  /**
   * Conversion values (see README "Value"). Ad platforms receive the PURCHASE-TIME conditional estimate
   * PurchaseValueScore.predicted_profit_90d = E[gross_profit_90d | purchase] for acquisition purchases,
   * else cash. Never the signup+24h PredictedProfit (that estimand is for experiment readouts).
   */
  value: {
    /** Floor for predicted values, in the reporting currency. Sending it is recorded (value_floored). */
    floorMajor: number;
    reportingCurrency: string;
    /** A score counts as purchase-time only if scored within this long after the purchase. */
    scoreSlaMs: number;
    /** How often a send held for its score is re-checked while the SLA runs. */
    recheckMs: number;
    /** Static FX: units of the reporting currency per 1 unit of each currency. */
    fxRatesToReporting: Record<string, number>;
  };
  google: {
    operatingAccountId: string | null;
    loginAccountId: string | null;
    conversionActions: Partial<Record<CanonicalEventName, string>>;
    multiSourceConfirmed: boolean;
    adjustments: 'off' | 'data_manager_restatement';
    validateOnly: boolean;
  };
  meta: { pixelId: string; apiVersion: string; testEventCode: string | null };
  tiktok: { pixelCode: string; testEventCode: string | null };
  reddit: { pixelId: string; conversionIdMode: 'pixel_sha256' | 'plaintext'; dedupVerified: boolean; testId: string | null; userAgent: string };
  linkedin: { version: string; conversionRules: Partial<Record<CanonicalEventName, string>> };
  x: { pixelId: string; eventIds: Partial<Record<CanonicalEventName, string>> };
  microsoft: {
    tagId: string;
    /** UET Conversions API (staged rollout), or offline conversion import for server-only goals. */
    sendMode: 'uet_capi' | 'offline_conversions';
    adjustments: 'off' | 'online_conversion_adjustments';
    customerId: string | null;
    accountId: string | null;
    conversionGoals: Partial<Record<CanonicalEventName, string>>;
  };
}

export type Env = Record<string, string | undefined>;

export const DEFAULT_EVENT_SOURCE_URLS: Record<CanonicalEventName, string> = {
  signup: 'https://openart.ai/',
  activation_first_generation: 'https://openart.ai/suite',
  checkout_started: 'https://openart.ai/pricing',
  // The success page without its query string (the real one carries uid=).
  purchase_first: 'https://openart.ai/suite/subscriptions',
  purchase_renewal: 'https://openart.ai/suite/subscriptions',
  purchase_upgrade: 'https://openart.ai/suite/subscriptions',
  purchase_add_on: 'https://openart.ai/suite/subscriptions',
  purchase_one_time_pack: 'https://openart.ai/suite/subscriptions',
  refund: 'https://openart.ai/suite/subscriptions',
  chargeback: 'https://openart.ai/suite/subscriptions',
  enterprise_lead: 'https://openart.ai/enterprise',
  lead_stage_change: 'https://openart.ai/enterprise',
};

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function platforms(value: string | undefined, name: string, fallback: readonly Platform[]): Set<Platform> {
  const items = value === undefined ? [...fallback] : list(value);
  for (const p of items) if (!(PLATFORMS as readonly string[]).includes(p)) throw new Error(`${name}: unknown platform "${p}"`);
  return new Set(items as Platform[]);
}

function bool(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function int(value: string | undefined, name: string, fallback: number, min = 0): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function oneOf<T extends string>(value: string | undefined, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function fxRates(value: string | undefined): Record<string, number> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('FX_RATES_TO_REPORTING must be a JSON object like {"EUR":1.08}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('FX_RATES_TO_REPORTING must be a JSON object like {"EUR":1.08}');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^[A-Z]{3}$/.test(k)) throw new Error(`FX_RATES_TO_REPORTING: "${k}" is not an upper-case ISO 4217 code`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`FX_RATES_TO_REPORTING.${k} must be a positive number`);
    out[k] = v;
  }
  return out;
}

function eventMap(value: string | undefined, name: string, valuePattern: RegExp): Partial<Record<CanonicalEventName, string>> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
  const out: Partial<Record<CanonicalEventName, string>> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!(CANONICAL_EVENT_NAMES as readonly string[]).includes(k)) throw new Error(`${name}: unknown canonical event "${k}"`);
    if (typeof v !== 'string' || !valuePattern.test(v)) throw new Error(`${name}.${k}: invalid value`);
    out[k as CanonicalEventName] = v;
  }
  return out;
}

function webFixes(value: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of list(value)) {
    const m = /^([a-z_]+):([a-z_]+)@(.+)$/.exec(item);
    if (!m) throw new Error(`WEB_FIXES_LIVE: "${item}" must be <canonical_event>:<platform>@<RFC 3339 time>`);
    const [, event, platform, at] = m as unknown as [string, string, string, string];
    if (!(CANONICAL_EVENT_NAMES as readonly string[]).includes(event)) throw new Error(`WEB_FIXES_LIVE: unknown event "${event}"`);
    if (!(PLATFORMS as readonly string[]).includes(platform)) throw new Error(`WEB_FIXES_LIVE: unknown platform "${platform}"`);
    if (!getPlatformMapping(event as CanonicalEventName, platform as Platform).requires_web_fix) {
      throw new Error(`WEB_FIXES_LIVE: ${event}:${platform} does not require a web fix`);
    }
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) throw new Error(`WEB_FIXES_LIVE: "${at}" is not an RFC 3339 time`);
    out.set(`${event}:${platform}`, ms);
  }
  return out;
}

export function loadConfig(env: Env): ServiceConfig {
  const mode = oneOf(env.CONVERSION_SERVICE_MODE, 'CONVERSION_SERVICE_MODE', ['dry_run', 'live'] as const, 'dry_run');
  let livePlatforms = new Set<Platform>();
  if (mode === 'live') {
    livePlatforms = platforms(env.LIVE_PLATFORMS ?? '', 'LIVE_PLATFORMS', []);
    if (livePlatforms.size === 0) throw new Error('live mode needs LIVE_PLATFORMS (comma list of platforms to send for real)');
    if (env.LIVE_CONFIRM !== LIVE_CONFIRMATION) throw new Error(`live mode needs LIVE_CONFIRM=${LIVE_CONFIRMATION}`);
  }

  const stripeSecrets = list(env.STRIPE_WEBHOOK_SECRETS);
  if (stripeSecrets.length === 0) throw new Error('STRIPE_WEBHOOK_SECRETS is required (comma list, current secret first)');
  if (stripeSecrets.some((s) => !s.startsWith('whsec_'))) throw new Error('STRIPE_WEBHOOK_SECRETS entries must be Stripe endpoint signing secrets (whsec_...)');
  const hmacSecrets = list(env.INTERNAL_EVENTS_HMAC_SECRETS);
  if (hmacSecrets.length === 0) throw new Error('INTERNAL_EVENTS_HMAC_SECRETS is required');
  if (hmacSecrets.some((s) => s.length < 32)) throw new Error('INTERNAL_EVENTS_HMAC_SECRETS entries must be at least 32 characters');
  if (mode === 'live') {
    for (const s of stripeSecrets) assertLiveSecret('STRIPE_WEBHOOK_SECRETS', s, 32);
    for (const s of hmacSecrets) assertLiveSecret('INTERNAL_EVENTS_HMAC_SECRETS', s, 32);
  }

  const validateOnlyRaw = env.GOOGLE_VALIDATE_ONLY;
  if (mode === 'live' && livePlatforms.has('google_ads') && (validateOnlyRaw === undefined || validateOnlyRaw === '')) {
    throw new Error('GOOGLE_VALIDATE_ONLY must be set explicitly (true = validate only, false = record conversions) when google_ads is live');
  }
  const pubsubRequireStripeSignature = bool(env.PUBSUB_REQUIRE_STRIPE_SIGNATURE, 'PUBSUB_REQUIRE_STRIPE_SIGNATURE', true);
  if (mode === 'live' && !pubsubRequireStripeSignature) throw new Error('PUBSUB_REQUIRE_STRIPE_SIGNATURE=false is not allowed in live mode');
  const livemode = oneOf(env.STRIPE_LIVEMODE, 'STRIPE_LIVEMODE', ['live', 'test', 'any'] as const, mode === 'live' ? 'live' : 'any');
  if (mode === 'live' && livemode !== 'live') throw new Error('STRIPE_LIVEMODE must be live in live mode (test-mode purchases never go to ad platforms)');
  const unknownRegion = oneOf(env.CONSENT_UNKNOWN_REGION, 'CONSENT_UNKNOWN_REGION', ['block', 'allow'] as const, 'block');
  if (unknownRegion === 'allow' && env.CONSENT_UNKNOWN_REGION_ACK !== UNKNOWN_REGION_ACK) {
    throw new Error(`CONSENT_UNKNOWN_REGION=allow needs CONSENT_UNKNOWN_REGION_ACK=${UNKNOWN_REGION_ACK}`);
  }
  const reportingCurrency = env.REPORTING_CURRENCY ?? 'USD';
  if (!/^[A-Z]{3}$/.test(reportingCurrency)) throw new Error('REPORTING_CURRENCY must be an upper-case ISO 4217 code');

  const operatingAccountId = env.GOOGLE_ADS_OPERATING_ACCOUNT_ID ?? null;
  if (operatingAccountId !== null && !/^\d{10}$/.test(operatingAccountId)) throw new Error('GOOGLE_ADS_OPERATING_ACCOUNT_ID must be the 10-digit customer id without hyphens');
  const loginAccountId = env.GOOGLE_ADS_LOGIN_ACCOUNT_ID ?? null;
  if (loginAccountId !== null && !/^\d{10}$/.test(loginAccountId)) throw new Error('GOOGLE_ADS_LOGIN_ACCOUNT_ID must be a 10-digit customer id without hyphens');

  const oidcAudience = env.OIDC_AUDIENCE;

  const urls = { ...DEFAULT_EVENT_SOURCE_URLS };
  for (const [k, v] of Object.entries(eventMap(env.EVENT_SOURCE_URLS, 'EVENT_SOURCE_URLS', /^https:\/\/[^\s?#]+$/))) {
    urls[k as CanonicalEventName] = v;
  }

  const floor = env.VALUE_FLOOR_USD === undefined ? 0.01 : Number(env.VALUE_FLOOR_USD);
  if (!(floor > 0) || !Number.isFinite(floor)) throw new Error('VALUE_FLOOR_USD must be > 0');
  const leaseMs = int(env.OUTBOX_LEASE_MS, 'OUTBOX_LEASE_MS', 120_000, 1_000);

  return {
    mode,
    livePlatforms,
    enabledPlatforms: platforms(env.ENABLED_PLATFORMS, 'ENABLED_PLATFORMS', PLATFORMS),
    dryRunOutDir: env.DRY_RUN_OUT_DIR ?? '/tmp/conversion-service-dry-run',
    port: int(env.PORT, 'PORT', 8080, 1),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 'MAX_BODY_BYTES', 1_048_576, 1024),
    stripe: {
      webhookSecrets: stripeSecrets,
      toleranceSeconds: int(env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 'STRIPE_WEBHOOK_TOLERANCE_SECONDS', 300, 1),
      // Pub/Sub redelivers for days; the forwarded signature is still checked, with Stripe's 3-day retry horizon.
      pubsubToleranceSeconds: int(env.STRIPE_PUBSUB_TOLERANCE_SECONDS, 'STRIPE_PUBSUB_TOLERANCE_SECONDS', 4 * 86_400, 1),
      livemode,
    },
    internalAuth: { hmacSecrets, toleranceSeconds: int(env.INTERNAL_EVENTS_TOLERANCE_SECONDS, 'INTERNAL_EVENTS_TOLERANCE_SECONDS', 300, 1) },
    oidc: oidcAudience
      ? { audience: oidcAudience, pubsubServiceAccount: env.PUBSUB_PUSH_SERVICE_ACCOUNT ?? null, schedulerServiceAccount: env.SCHEDULER_SERVICE_ACCOUNT ?? null }
      : null,
    drainAfterIngest: oneOf(env.OUTBOX_DRAIN_AFTER_INGEST, 'OUTBOX_DRAIN_AFTER_INGEST', ['async', 'sync', 'off'] as const, 'async'),
    pubsubRequireStripeSignature,
    consent: {
      ...DEFAULT_CONSENT_POLICY,
      optOutHandling: oneOf(env.CONSENT_OPT_OUT_HANDLING, 'CONSENT_OPT_OUT_HANDLING', ['drop', 'restrict'] as const, 'drop'),
      unknownRegion,
    },
    webFixesLive: webFixes(env.WEB_FIXES_LIVE),
    value: {
      floorMajor: floor,
      reportingCurrency,
      scoreSlaMs: int(env.VALUE_SCORE_SLA_MS, 'VALUE_SCORE_SLA_MS', 600_000, 0),
      recheckMs: int(env.VALUE_SCORE_RECHECK_MS, 'VALUE_SCORE_RECHECK_MS', 60_000, 1_000),
      fxRatesToReporting: fxRates(env.FX_RATES_TO_REPORTING),
    },
    leadConversionStages: env.LEAD_CONVERSION_STAGES ? list(env.LEAD_CONVERSION_STAGES) : ['salesqualifiedlead'],
    eventSourceUrls: urls,
    outbox: {
      maxAttempts: int(env.OUTBOX_MAX_ATTEMPTS, 'OUTBOX_MAX_ATTEMPTS', 8, 1),
      baseBackoffMs: int(env.OUTBOX_BASE_BACKOFF_MS, 'OUTBOX_BASE_BACKOFF_MS', 30_000, 1),
      maxBackoffMs: int(env.OUTBOX_MAX_BACKOFF_MS, 'OUTBOX_MAX_BACKOFF_MS', 3_600_000, 1),
      leaseMs,
      leaseRenewMs: int(env.OUTBOX_LEASE_RENEW_MS, 'OUTBOX_LEASE_RENEW_MS', Math.floor(leaseMs / 3), 100),
      claimConcurrency: int(env.OUTBOX_CLAIM_CONCURRENCY, 'OUTBOX_CLAIM_CONCURRENCY', 8, 1),
      drainBudgetMs: int(env.OUTBOX_DRAIN_BUDGET_MS, 'OUTBOX_DRAIN_BUDGET_MS', 8_000, 0),
    },
    parking: {
      maxParkMs: int(env.PARKING_MAX_MS, 'PARKING_MAX_MS', 6 * 3_600_000, 60_000),
      maxSweepAttempts: int(env.PARKING_MAX_SWEEP_ATTEMPTS, 'PARKING_MAX_SWEEP_ATTEMPTS', 5, 1),
    },
    google: {
      operatingAccountId,
      loginAccountId,
      conversionActions: eventMap(env.GOOGLE_ADS_CONVERSION_ACTIONS, 'GOOGLE_ADS_CONVERSION_ACTIONS', /^\d{1,20}$/),
      multiSourceConfirmed: bool(env.GOOGLE_MULTI_SOURCE_CONFIRMED, 'GOOGLE_MULTI_SOURCE_CONFIRMED', false),
      adjustments: oneOf(env.GOOGLE_ADJUSTMENTS, 'GOOGLE_ADJUSTMENTS', ['off', 'data_manager_restatement'] as const, 'off'),
      // Dry-run default true (harmless: nothing is sent). Live google_ads requires an explicit value (checked above).
      validateOnly: bool(validateOnlyRaw, 'GOOGLE_VALIDATE_ONLY', true),
    },
    meta: {
      pixelId: env.META_PIXEL_ID ?? OPENART.meta.pixelId,
      apiVersion: env.META_API_VERSION ?? 'v26.0',
      testEventCode: env.META_TEST_EVENT_CODE ?? null,
    },
    tiktok: { pixelCode: env.TIKTOK_PIXEL_CODE ?? OPENART.tiktok.pixelCode, testEventCode: env.TIKTOK_TEST_EVENT_CODE ?? null },
    reddit: {
      pixelId: env.REDDIT_PIXEL_ID ?? OPENART.reddit.pixelId,
      conversionIdMode: oneOf(env.REDDIT_CONVERSION_ID_MODE, 'REDDIT_CONVERSION_ID_MODE', ['pixel_sha256', 'plaintext'] as const, 'pixel_sha256'),
      dedupVerified: bool(env.REDDIT_DEDUP_VERIFIED, 'REDDIT_DEDUP_VERIFIED', false),
      testId: env.REDDIT_TEST_ID ?? null,
      userAgent: env.REDDIT_USER_AGENT ?? 'server:openart-signal-conversion-service:0.1.0',
    },
    linkedin: {
      version: env.LINKEDIN_VERSION ?? '202609',
      conversionRules: eventMap(env.LINKEDIN_CONVERSION_RULES, 'LINKEDIN_CONVERSION_RULES', /^urn:lla:llaPartnerConversion:\d+$/),
    },
    x: {
      pixelId: env.X_PIXEL_ID ?? OPENART.x.pixelId,
      eventIds: {
        signup: OPENART.x.eventIds.signup,
        purchase_first: OPENART.x.eventIds.purchase,
        ...eventMap(env.X_EVENT_IDS, 'X_EVENT_IDS', /^[a-z0-9-]{3,64}$/),
      },
    },
    microsoft: {
      tagId: env.UET_TAG_ID ?? OPENART.microsoft.uetTagId,
      sendMode: oneOf(env.MICROSOFT_SEND_MODE, 'MICROSOFT_SEND_MODE', ['uet_capi', 'offline_conversions'] as const, 'uet_capi'),
      adjustments: oneOf(env.MICROSOFT_ADJUSTMENTS, 'MICROSOFT_ADJUSTMENTS', ['off', 'online_conversion_adjustments'] as const, 'off'),
      customerId: env.MICROSOFT_ADS_CUSTOMER_ID ?? null,
      accountId: env.MICROSOFT_ADS_ACCOUNT_ID ?? null,
      conversionGoals: eventMap(env.MICROSOFT_CONVERSION_GOALS, 'MICROSOFT_CONVERSION_GOALS', /^.{1,100}$/),
    },
  };
}

/**
 * Local/test configuration. Every destination id below that is not public OpenArt
 * configuration (pixel ids, X event ids, UET tag) is SYNTHETIC: Google customer 1000000000,
 * conversion actions 9000000001..., LinkedIn rules 9000001..., Microsoft account ids.
 */
export function demoConfig(dryRunOutDir: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const base = loadConfig({
    STRIPE_WEBHOOK_SECRETS: 'whsec_offline_test_secret_not_a_real_key',
    INTERNAL_EVENTS_HMAC_SECRETS: 'offline-test-hmac-key-0123456789abcdef',
    DRY_RUN_OUT_DIR: dryRunOutDir,
    GOOGLE_ADS_OPERATING_ACCOUNT_ID: '1000000000',
    GOOGLE_ADS_CONVERSION_ACTIONS: JSON.stringify(
      Object.fromEntries(CANONICAL_EVENT_NAMES.filter((e) => e !== 'refund' && e !== 'chargeback').map((e, i) => [e, String(9000000001 + i)])),
    ),
    LINKEDIN_CONVERSION_RULES: JSON.stringify({
      signup: 'urn:lla:llaPartnerConversion:9000001',
      purchase_first: 'urn:lla:llaPartnerConversion:9000002',
      enterprise_lead: 'urn:lla:llaPartnerConversion:9000003',
      lead_stage_change: 'urn:lla:llaPartnerConversion:9000004',
    }),
    MICROSOFT_ADS_CUSTOMER_ID: '100000001',
    MICROSOFT_ADS_ACCOUNT_ID: '100000002',
    MICROSOFT_CONVERSION_GOALS: JSON.stringify({
      purchase_first: 'purchase',
      purchase_renewal: 'purchase_renewal',
      purchase_upgrade: 'purchase_upgrade',
      purchase_add_on: 'purchase_add_on',
      purchase_one_time_pack: 'purchase_one_time_pack',
    }),
  });
  return { ...base, ...overrides };
}

export { RETENTION } from './retention.js';
