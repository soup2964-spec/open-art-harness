import { describe, expect, it } from 'vitest';
import { LIVE_CONFIRMATION, loadConfig } from '../src/config.js';
import { EnvAuthProvider, assertLiveCredentials, authKindsFor } from '../src/live.js';
import type { PlatformRequest } from '../src/platforms/types.js';
import { assertLiveStorage, loadStorageConfig } from '../src/wiring.js';

const base = { STRIPE_WEBHOOK_SECRETS: 'whsec_test_a', INTERNAL_EVENTS_HMAC_SECRETS: 'k1-0123456789abcdef0123456789abcdef' };
const STRONG = { STRIPE_WEBHOOK_SECRETS: 'whsec_Zq3kP9vN2mX7wL4tR8yB1cD6fG0hJ5sA', INTERNAL_EVENTS_HMAC_SECRETS: 'Tq8Lw2Zp9Vx4Nc7Rb1Ym6Kd3Hs0Gf5Jt' };
const req = (auth: PlatformRequest['auth'], url = 'https://example.invalid/path'): PlatformRequest => ({ platform: 'meta', action: 'SEND', method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: {}, auth, validationOnly: false });
const SECRETS: Record<string, string> = {
  META_CAPI_ACCESS_TOKEN: 'EAAsynthMetaSystemUserToken0000000001',
  TIKTOK_EVENTS_ACCESS_TOKEN: 'synthTikTokEventsToken000000000000001',
  REDDIT_CONVERSION_ACCESS_TOKEN: 'synthRedditConversionToken000000001',
  LINKEDIN_ACCESS_TOKEN: 'synthLinkedInMemberToken0000000000001',
  X_CONSUMER_KEY: 'synthXConsumerKey0000001',
  X_CONSUMER_SECRET: 'synthXConsumerSecret000000000000000001',
  X_ACCESS_TOKEN: 'synthXAccessToken000000000000001',
  X_ACCESS_TOKEN_SECRET: 'synthXAccessTokenSecret0000000000001',
  MICROSOFT_UET_CAPI_TOKEN: 'synthUetCapiToken00000000000000001',
  MICROSOFT_ADS_ACCESS_TOKEN: 'synthMicrosoftAdsAccessToken000001',
  MICROSOFT_ADS_DEVELOPER_TOKEN: 'synthMsDeveloperToken0001',
};

