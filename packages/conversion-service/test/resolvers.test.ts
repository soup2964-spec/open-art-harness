import { describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent, PurchaseValueScore } from '@openart-signal/contracts';
import { REGULATED_COUNTRIES as EDGE_REGULATED } from '../../edge-attribution/src/core/consent.js';
import { BigQueryClickIdStoreReader, ClickIdResolver, InMemoryClickIdStore } from '../src/adapters/click-id-resolver.js';
import { CONSENT_REQUIRED_REGIONS } from '@openart-signal/contracts';
import { DEFAULT_CONSENT_POLICY, REGULATED_COUNTRIES, decidePlatformConsent, mergeConsentForSend, resolveRowConsent } from '../src/adapters/consent-resolver.js';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { FixedFxRates } from '../src/adapters/fx.js';
import { BigQueryPurchaseValueReader, InMemoryPurchaseValues, VALUE_DECISIONS, ValueResolver, valueInputOf } from '../src/adapters/value-resolver.js';
import { BigQueryUserContextReader, InMemoryUserContext } from '../src/adapters/user-context.js';
import { FakeBigQuery } from './helpers/fake-bigquery.js';
import { clickIdPayloads, goldenLedgerRows, predictedProfitRows, purchaseValueRows } from './helpers/fixtures.js';

const golden = goldenLedgerRows();
const g = (id: string) => structuredClone(golden.find((r) => r.event_id === id)!);
const bare = (row: ConversionLedgerEvent): ConversionLedgerEvent => ({ ...row, click_ids: {}, utm: {} });

describe('ClickIdResolver (reads the ad-click-ids store; builds fbc server-side)', () => {
  const { current, extended } = clickIdPayloads();

  it('fills click ids and UTMs from the stored record using the contracts converters', async () => {
    const store = new InMemoryClickIdStore({ SynthU01StarterMonA1: extended[0]! });
    const resolver = new ClickIdResolver(store);
    const purchase = bare(g('purchase_in_1SynthU01Inv0001First'));
    const out = await resolver.resolve(purchase, null);
    expect(out.click_ids).toEqual({
      gclid: { value: 'Cj0KCQjwSYNTHgclidU01', created_at: '2026-06-02T14:57:40.000Z' },
      gbraid: { value: '0AAAAASYNTHgbraidU01', created_at: '2026-06-02T14:57:40.000Z' },
    });
    expect(out.utm).toEqual({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'synth_search_brand' });
    expect(out.fbc).toBeNull();
  });

  it('builds fbc = fb.1.<fbclid_created_at_ms>.<fbclid> when the request carried no _fbc', async () => {
    const store = new InMemoryClickIdStore({ SynthU03PlusAddUpgC3: current[1]! });
    const resolver = new ClickIdResolver(store);
    const row = { ...bare(g('purchase_in_1SynthU03Inv0002AddOn')) };
    const out = await resolver.resolve(row, null);
    expect(out.fbc).toBe(`fb.1.${current[1]!.fbclid_created_at}.IwAR3SYNTHfbclidU03xYz`);
    expect(out.click_ids.ttclid?.value).toBe('E.CPSYNTHttclidU03.1718355480');
  });

  it('prefers the request _fbc cookie over a built one, and never hashes or edits the fbclid', async () => {
    const store = new InMemoryClickIdStore({ SynthU03PlusAddUpgC3: current[1]! });
    const out = await new ClickIdResolver(store).resolve(bare(g('purchase_in_1SynthU03Inv0002AddOn')), 'fb.1.1781400000000.IwAR3Cookie');
    expect(out.fbc).toBe('fb.1.1781400000000.IwAR3Cookie');
  });

  it('never attributes a conversion to a click stored AFTER it, or older than the 90-day store lifetime', async () => {
    const late = { gclid: 'LATEgclid', gclid_created_at: Date.parse('2026-06-04T00:00:00Z') };
    const ancient = { fbclid: 'OLDfbclid', fbclid_created_at: Date.parse('2026-02-01T00:00:00Z') };
    const store = new InMemoryClickIdStore({ SynthU01StarterMonA1: { ...late, ...ancient } });
    const out = await new ClickIdResolver(store).resolve(bare(g('purchase_in_1SynthU01Inv0001First')), null);
    expect(out.click_ids).toEqual({});
    expect(out.fbc).toBeNull();
  });

  it("keeps the row's own click ids (e.g. the lead form gclid) over stored ones", async () => {
    const lead = g('lead_6f1d2c3b-0000-4000-8000-00000000a001');
    const out = await new ClickIdResolver(new InMemoryClickIdStore({})).resolve(lead, null);
    expect(out.click_ids).toEqual(lead.click_ids);
  });

  it('BigQuery reader: parameterised lookup of the latest record, validated with the contracts schema', async () => {
    const bq = new FakeBigQuery();
    bq.queryResults.push([{ record: JSON.stringify(extended[0]) }]);
    const reader = new BigQueryClickIdStoreReader(bq, { projectId: 'oa-proj', dataset: 'app', table: 'ad_click_ids' });
    expect(await reader.read('SynthU01StarterMonA1')).toEqual(extended[0]);
    expect(bq.queries[0]!.params).toEqual({ user_id: 'SynthU01StarterMonA1' });
    bq.queryResults.push([{ record: JSON.stringify({ gclid: 'x' }) }]); // missing gclid_created_at
    expect(await reader.read('SynthU01StarterMonA1')).toBeNull();
  });
});

