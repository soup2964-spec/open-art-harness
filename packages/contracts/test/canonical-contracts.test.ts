import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_IDS, validateWithSchema } from '../src/schema-registry.js';
import {
  AudienceMemberSchema,
  ClickIdStoreRecordExtendedSchema,
  ClickIdStoreRecordSchema,
  ConversionLedgerEventSchema,
  ExperimentExposureSchema,
  PredictedProfitSchema,
} from '../src/validators.js';
import type { ConversionLedgerEvent } from '../src/types.js';
import { join } from 'node:path';
import { CONVERSION_LEDGER_COLUMNS, emptyAttribution, unknownConsent } from '../src/index.js';
import { PKG_ROOT, fixtureFiles, fixtureRecords, readJson } from './helpers.js';

const UID = 'SynthU01StarterMonA1';
const INVOICE = 'in_1SynthU01Inv0001First';

function purchaseRow(overrides: Partial<ConversionLedgerEvent> = {}): ConversionLedgerEvent {
  return {
    schema_version: 1,
    event_id: `purchase_${INVOICE}`,
    event_name: 'purchase_first',
    occurred_at: '2026-06-03T17:04:11Z',
    source_system: 'stripe',
    source_event_id: 'evt_1SynthU01InvPaid0001',
    user_id: UID,
    device_id: '5b0c8f2e-1d4a-4c3b-9e7f-000000000001',
    order_id: `sub_${INVOICE}`,
    adjusts_event_id: null,
    adjusts_order_id: null,
    cash_value_minor: 1400,
    currency: 'USD',
    invoice_id: INVOICE,
    subscription_id: 'sub_1SynthU01Starter000001',
    checkout_session_id: 'cs_live_a1SynthU01Checkout0001',
    charge_id: null,
    plan_tier: 'essential',
    plan_tier_code: 1000,
    billing_interval: 'month',
    previous_plan_tier: null,
    credit_pack_quantity: null,
    is_first_purchase: true,
    is_business: false,
    generation: null,
    lead: null,
    ...emptyAttribution(),
    consent: unknownConsent('US'),
    experiment_arms: { 'suite-default-model-create-image': 'nano-banana-pro' },
    ...overrides,
  };
}

function bothAccept(schemaId: string, zodSchema: { safeParse: (v: unknown) => { success: boolean } }, row: unknown) {
  const ajv = validateWithSchema(schemaId, row);
  const zod = zodSchema.safeParse(row);
  return { ajv: ajv.valid, zod: zod.success, errors: ajv.errors };
}

describe('ConversionLedgerEvent', () => {
  const id = CANONICAL_SCHEMA_IDS.conversionLedgerEvent;

  it('accepts a first purchase in both JSON Schema and zod', () => {
    const r = bothAccept(id, ConversionLedgerEventSchema, purchaseRow());
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ ajv: true, zod: true });
  });

  const rejects: Array<[string, Partial<ConversionLedgerEvent>]> = [
    ['signup-style id on a purchase', { event_id: `reg_${UID}` }],
    ['order id not in the sub_<invoiceId> form', { order_id: 'order_123' }],
    ['lower-case currency', { currency: 'usd' }],
    ['negative purchase value', { cash_value_minor: -1400 }],
    ['cash without currency', { currency: null }],
    ['non-UTC timestamp', { occurred_at: '2026-06-03T10:04:11-07:00' }],
    ['unknown plan tier', { plan_tier: 'starter' as never }],
    ['purchase from a non-Stripe source', { source_system: 'amplitude' }],
  ];
  it.each(rejects)('rejects %s in both validators', (_label, override) => {
    const r = bothAccept(id, ConversionLedgerEventSchema, purchaseRow(override));
    expect(r.ajv).toBe(false);
    expect(r.zod).toBe(false);
  });

  it('zod enforces the cross-field id invariants JSON Schema cannot express', () => {
    const mismatched = purchaseRow({ order_id: 'sub_in_1SomeOtherInvoice' });
    expect(validateWithSchema(id, mismatched).valid).toBe(true);
    expect(ConversionLedgerEventSchema.safeParse(mismatched).success).toBe(false);
    const wrongUser = purchaseRow({
      event_name: 'signup',
      event_id: 'reg_SomebodyElse',
      order_id: null,
      cash_value_minor: null,
      currency: null,
      invoice_id: null,
      subscription_id: null,
      checkout_session_id: null,
      plan_tier: null,
      plan_tier_code: null,
      billing_interval: null,
      is_first_purchase: null,
      is_business: null,
      source_system: 'credit_ledger',
    });
    expect(validateWithSchema(id, wrongUser).valid).toBe(true);
    expect(ConversionLedgerEventSchema.safeParse(wrongUser).success).toBe(false);
  });

  it('refunds carry negative cash, the charge and the adjusted purchase', () => {
    const refund = purchaseRow({
      event_name: 'refund',
      event_id: 'refund_ch_3SynthU01Chg0003_1400',
      order_id: null,
      charge_id: 'ch_3SynthU01Chg0003',
      cash_value_minor: -1400,
      adjusts_event_id: 'purchase_in_1SynthU01Inv0003Cycle',
      adjusts_order_id: 'sub_in_1SynthU01Inv0003Cycle',
      invoice_id: 'in_1SynthU01Inv0003Cycle',
      is_first_purchase: null,
    });
    expect(bothAccept(id, ConversionLedgerEventSchema, refund)).toMatchObject({ ajv: true, zod: true });
    const positive = { ...refund, cash_value_minor: 1400 };
    expect(bothAccept(id, ConversionLedgerEventSchema, positive)).toMatchObject({ ajv: false, zod: false });
  });

  it('every golden canonical row validates (fixtures/canonical)', () => {
    const rows = fixtureRecords(fixtureFiles('canonical', ['conversion_ledger_events.jsonl'])[0]!);
    const names = new Set<string>();
    for (const row of rows) {
      const r = bothAccept(id, ConversionLedgerEventSchema, row);
      expect(r.errors, JSON.stringify(row)).toEqual([]);
      expect(r.zod).toBe(true);
      names.add((row as { event_name: string }).event_name);
    }
    // Golden rows cover every canonical event name.
    expect(names.size).toBe(12);
  });
});

