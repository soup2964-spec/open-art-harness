import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_IDS, validateWithSchema } from '../src/schema-registry.js';
import {
  CONSENT_REQUIRED_REGIONS,
  PREDICTED_PROFIT_ESTIMAND,
  PURCHASE_VALUE_ESTIMAND,
  adSharingOptedOut,
  blocksAdSharing,
  consentCountry,
  isExplicitlyDenied,
  requiresConsent,
  unknownConsent,
} from '../src/index.js';
import { ConsentSchema, ConversionLedgerEventSchema, PurchaseValueScoreSchema } from '../src/validators.js';
import type { Consent, PurchaseValueScore } from '../src/types.js';
import { PKG_ROOT, fixtureFiles, fixtureRecords } from './helpers.js';

const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

describe('CONSENT_REQUIRED_REGIONS (single source of truth)', () => {
  it('covers the EU27, the EEA EFTA states, GB (and the UK alias) and CH', () => {
    for (const c of [...EU27, 'IS', 'LI', 'NO', 'GB', 'UK', 'CH']) expect(CONSENT_REQUIRED_REGIONS.has(c), c).toBe(true);
  });

  it('covers EU outermost regions and Åland, which geolocate to their own ISO codes', () => {
    for (const c of ['RE', 'GF', 'GP', 'MQ', 'YT', 'MF', 'AX']) expect(CONSENT_REQUIRED_REGIONS.has(c), c).toBe(true);
  });

  it('does not include non-EEA countries', () => {
    for (const c of ['US', 'CA', 'BR', 'IN', 'JP', 'AU', 'TR', 'BL', 'PM']) expect(CONSENT_REQUIRED_REGIONS.has(c), c).toBe(false);
  });

  it('requiresConsent normalises case, subdivisions and the UK alias', () => {
    expect(requiresConsent('GB')).toBe(true);
    expect(requiresConsent('UK')).toBe(true);
    expect(requiresConsent('uk')).toBe(true);
    expect(requiresConsent('GB-ENG')).toBe(true);
    expect(requiresConsent('de')).toBe(true);
    expect(requiresConsent('FR-75')).toBe(true);
    expect(requiresConsent('CH')).toBe(true);
    expect(requiresConsent('RE')).toBe(true);
    expect(requiresConsent('US')).toBe(false);
    expect(requiresConsent('US-CA')).toBe(false);
    expect(consentCountry('uk')).toBe('GB');
    expect(consentCountry('US-CA')).toBe('US');
  });

  it('unknown or unusable regions fail closed unless the caller opts out', () => {
    for (const r of [null, undefined, '', 'XX', 'T1', 'ZZ', 'not-a-country', '1A']) {
      expect(requiresConsent(r), String(r)).toBe(true);
      expect(consentCountry(r)).toBeNull();
      expect(requiresConsent(r, { unknown: 'not_required' }), String(r)).toBe(false);
    }
  });
});