describe('ValueResolver: the PURCHASE-TIME conditional value E[gross_profit_90d | purchase]', () => {
  const scores = purchaseValueRows();
  const U01_FIRST = 'purchase_in_1SynthU01Inv0001First';
  const occurred = Date.parse('2026-06-03T17:04:11Z');
  const SLA = 600_000;

  function resolver(rows: PurchaseValueScore[] = scores, opts: { fx?: FixedFxRates; reporting?: string; store?: InMemoryDocumentStore } = {}) {
    const store = opts.store ?? new InMemoryDocumentStore();
    const r = new ValueResolver(
      { scores: new InMemoryPurchaseValues(rows), store, fx: opts.fx ?? new FixedFxRates(opts.reporting ?? 'USD', {}) },
      { floorMajor: 0.01, reportingCurrency: opts.reporting ?? 'USD', scoreSlaMs: SLA },
    );
    return { r, store };
  }

  it('values an acquisition purchase at its purchase-time score (looked up by event id), and records the decision', async () => {
    const { r, store } = resolver();
    const v = await r.resolve(g(U01_FIRST), Date.parse('2026-06-03T17:05:00Z'));
    expect(v).toEqual({
      value: 22.11,
      currency: 'USD',
      basis: 'predicted_profit_90d',
      floored: false,
      raw_value: 22.11,
      model_version: 'purchase-value-illustrative-0.1',
      predicted_ltv: 22.11,
      in_reporting_currency: true,
      pending: false,
    });
    expect(store.dump(VALUE_DECISIONS)).toEqual([expect.objectContaining({ key: U01_FIRST, data: expect.objectContaining({ user_id: 'SynthU01StarterMonA1', decided_by: 'server' }) })]);
  });

  it('never uses the signup+24h PredictedProfit (unconditional estimand): without a purchase-time score it waits, then sends cash tagged cash_fallback', async () => {
    // A PredictedProfit row exists for U01 (22.11), but it is not a purchase-time score.
    expect(predictedProfitRows().some((p) => p.user_id === 'SynthU01StarterMonA1')).toBe(true);
    const { r } = resolver([]);
    const early = await r.resolve(g(U01_FIRST), occurred + 30_000);
    expect(early).toMatchObject({ pending: true, basis: 'cash_fallback', value: 14 });
    const late = await r.resolve(g(U01_FIRST), occurred + SLA + 1);
    expect(late).toMatchObject({ pending: false, basis: 'cash_fallback', value: 14, floored: false, predicted_ltv: null, model_version: null });
  });

  it('a score computed after the SLA is not purchase-time and is ignored; so is a score for another user', async () => {
    const lateScore = { ...scores.find((s) => s.event_id === U01_FIRST)!, scored_at: '2026-06-03T18:00:00Z' };
    expect(await resolver([lateScore]).r.resolve(g(U01_FIRST), Date.parse('2026-06-03T18:30:00Z'))).toMatchObject({ basis: 'cash_fallback', value: 14 });
    const otherUser = { ...scores.find((s) => s.event_id === U01_FIRST)!, user_id: 'SomebodyElse' };
    expect(await resolver([otherUser]).r.resolve(g(U01_FIRST), Date.parse('2026-06-03T18:30:00Z'))).toMatchObject({ basis: 'cash_fallback' });
  });

  it('a loss-making purchase sends the floor but says so (value_floored, raw value kept); never silently', async () => {
    const pack = g('purchase_cs_live_a1SynthU05Pack00000001');
    const v = await resolver().r.resolve(pack, Date.parse('2026-07-05T10:01:00Z'));
    expect(v).toMatchObject({ value: 0.01, floored: true, raw_value: -4.37, basis: 'predicted_profit_90d', predicted_ltv: 0.01 });
  });

  it('later purchases (renewal, upgrade, add-on) carry cash by design, even when a score exists', async () => {
    const { r } = resolver();
    expect(await r.resolve(g('purchase_in_1SynthU01Inv0002Cycle'), Date.parse('2026-07-04T00:00:00Z'))).toMatchObject({ value: 14, basis: 'cash', pending: false });
    expect(await r.resolve(g('purchase_in_1SynthU03Inv0003Upgrade'), Date.parse('2026-07-06T00:00:00Z'))).toMatchObject({ value: 7.34, basis: 'cash' });
    // The add-on has a golden score, but it is not an acquisition purchase.
    expect(scores.some((s) => s.event_id === 'purchase_in_1SynthU03Inv0002AddOn')).toBe(true);
    expect(await r.resolve(g('purchase_in_1SynthU03Inv0002AddOn'), Date.parse('2026-06-26T00:00:00Z'))).toMatchObject({ value: 10, basis: 'cash' });
    expect(await r.resolve(g('reg_SynthU05FreeTrialE5x'), Date.parse('2026-07-02T00:00:00Z'))).toBeNull();
  });

  it('first decision wins: once the browser path fixed a cash fallback, a late score cannot change the server value', async () => {
    const store = new InMemoryDocumentStore();
    const early = resolver([], { store }).r;
    const input = valueInputOf(g(U01_FIRST))!;
    expect(await early.decide(input, occurred + 5_000, 'value_endpoint', { force: true })).toMatchObject({ basis: 'cash_fallback', value: 14 });
    const withScore = resolver(scores, { store }).r;
    expect(await withScore.resolve(g(U01_FIRST), occurred + 60_000)).toMatchObject({ basis: 'cash_fallback', value: 14, pending: false });
  });

  it('FX: non-USD amounts are converted to the reporting currency; without a rate they stay whole in their own currency (never mixed)', async () => {
    const eur = { ...g('purchase_in_1SynthU01Inv0002Cycle'), currency: 'EUR', cash_value_minor: 1200 };
    const fx = new FixedFxRates('USD', { EUR: 1.1 });
    expect(await resolver(scores, { fx }).r.resolve(eur, Date.parse('2026-07-04T00:00:00Z'))).toMatchObject({ value: 13.2, currency: 'USD', in_reporting_currency: true, basis: 'cash' });
    const jpy = { ...g('purchase_in_1SynthU01Inv0002Cycle'), currency: 'JPY', cash_value_minor: 2100 };
    expect(await resolver(scores, { fx }).r.resolve(jpy, Date.parse('2026-07-04T00:00:00Z'))).toMatchObject({ value: 2100, currency: 'JPY', in_reporting_currency: false });
    const eurScore = { ...scores.find((s) => s.event_id === U01_FIRST)!, currency: 'EUR' };
    expect(await resolver([eurScore], { fx }).r.resolve(g(U01_FIRST), occurred + 60_000)).toMatchObject({ value: 24.32, currency: 'USD', basis: 'predicted_profit_90d', predicted_ltv: 24.32 });
    expect(await new FixedFxRates('USD', { EUR: 1.1, GBP: 1.25 }).rate('GBP', 'EUR', 0)).toBeCloseTo(1.25 / 1.1, 10);
  });

  it('rejects a floor that is not strictly positive', () => {
    expect(() => new ValueResolver({ scores: new InMemoryPurchaseValues([]), store: new InMemoryDocumentStore(), fx: new FixedFxRates('USD', {}) }, { floorMajor: 0, reportingCurrency: 'USD', scoreSlaMs: 1 })).toThrow(/floor/);
  });

  it('BigQuery reader: explicit columns, a partition bound on occurred_at, and contract validation of every row', async () => {
    const bq = new FakeBigQuery();
    const row = scores.find((s) => s.event_id === U01_FIRST)!;
    bq.queryResults.push([{ ...row, occurred_at: { value: '2026-06-03T17:04:11.000Z' }, scored_at: { value: '2026-06-03T17:04:52.000Z' }, features_snapshot: JSON.stringify(row.features_snapshot) }]);
    const reader = new BigQueryPurchaseValueReader(bq, { projectId: 'oa-proj', dataset: 'marts', table: 'fct_purchase_value_score' });
    expect(await reader.byEventId(U01_FIRST, occurred, Date.parse('2026-06-04T00:00:00Z'))).toEqual(row);
    const q = bq.queries[0]!;
    expect(q.sql).not.toMatch(/SELECT \*/);
    expect(q.sql).toContain('occurred_at BETWEEN TIMESTAMP(@from) AND TIMESTAMP(@to)');
    expect(q.sql).toContain('scored_at <= TIMESTAMP(@as_of)');
    expect(q.params).toMatchObject({ event_id: U01_FIRST, from: '2026-06-02T17:04:11Z', to: '2026-06-04T17:04:11Z' });
    bq.queryResults.push([{ ...row, predicted_profit_90d: 999, features_snapshot: JSON.stringify(row.features_snapshot) }]); // components no longer add up
    expect(await reader.byEventId(U01_FIRST, occurred, Date.parse('2026-06-04T00:00:00Z'))).toBeNull();
  });
});

