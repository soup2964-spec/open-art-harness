import { describe, expect, it } from 'vitest';
import { KNOWN_EXAMPLE_SECRETS, LIVE_CONFIRMATION, UNKNOWN_REGION_ACK, demoConfig, loadConfig } from '../src/config.js';

const base = { STRIPE_WEBHOOK_SECRETS: 'whsec_test_a', INTERNAL_EVENTS_HMAC_SECRETS: 'k1-0123456789abcdef0123456789abcdef' };

const STRONG = { STRIPE_WEBHOOK_SECRETS: 'whsec_Zq3kP9vN2mX7wL4tR8yB1cD6fG0hJ5sA', INTERNAL_EVENTS_HMAC_SECRETS: 'Tq8Lw2Zp9Vx4Nc7Rb1Ym6Kd3Hs0Gf5Jt' };
const LIVE_BASE = { ...STRONG, CONVERSION_SERVICE_MODE: 'live', LIVE_CONFIRM: LIVE_CONFIRMATION };

describe('live mode refuses unsafe settings', () => {
  it('refuses short, wrongly prefixed, or documented example secrets', () => {
    const live = { ...LIVE_BASE, LIVE_PLATFORMS: 'meta' };
    expect(loadConfig(live).mode).toBe('live');
    expect(() => loadConfig({ ...live, STRIPE_WEBHOOK_SECRETS: 'whsec_short' })).toThrow(/STRIPE_WEBHOOK_SECRETS/);
    for (const example of ['whsec_local', 'whsec_offline_test_secret_not_a_real_key']) {
      expect(() => loadConfig({ ...live, STRIPE_WEBHOOK_SECRETS: example }), example).toThrow(/example|placeholder|too short/i);
    }
    for (const example of ['local-hmac-key-0123456789abcdef0123', 'offline-test-hmac-key-0123456789abcdef']) {
      expect(() => loadConfig({ ...live, INTERNAL_EVENTS_HMAC_SECRETS: example }), example).toThrow(/example|placeholder/i);
    }
    expect(KNOWN_EXAMPLE_SECRETS.has('whsec_local')).toBe(true);
    // Error messages name the variable, never the value.
    try {
      loadConfig({ ...live, INTERNAL_EVENTS_HMAC_SECRETS: 'local-hmac-key-0123456789abcdef0123' });
    } catch (err) {
      expect((err as Error).message).not.toContain('local-hmac-key');
    }
  });

  it('GOOGLE_VALIDATE_ONLY must be set explicitly when google_ads is live (never a silent default)', () => {
    const live = { ...LIVE_BASE, LIVE_PLATFORMS: 'google_ads' };
    expect(() => loadConfig(live)).toThrow(/GOOGLE_VALIDATE_ONLY/);
    expect(loadConfig({ ...live, GOOGLE_VALIDATE_ONLY: 'false' }).google.validateOnly).toBe(false);
    expect(loadConfig({ ...live, GOOGLE_VALIDATE_ONLY: 'true' }).google.validateOnly).toBe(true);
    // Dry-run keeps the harmless default (nothing is sent anyway).
    expect(loadConfig(base).google.validateOnly).toBe(true);
  });

  it('refuses an unsigned Pub/Sub path in live mode', () => {
    expect(() => loadConfig({ ...LIVE_BASE, LIVE_PLATFORMS: 'meta', PUBSUB_REQUIRE_STRIPE_SIGNATURE: 'false' })).toThrow(/PUBSUB_REQUIRE_STRIPE_SIGNATURE/);
  });
});