describe('Consent: gpc and opt_out_sale_sharing', () => {
  const base: Consent = unknownConsent('US-CA');

  it('rows without the new fields stay valid (backward compatible) in JSON Schema and zod', () => {
    expect(ConsentSchema.safeParse(base).success).toBe(true);
    const [row] = fixtureRecords(fixtureFiles('canonical', ['conversion_ledger_events.jsonl'])[0]!) as Array<Record<string, unknown>>;
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.conversionLedgerEvent, row).valid).toBe(true);
    expect(ConversionLedgerEventSchema.safeParse(row).success).toBe(true);
  });

  it('accepts boolean gpc / opt_out_sale_sharing in both validators and rejects other types', () => {
    const [row] = fixtureRecords(fixtureFiles('canonical', ['conversion_ledger_events.jsonl'])[0]!) as Array<Record<string, unknown>>;
    const withFlags = { ...row, consent: { ...base, gpc: true, opt_out_sale_sharing: false } };
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.conversionLedgerEvent, withFlags).errors).toEqual([]);
    expect(ConversionLedgerEventSchema.safeParse(withFlags).success).toBe(true);
    const bad = { ...row, consent: { ...base, gpc: 'yes' } };
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.conversionLedgerEvent, bad).valid).toBe(false);
    expect(ConversionLedgerEventSchema.safeParse(bad).success).toBe(false);
  });

  it('an explicit denial counts whatever its source (cmp, regional_default or none)', () => {
    for (const source of ['cmp', 'regional_default', 'none'] as const) {
      expect(isExplicitlyDenied({ ...base, source, ad_user_data: 'denied' }), source).toBe(true);
      expect(isExplicitlyDenied({ ...base, source, ad_storage: 'denied' }), source).toBe(true);
      expect(blocksAdSharing({ ...base, source, ad_storage: 'denied' }), source).toBe(true);
    }
    expect(isExplicitlyDenied(base)).toBe(false);
    expect(isExplicitlyDenied({ ...base, ad_personalization: 'denied' })).toBe(false);
    expect(isExplicitlyDenied({ ...base, ad_personalization: 'denied' }, ['ad_personalization'])).toBe(true);
  });

  it('GPC or a US-state sale/sharing opt-out blocks ad sharing everywhere, even with a CMP grant', () => {
    const granted: Consent = { ...base, ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted', source: 'cmp' };
    expect(blocksAdSharing(granted)).toBe(false);
    for (const c of [{ ...granted, gpc: true }, { ...granted, opt_out_sale_sharing: true }, { ...granted, region: 'BR', gpc: true }]) {
      expect(adSharingOptedOut(c)).toBe(true);
      expect(blocksAdSharing(c)).toBe(true);
    }
    expect(adSharingOptedOut({ ...granted, gpc: false, opt_out_sale_sharing: false })).toBe(false);
  });
});

function score(over: Partial<PurchaseValueScore> = {}): PurchaseValueScore {
  return {
    event_id: 'purchase_in_1SynthU01Inv0001First',
    invoice_id: 'in_1SynthU01Inv0001First',
    user_id: 'SynthU01StarterMonA1',
    occurred_at: '2026-06-03T17:04:11Z',
    scored_at: '2026-06-03T17:04:40Z',
    estimand: 'E[gross_profit_90d | purchase]',
    horizon_days: 90,
    predicted_revenue_90d: 36.4,
    predicted_generation_cost_90d: 11.9,
    predicted_fees_90d: 1.66,
    predicted_refund_risk: 0.73,
    predicted_profit_90d: 22.11,
    interval_low: 14.2,
    interval_high: 30.05,
    cash_value: 14,
    currency: 'USD',
    model_version: 'purchase-value-illustrative-0.1',
    run_id: 'run_2026-06-03T17',
    fitted_params_ref: 'gs://example-bucket/purchase-value/illustrative-0.1/params.json',
    features_snapshot: { as_of: '2026-06-03T17:04:11Z', plan_tier: 'essential', billing_interval: 'month', generations_before_purchase: 3 },
    ...over,
  };
}

function bothAccept(row: unknown) {
  const ajv = validateWithSchema(CANONICAL_SCHEMA_IDS.purchaseValueScore, row);
  const zod = PurchaseValueScoreSchema.safeParse(row);
  return { ajv: ajv.valid, zod: zod.success, errors: ajv.errors };
}