describe('live credentials (never exercised against a platform)', () => {
  const provider = new EnvAuthProvider((n) => SECRETS[n], async () => 'google-token');

  it('puts each credential where the platform documents it', async () => {
    expect(await provider.apply(req('google_oauth'))).toMatchObject({ headers: { Authorization: 'Bearer google-token' } });
    // Meta: the token travels in the Authorization header, never in the URL (URLs end up in logs and proxies).
    const meta = await provider.apply(req('meta_access_token', 'https://graph.facebook.com/v26.0/1/events'));
    expect(meta.url).toBe('https://graph.facebook.com/v26.0/1/events');
    expect(meta.headers.Authorization).toBe(`Bearer ${SECRETS.META_CAPI_ACCESS_TOKEN}`);
    expect(await provider.apply(req('tiktok_access_token'))).toMatchObject({ headers: { 'Access-Token': SECRETS.TIKTOK_EVENTS_ACCESS_TOKEN } });
    expect(await provider.apply(req('reddit_bearer'))).toMatchObject({ headers: { Authorization: `Bearer ${SECRETS.REDDIT_CONVERSION_ACCESS_TOKEN}` } });
    expect(await provider.apply(req('linkedin_bearer'))).toMatchObject({ headers: { Authorization: `Bearer ${SECRETS.LINKEDIN_ACCESS_TOKEN}` } });
    expect((await provider.apply(req('x_oauth1'))).headers.Authorization).toMatch(/^OAuth oauth_consumer_key="synthXConsumerKey0000001", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="synthXAccessToken000000000000001", oauth_version="1.0"$/);
    expect(await provider.apply(req('microsoft_uet_bearer'))).toMatchObject({ headers: { Authorization: `Bearer ${SECRETS.MICROSOFT_UET_CAPI_TOKEN}` } });
    expect(await provider.apply(req('microsoft_ads_api'))).toMatchObject({ headers: { Authorization: `Bearer ${SECRETS.MICROSOFT_ADS_ACCESS_TOKEN}`, DeveloperToken: SECRETS.MICROSOFT_ADS_DEVELOPER_TOKEN } });
  });

  it('a missing secret fails the request (by name, without values)', async () => {
    const empty = new EnvAuthProvider(() => undefined, async () => 'g');
    await expect(empty.apply(req('reddit_bearer'))).rejects.toThrow('missing REDDIT_CONVERSION_ACCESS_TOKEN');
  });

  it('startup refuses placeholder or implausibly short platform credentials (by name, never by value)', () => {
    const config = loadConfig({ ...STRONG, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta', LIVE_CONFIRM: LIVE_CONFIRMATION });
    expect(() => assertLiveCredentials(config, (n) => (n === 'META_CAPI_ACCESS_TOKEN' ? 'changeme' : SECRETS[n]))).toThrow(/META_CAPI_ACCESS_TOKEN/);
    expect(() => assertLiveCredentials(config, (n) => (n === 'META_CAPI_ACCESS_TOKEN' ? 'abc' : SECRETS[n]))).toThrow(/META_CAPI_ACCESS_TOKEN/);
    try {
      assertLiveCredentials(config, (n) => (n === 'META_CAPI_ACCESS_TOKEN' ? 'changeme' : SECRETS[n]));
    } catch (err) {
      expect((err as Error).message).not.toContain('changeme');
    }
  });

  it('startup refuses live platforms without credentials and lists what is missing', () => {
    const config = loadConfig({ ...STRONG, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta,x', LIVE_CONFIRM: LIVE_CONFIRMATION });
    expect(() => assertLiveCredentials(config, () => undefined)).toThrow('live mode is missing credentials: meta:META_CAPI_ACCESS_TOKEN, x:X_CONSUMER_KEY, x:X_CONSUMER_SECRET, x:X_ACCESS_TOKEN, x:X_ACCESS_TOKEN_SECRET');
    expect(() => assertLiveCredentials(config, (n) => SECRETS[n])).not.toThrow();
  });

  it('Microsoft adjustments add the Ads API credentials to the requirement', () => {
    const config = loadConfig({ ...base, MICROSOFT_ADJUSTMENTS: 'online_conversion_adjustments' });
    expect(authKindsFor('microsoft', config)).toEqual(['microsoft_uet_bearer', 'microsoft_ads_api']);
    expect(authKindsFor('microsoft', loadConfig({ ...base, MICROSOFT_SEND_MODE: 'offline_conversions' }))).toEqual(['microsoft_ads_api']);
  });
});

describe('live mode refuses in-memory storage', () => {
  const live = loadConfig({ ...STRONG, CONVERSION_SERVICE_MODE: 'live', LIVE_PLATFORMS: 'meta', LIVE_CONFIRM: LIVE_CONFIRMATION });
  const durable = { STORE_BACKEND: 'firestore', FIRESTORE_PROJECT_ID: 'oa-proj', LEDGER_BACKEND: 'bigquery', BIGQUERY_PROJECT_ID: 'oa-proj', BQ_LEDGER_TABLE: 'conversions.conversion_ledger_raw' };

  it('needs Firestore for the inbox/outbox and BigQuery for the ledger', () => {
    expect(() => assertLiveStorage(live, loadStorageConfig({}))).toThrow(/STORE_BACKEND=firestore/);
    expect(() => assertLiveStorage(live, loadStorageConfig({ ...durable, LEDGER_BACKEND: 'memory' }))).toThrow(/LEDGER_BACKEND=bigquery/);
    expect(() => assertLiveStorage(live, loadStorageConfig({ ...durable, LEDGER_BACKEND: 'file', LEDGER_FILE: '/tmp/l.jsonl' }))).toThrow(/LEDGER_BACKEND=bigquery/);
    expect(() => assertLiveStorage(live, loadStorageConfig(durable))).not.toThrow();
  });

  it('dry-run may run in memory', () => {
    expect(() => assertLiveStorage(loadConfig(base), loadStorageConfig({}))).not.toThrow();
  });
});

describe('storage wiring', () => {
  it('defaults to memory everywhere; validates backends and table names', () => {
    expect(loadStorageConfig({})).toMatchObject({ store: 'memory', ledger: 'memory', bigquery: null });
    expect(() => loadStorageConfig({ STORE_BACKEND: 'firestore' })).toThrow(/FIRESTORE_PROJECT_ID/);
    expect(() => loadStorageConfig({ LEDGER_BACKEND: 'bigquery', BIGQUERY_PROJECT_ID: 'oa-proj' })).toThrow(/BQ_LEDGER_TABLE/);
    expect(() => loadStorageConfig({ BQ_LEDGER_TABLE: 'conversions.conversion_ledger' })).toThrow(/BIGQUERY_PROJECT_ID/);
    expect(() => loadStorageConfig({ BIGQUERY_PROJECT_ID: 'oa-proj', BQ_LEDGER_TABLE: 'bad name' })).toThrow(/dataset/);
    expect(loadStorageConfig({ STORE_BACKEND: 'firestore', FIRESTORE_PROJECT_ID: 'oa-proj', LEDGER_BACKEND: 'bigquery', BIGQUERY_PROJECT_ID: 'oa-proj', BQ_LEDGER_TABLE: 'conversions.conversion_ledger' })).toMatchObject({
      store: 'firestore',
      firestore: { projectId: 'oa-proj', databaseId: '(default)' },
      tables: { ledger: { dataset: 'conversions', table: 'conversion_ledger' } },
    });
  });
});