describe('ledger column order', () => {
  it('CONVERSION_LEDGER_COLUMNS equals the schema required list and the golden rows use it', () => {
    const schema = readJson(join(PKG_ROOT, 'src', 'schemas', 'conversion-ledger-event.schema.json')) as { required: string[] };
    expect([...CONVERSION_LEDGER_COLUMNS]).toEqual(schema.required);
    for (const row of fixtureRecords(fixtureFiles('canonical', ['conversion_ledger_events.jsonl'])[0]!)) {
      expect(Object.keys(row as object)).toEqual(schema.required);
    }
  });
});

describe('ClickIdStoreRecord', () => {
  const current = { gclid: 'Cj0KCQjwSYNTHgclid001', gclid_created_at: 1790000000000 };

  it('current payload is valid for both the current and the extended contract (backward compatible)', () => {
    for (const file of fixtureFiles('click_ids', ['.json']).filter((f) => f.includes('current'))) {
      for (const rec of fixtureRecords(file)) {
        expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecord, rec).errors).toEqual([]);
        expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecordExtended, rec).errors).toEqual([]);
        expect(ClickIdStoreRecordSchema.safeParse(rec).success).toBe(true);
        expect(ClickIdStoreRecordExtendedSchema.safeParse(rec).success).toBe(true);
      }
    }
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecord, current).valid).toBe(true);
  });

  it('extended payloads validate against the extended contract only', () => {
    for (const file of fixtureFiles('click_ids', ['.json']).filter((f) => f.includes('extended'))) {
      for (const rec of fixtureRecords(file)) {
        expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecordExtended, rec).errors).toEqual([]);
        expect(ClickIdStoreRecordExtendedSchema.safeParse(rec).success).toBe(true);
        expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecord, rec).valid).toBe(false);
      }
    }
  });

  it('requires *_created_at to travel with its id, as the Suite sends them', () => {
    const orphan = { gclid: 'abc' };
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecord, orphan).valid).toBe(false);
    expect(ClickIdStoreRecordSchema.safeParse(orphan).success).toBe(false);
    const isoInsteadOfMs = { gclid: 'abc', gclid_created_at: '2026-09-29T00:00:00Z' };
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.clickIdStoreRecord, isoInsteadOfMs).valid).toBe(false);
  });
});

describe('PredictedProfit, ExperimentExposure, AudienceMember', () => {
  it('golden rows validate in both validators', () => {
    const cases: Array<[string, string, { safeParse: (v: unknown) => { success: boolean } }]> = [
      ['predicted_profit.jsonl', CANONICAL_SCHEMA_IDS.predictedProfit, PredictedProfitSchema],
      ['experiment_exposures.jsonl', CANONICAL_SCHEMA_IDS.experimentExposure, ExperimentExposureSchema],
      ['audience_members.jsonl', CANONICAL_SCHEMA_IDS.audienceMember, AudienceMemberSchema],
    ];
    for (const [file, schemaId, zodSchema] of cases) {
      const rows = fixtureRecords(fixtureFiles('canonical', [file])[0]!);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(validateWithSchema(schemaId, row).errors, file).toEqual([]);
        expect(zodSchema.safeParse(row).success, file).toBe(true);
      }
    }
  });

  it('predicted profit must equal revenue - cost - fees - refund risk (zod)', () => {
    const [row] = fixtureRecords(fixtureFiles('canonical', ['predicted_profit.jsonl'])[0]!) as Array<
      Record<string, unknown>
    >;
    const broken = { ...row, predicted_profit: (row!.predicted_profit as number) + 5 };
    expect(PredictedProfitSchema.safeParse(broken).success).toBe(false);
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.predictedProfit, { ...row, horizon_days: 30 }).valid).toBe(false);
  });

  it('audience identifiers must be 64-char lowercase sha256 hex', () => {
    const [row] = fixtureRecords(fixtureFiles('canonical', ['audience_members.jsonl'])[0]!) as Array<
      Record<string, unknown>
    >;
    const plaintext = { ...row, identifiers: { email_sha256: 'someone@example.com' } };
    expect(validateWithSchema(CANONICAL_SCHEMA_IDS.audienceMember, plaintext).valid).toBe(false);
    expect(AudienceMemberSchema.safeParse(plaintext).success).toBe(false);
  });
});