describe('UserContext readers', () => {
  it('in-memory and BigQuery readers return the same shape; BigQuery parses JSON columns', async () => {
    const ctx = { user_id: 'SynthU01StarterMonA1', email: 'synth.u01@example.test', device_id: 'dev-1', region: 'US', experiment_arms: { flag: 'arm' } };
    expect(await new InMemoryUserContext([ctx]).get('SynthU01StarterMonA1')).toEqual(ctx);
    const bq = new FakeBigQuery();
    bq.queryResults.push([{ ...ctx, experiment_arms: JSON.stringify(ctx.experiment_arms), consent: null }]);
    const got = await new BigQueryUserContextReader(bq, { projectId: 'oa-proj', dataset: 'app', table: 'conversion_user_context' }).get('SynthU01StarterMonA1');
    expect(got).toMatchObject({ ...ctx, consent: null });
    // Only the columns the service uses (the view holds raw PII; least privilege and no SELECT *).
    const sql = bq.queries[0]!.sql;
    expect(sql).not.toMatch(/SELECT \*/);
    for (const col of ['email', 'phone', 'device_id', 'consent', 'region', 'client_ip_address', 'client_user_agent', 'fbp', 'ttp', 'rdt_uuid', 'experiment_arms']) expect(sql).toContain(col);
  });
});