describe('PurchaseValueScore (purchase-time conditional value)', () => {
  it('documents both estimands as constants', () => {
    expect(PURCHASE_VALUE_ESTIMAND).toBe('E[gross_profit_90d | purchase]');
    expect(PREDICTED_PROFIT_ESTIMAND).toBe('unconditional E[90d profit per exposed user]');
  });

  it('accepts a valid score in JSON Schema and zod, including a checkout-session one-time pack', () => {
    expect(bothAccept(score())).toMatchObject({ ajv: true, zod: true, errors: [] });
    const pack = score({ event_id: 'purchase_cs_live_a1SynthU05Pack00000001', invoice_id: null });
    expect(bothAccept(pack)).toMatchObject({ ajv: true, zod: true });
  });

  it('accepts a loss-making purchase (negative predicted profit)', () => {
    const loss = score({ predicted_generation_cost_90d: 40, predicted_profit_90d: -5.99, interval_low: -12, interval_high: 1 });
    expect(bothAccept(loss)).toMatchObject({ ajv: true, zod: true });
  });

  const schemaRejects: Array<[string, Partial<PurchaseValueScore> | Record<string, unknown>]> = [
    ['the unconditional estimand', { estimand: 'unconditional E[90d profit per exposed user]' }],
    ['a 30-day horizon', { horizon_days: 30 }],
    ['a signup event id', { event_id: 'reg_SynthU01StarterMonA1' }],
    ['a non-UTC scored_at', { scored_at: '2026-06-03T10:04:40-07:00' }],
    ['a lower-case currency', { currency: 'usd' }],
    ['negative predicted revenue', { predicted_revenue_90d: -1 }],
    ['negative cash', { cash_value: -14 }],
    ['a missing as_of', { features_snapshot: { plan_tier: 'essential' } }],
    ['a nested feature value', { features_snapshot: { as_of: '2026-06-03T17:04:11Z', nested: { a: 1 } } }],
    ['an unknown top-level field', { predicted_ltv: 99 }],
  ];
  it.each(schemaRejects)('rejects %s in both validators', (_label, over) => {
    const r = bothAccept({ ...score(), ...over });
    expect(r.ajv).toBe(false);
    expect(r.zod).toBe(false);
  });

  const zodOnly: Array<[string, Partial<PurchaseValueScore>]> = [
    ['event_id not matching invoice_id', { invoice_id: 'in_1SomeOtherInvoice' }],
    ['a scored_at before the purchase', { scored_at: '2026-06-03T17:00:00Z' }],
    ['components that do not add up', { predicted_profit_90d: 30 , interval_high: 31 }],
    ['an interval that does not contain the estimate', { interval_low: 23, interval_high: 30 }],
    ['an inverted interval', { interval_low: 30, interval_high: 14 }],
    ['features computed after the purchase (as_of)', { features_snapshot: { as_of: '2026-06-03T17:05:00Z' } }],
    ['a feature timestamp after the purchase', { features_snapshot: { as_of: '2026-06-03T17:04:11Z', last_generation_at: '2026-06-04T00:00:00Z' } }],
    ['an invoice-less subscription purchase id', { invoice_id: null }],
  ];
  it.each(zodOnly)('zod enforces the cross-field invariant: %s', (_label, over) => {
    const row = score(over);
    expect(PurchaseValueScoreSchema.safeParse(row).success).toBe(false);
  });

  it('every golden purchase value score validates and references a golden purchase row', () => {
    const rows = fixtureRecords(fixtureFiles('canonical', ['purchase_value_scores.jsonl'])[0]!) as PurchaseValueScore[];
    const ledger = fixtureRecords(fixtureFiles('canonical', ['conversion_ledger_events.jsonl'])[0]!) as Array<{ event_id: string; occurred_at: string; user_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(bothAccept(row), row.event_id).toMatchObject({ ajv: true, zod: true, errors: [] });
      const purchase = ledger.find((l) => l.event_id === row.event_id);
      expect(purchase, row.event_id).toBeDefined();
      expect(row.occurred_at).toBe(purchase!.occurred_at);
      expect(row.user_id).toBe(purchase!.user_id);
    }
  });
});

describe('validator/type drift guard', () => {
  it('validators.ts has no `as unknown as` casts that would switch off the tsc drift guard', () => {
    const src = readFileSync(join(PKG_ROOT, 'src', 'validators.ts'), 'utf8');
    expect(src).not.toMatch(/as unknown as/);
  });
});