describe('loadConfig', () => {
  it('defaults to dry-run with every platform dry-run and nothing live', () => {
    const c = loadConfig(base);
    expect(c.mode).toBe('dry_run');
    expect([...c.livePlatforms]).toEqual([]);
    expect(c.google.adjustments).toBe('off');
    expect(c.google.multiSourceConfirmed).toBe(false);
    expect(c.reddit.dedupVerified).toBe(false);
    expect(c.consent.optOutHandling).toBe('drop');
  });

  it('live mode needs MODE=live, LIVE_PLATFORMS and the exact confirmation phrase', () => {
    expect(() => loadConfig({ ...base, CONVERSION_SERVICE_MODE: 'live' })).toThrow(/LIVE_PLATFORMS/);
    expect(() => loadConfig({ ...base, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta' })).toThrow(/LIVE_CONFIRM/);
    expect(() => loadConfig({ ...base, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta', LIVE_CONFIRM: 'yes' })).toThrow(/LIVE_CONFIRM/);
    const c = loadConfig({ ...STRONG, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta', LIVE_CONFIRM: LIVE_CONFIRMATION });
    expect(c.mode).toBe('live');
    expect([...c.livePlatforms]).toEqual(['meta']);
  });

  it('rejects LIVE_PLATFORMS outside dry-run guardrails (unknown names)', () => {
    expect(() => loadConfig({ ...base, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta,myspace', LIVE_CONFIRM: LIVE_CONFIRMATION })).toThrow(/myspace/);
  });

  it('parses web-fix flags with an effective-from time and only for rows that require a web fix', () => {
    const c = loadConfig({ ...base, WEB_FIXES_LIVE: 'signup:tiktok@2026-10-01T00:00:00Z, purchase_first:linkedin@2026-10-02T00:00:00Z' });
    expect(c.webFixesLive.get('signup:tiktok')).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(c.webFixesLive.get('purchase_first:linkedin')).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(() => loadConfig({ ...base, WEB_FIXES_LIVE: 'purchase_first:meta@2026-10-01T00:00:00Z' })).toThrow(/does not require a web fix/);
    expect(() => loadConfig({ ...base, WEB_FIXES_LIVE: 'signup:tiktok' })).toThrow(/@<RFC 3339/);
  });

  it('requires Stripe and internal-auth secrets, and refuses short HMAC keys', () => {
    expect(() => loadConfig({})).toThrow(/STRIPE_WEBHOOK_SECRETS/);
    expect(() => loadConfig({ ...base, INTERNAL_EVENTS_HMAC_SECRETS: 'short' })).toThrow(/32/);
  });

  it('parses Google destinations and flags', () => {
    const c = loadConfig({
      ...base,
      GOOGLE_ADS_OPERATING_ACCOUNT_ID: '1234567890',
      GOOGLE_ADS_CONVERSION_ACTIONS: '{"purchase_first":"111","purchase_renewal":"222"}',
      GOOGLE_MULTI_SOURCE_CONFIRMED: 'true',
      GOOGLE_ADJUSTMENTS: 'data_manager_restatement',
    });
    expect(c.google).toMatchObject({ operatingAccountId: '1234567890', multiSourceConfirmed: true, adjustments: 'data_manager_restatement' });
    expect(c.google.conversionActions).toEqual({ purchase_first: '111', purchase_renewal: '222' });
    expect(() => loadConfig({ ...base, GOOGLE_ADS_OPERATING_ACCOUNT_ID: '123-456-7890' })).toThrow(/10-digit/);
    expect(() => loadConfig({ ...base, GOOGLE_ADS_CONVERSION_ACTIONS: '{"not_an_event":"1"}' })).toThrow();
  });

  it('PUBSUB_REQUIRE_STRIPE_SIGNATURE defaults to true', () => {
    expect(loadConfig(base).pubsubRequireStripeSignature).toBe(true);
    expect(loadConfig({ ...base, PUBSUB_REQUIRE_STRIPE_SIGNATURE: 'false' }).pubsubRequireStripeSignature).toBe(false);
  });

  it('STRIPE_WEBHOOK_SECRETS entries must be Stripe endpoint secrets (whsec_ prefix)', () => {
    // A secret-key-shaped value (not an endpoint secret) must be rejected. Deliberately not a
    // real-looking key, so secret scanners don't flag the test file.
    expect(() => loadConfig({ ...base, STRIPE_WEBHOOK_SECRETS: 'not_a_webhook_secret_' + 'x'.repeat(32) })).toThrow(/whsec_/);
  });

  it('CONSENT_UNKNOWN_REGION=allow needs an explicit acknowledgement', () => {
    expect(() => loadConfig({ ...base, CONSENT_UNKNOWN_REGION: 'allow' })).toThrow(/CONSENT_UNKNOWN_REGION_ACK/);
    expect(() => loadConfig({ ...base, CONSENT_UNKNOWN_REGION: 'allow', CONSENT_UNKNOWN_REGION_ACK: 'yes' })).toThrow(/CONSENT_UNKNOWN_REGION_ACK/);
    expect(loadConfig({ ...base, CONSENT_UNKNOWN_REGION: 'allow', CONSENT_UNKNOWN_REGION_ACK: UNKNOWN_REGION_ACK }).consent.unknownRegion).toBe('allow');
    expect(loadConfig(base).consent.unknownRegion).toBe('block');
  });

  it('Stripe livemode: dry-run accepts any event; live mode only livemode=true events and refuses anything else', () => {
    expect(loadConfig(base).stripe.livemode).toBe('any');
    const live = { ...LIVE_BASE, LIVE_PLATFORMS: 'meta' };
    expect(loadConfig(live).stripe.livemode).toBe('live');
    expect(() => loadConfig({ ...live, STRIPE_LIVEMODE: 'test' })).toThrow(/STRIPE_LIVEMODE/);
    expect(() => loadConfig({ ...live, STRIPE_LIVEMODE: 'any' })).toThrow(/STRIPE_LIVEMODE/);
    expect(loadConfig({ ...base, STRIPE_LIVEMODE: 'test' }).stripe.livemode).toBe('test');
  });

  it('value settings: purchase-time score SLA, reporting currency and static FX rates', () => {
    const c = loadConfig(base);
    expect(c.value).toMatchObject({ floorMajor: 0.01, reportingCurrency: 'USD', scoreSlaMs: 600_000 });
    const fx = loadConfig({ ...base, FX_RATES_TO_REPORTING: '{"EUR":1.08,"GBP":1.27}', VALUE_SCORE_SLA_MS: '120000' });
    expect(fx.value.fxRatesToReporting).toEqual({ EUR: 1.08, GBP: 1.27 });
    expect(fx.value.scoreSlaMs).toBe(120_000);
    expect(() => loadConfig({ ...base, FX_RATES_TO_REPORTING: '{"eur":1}' })).toThrow(/FX_RATES_TO_REPORTING/);
    expect(() => loadConfig({ ...base, FX_RATES_TO_REPORTING: '{"EUR":-1}' })).toThrow(/FX_RATES_TO_REPORTING/);
  });

  it('demoConfig is dry-run and carries only clearly synthetic destination ids', () => {
    const c = demoConfig('/tmp/out');
    expect(c.mode).toBe('dry_run');
    expect(c.google.operatingAccountId).toBe('1000000000');
    expect(Object.values(c.linkedin.conversionRules).every((v) => /^urn:lla:llaPartnerConversion:9\d+$/.test(v!))).toBe(true);
  });
});