describe('Consent', () => {
  it('uses the contracts CONSENT_REQUIRED_REGIONS (single source of truth), which covers everything edge-attribution regulates', () => {
    expect(REGULATED_COUNTRIES).toBe(CONSENT_REQUIRED_REGIONS);
    for (const c of EDGE_REGULATED) expect(REGULATED_COUNTRIES.has(c), c).toBe(true);
    for (const c of ['GB', 'UK', 'CH', 'RE', 'GF', 'GP', 'MQ', 'YT', 'MF', 'AX']) expect(REGULATED_COUNTRIES.has(c), c).toBe(true);
  });

  it('the UK alias and ISO 3166-2 subdivisions of regulated countries are regulated too', () => {
    for (const region of ['UK', 'GB-ENG', 'DE-BE', 'FR-75']) {
      expect(decidePlatformConsent(consent({ region }), 'meta', DEFAULT_CONSENT_POLICY, {}), region).toEqual({ send: false, reason: 'consent_required_regulated_region' });
    }
  });

  it('an explicit denial counts whatever its source (regional_default and none too), in and outside regulated regions', () => {
    for (const source of ['regional_default', 'none'] as const) {
      for (const region of ['US', 'BR', 'US-CA']) {
        const denied = consent({ region, source, ad_user_data: 'denied' });
        expect(decidePlatformConsent(denied, 'google_ads', DEFAULT_CONSENT_POLICY, {}), `${source} ${region}`).toEqual({ send: false, reason: 'consent_denied' });
      }
      expect(decidePlatformConsent(consent({ region: 'DE', source, ad_storage: 'denied' }), 'meta', DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'consent_denied' });
    }
    // A denied ad_storage beside a CMP-granted ad_user_data is still a denial.
    const mixed = consent({ region: 'DE', source: 'cmp', ad_user_data: 'granted', ad_storage: 'denied' });
    expect(decidePlatformConsent(mixed, 'meta', DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'consent_denied' });
  });

  it('GPC or a US-state sale/sharing opt-out blocks every platform everywhere, even with a CMP grant and restrict handling', () => {
    const restrict = { ...DEFAULT_CONSENT_POLICY, optOutHandling: 'restrict' as const };
    const granted = { region: 'US-CA', source: 'cmp' as const, ad_storage: 'granted' as const, ad_user_data: 'granted' as const, ad_personalization: 'granted' as const };
    for (const flags of [{ gpc: true }, { opt_out_sale_sharing: true }]) {
      for (const p of ['google_ads', 'meta', 'tiktok', 'reddit', 'linkedin', 'x', 'microsoft'] as const) {
        expect(decidePlatformConsent(consent({ ...granted, ...flags }), p, restrict, { client_ip_address: '203.0.113.9' }), `${p} ${JSON.stringify(flags)}`).toEqual({ send: false, reason: 'gpc_or_sale_opt_out' });
        expect(decidePlatformConsent(consent({ region: 'BR', ...flags }), p, DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'gpc_or_sale_opt_out' });
      }
    }
    expect(decidePlatformConsent(consent({ ...granted, gpc: false, opt_out_sale_sharing: false }), 'meta', DEFAULT_CONSENT_POLICY, {})).toMatchObject({ send: true, mode: 'granted' });
  });

  it('send-time merge: a denial or opt-out from either the row or the current user state wins; a later grant never overrides an earlier denial', () => {
    const rowDenied = consent({ region: 'US', source: 'cmp', ad_user_data: 'denied', ad_storage: 'denied' });
    const nowGranted = consent({ region: 'US', source: 'cmp', ad_user_data: 'granted', ad_storage: 'granted', ad_personalization: 'granted' });
    expect(mergeConsentForSend(rowDenied, nowGranted)).toMatchObject({ ad_user_data: 'denied', ad_storage: 'denied' });
    const withdrawn = mergeConsentForSend(nowGranted, rowDenied);
    expect(decidePlatformConsent(withdrawn, 'meta', DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'consent_denied' });
    expect(mergeConsentForSend(consent({ region: 'US' }), consent({ region: 'US', gpc: true }))).toMatchObject({ gpc: true });
    expect(mergeConsentForSend(consent({ region: 'US' }), null)).toEqual(consent({ region: 'US' }));
    // A fresh CMP grant fills in signals the row did not know (unknown -> granted), and keeps the row's region.
    expect(mergeConsentForSend(consent({ region: 'FR' }), { ...nowGranted, region: null })).toMatchObject({ region: 'FR', source: 'cmp', ad_user_data: 'granted' });
  });

  it('row consent: explicit source consent wins, then the stored CMP state, then an unknown state in the known region', () => {
    const cmp = { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied', analytics_storage: 'granted', region: 'FR', source: 'cmp' } as const;
    const unknownUS = { ad_storage: 'unknown', ad_user_data: 'unknown', ad_personalization: 'unknown', analytics_storage: 'unknown', region: 'US', source: 'none' } as const;
    expect(resolveRowConsent(cmp, true, { user_id: 'u', consent: unknownUS })).toEqual(cmp);
    expect(resolveRowConsent(unknownUS, false, { user_id: 'u', consent: cmp })).toEqual(cmp);
    expect(resolveRowConsent({ ...unknownUS, region: null }, false, { user_id: 'u', region: 'US' })).toEqual(unknownUS);
    expect(resolveRowConsent({ ...unknownUS, region: null }, false, null).region).toBeNull();
  });

  const consent = (over: Partial<ConversionLedgerEvent['consent']>) => ({
    ad_storage: 'unknown', ad_user_data: 'unknown', ad_personalization: 'unknown', analytics_storage: 'unknown', region: 'US', source: 'none', ...over,
  }) as ConversionLedgerEvent['consent'];

  it('US without a CMP (OpenArt today): send everywhere, assert nothing about consent', () => {
    for (const p of ['google_ads', 'meta', 'tiktok', 'reddit', 'linkedin', 'x', 'microsoft'] as const) {
      const d = decidePlatformConsent(consent({}), p, DEFAULT_CONSENT_POLICY, {});
      expect(d, p).toMatchObject({ send: true, mode: 'unspecified' });
    }
    expect(decidePlatformConsent(consent({}), 'google_ads', DEFAULT_CONSENT_POLICY, {})).toMatchObject({ google: null });
    expect(decidePlatformConsent(consent({}), 'meta', DEFAULT_CONSENT_POLICY, {})).toMatchObject({ meta: { data_processing_options: [] } });
    expect(decidePlatformConsent(consent({}), 'microsoft', DEFAULT_CONSENT_POLICY, {})).toMatchObject({ microsoftAdStorage: null });
  });

  it('EEA/UK/CH without explicit CMP consent is withheld from every platform; unknown region fails closed', () => {
    for (const region of ['DE', 'GB', 'CH', 'FR', 'RE']) {
      expect(decidePlatformConsent(consent({ region }), 'meta', DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'consent_required_regulated_region' });
    }
    expect(decidePlatformConsent(consent({ region: null }), 'google_ads', DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'consent_region_unknown' });
  });

  it('EEA with CMP consent granted: send, and propagate Google adUserData/adPersonalization verbatim', () => {
    const c = consent({ region: 'DE', source: 'cmp', ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied' });
    expect(decidePlatformConsent(c, 'google_ads', DEFAULT_CONSENT_POLICY, {})).toMatchObject({
      send: true,
      mode: 'granted',
      google: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' },
    });
  });

  it('explicit CMP denial: dropped by default; "restrict" mode sends only where a limited-use mode exists', () => {
    const denied = consent({ region: 'US-CA', source: 'cmp', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    expect(decidePlatformConsent(denied, 'meta', DEFAULT_CONSENT_POLICY, {})).toEqual({ send: false, reason: 'consent_denied' });
    const restrict = { ...DEFAULT_CONSENT_POLICY, optOutHandling: 'restrict' as const };
    expect(decidePlatformConsent(denied, 'meta', restrict, {})).toMatchObject({
      send: true,
      mode: 'restricted',
      meta: { data_processing_options: ['LDU'], data_processing_options_country: 1, data_processing_options_state: 1000 },
    });
    expect(decidePlatformConsent(denied, 'tiktok', restrict, {})).toEqual({ send: false, reason: 'tiktok_ldu_requires_ip' });
    expect(decidePlatformConsent(denied, 'tiktok', restrict, { client_ip_address: '203.0.113.9' })).toMatchObject({ send: true, tiktokLimitedDataUse: true });
    expect(decidePlatformConsent(denied, 'reddit', restrict, {})).toMatchObject({ send: true, reddit: { modes: ['LDU'], country: 'US', region: 'US-CA' } });
    expect(decidePlatformConsent(denied, 'microsoft', restrict, {})).toMatchObject({ send: true, microsoftAdStorage: 'D' });
    expect(decidePlatformConsent(denied, 'google_ads', restrict, {})).toMatchObject({ send: true, google: { adUserData: 'CONSENT_DENIED', adPersonalization: 'CONSENT_DENIED' } });
    expect(decidePlatformConsent(denied, 'linkedin', restrict, {})).toEqual({ send: false, reason: 'consent_denied_no_limited_mode' });
    expect(decidePlatformConsent(denied, 'x', restrict, {})).toEqual({ send: false, reason: 'consent_denied_no_limited_mode' });
  });
});
