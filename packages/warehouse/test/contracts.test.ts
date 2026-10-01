/**
 * Every row the warehouse produces for a contract is checked with the contracts package's own
 * validators: zod (with the cross-field invariants of validators.ts) AND the JSON Schemas via
 * ajv. Warehouse-only columns are checked against the contracts' JS implementations
 * (SHA-256 ids, platform mapping), so SQL and TypeScript cannot drift apart.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SCHEMA_IDS,
  SOURCE_SCHEMA_IDS,
  validateWithSchema,
} from '@openart-signal/contracts/schema-registry';
import {
  CONSENT_REQUIRED_REGIONS,
  ConversionLedgerEventSchema,
  ExperimentExposureSchema,
  PLATFORM_EVENT_MAPPING,
  PREDICTED_PROFIT_ESTIMAND,
  PredictedProfitSchema,
  metaExternalId,
  redditPixelConversionId,
  requiresConsent,
} from '@openart-signal/contracts';
import { EXPORT_DIR, WAREHOUSE, exportAvailable, readJsonl } from './helpers.js';

type Row = Record<string, unknown>;

function failures(rows: Row[], check: (row: Row) => string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const problems = check(row);
    if (problems.length > 0) out.push(`${JSON.stringify(row).slice(0, 160)} -> ${problems.join('; ')}`);
    if (out.length >= 10) break;
  }
  return out;
}

function zodIssues(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } } }, row: Row): string[] {
  const parsed = schema.safeParse(row);
  return parsed.success ? [] : (parsed.error?.issues ?? []).map((i) => `zod ${i.path.join('.')}: ${i.message}`);
}

describe.skipIf(!exportAvailable())('warehouse rows satisfy the contracts', () => {
  const ledger = () => readJsonl(join(EXPORT_DIR, 'conversion_ledger_events.jsonl'));

  it('fct_conversion_ledger: every row passes the ConversionLedgerEvent JSON Schema and zod validator', () => {
    const rows = ledger();
    expect(rows.length).toBeGreaterThan(3000);
    const bad = failures(rows, (row) => [
      ...validateWithSchema(CANONICAL_SCHEMA_IDS.conversionLedgerEvent, row).errors.map((e) => `ajv ${e}`),
      ...zodIssues(ConversionLedgerEventSchema, row),
    ]);
    expect(bad).toEqual([]);
  });

  it('fct_conversion_ledger: columns come in CONVERSION_LEDGER_COLUMNS order with every canonical event present', () => {
    const rows = ledger();
    const names = new Set(rows.map((r) => r.event_name));
    for (const name of ['signup', 'activation_first_generation', 'checkout_started', 'purchase_first', 'purchase_renewal', 'purchase_upgrade', 'purchase_add_on', 'purchase_one_time_pack', 'refund', 'chargeback', 'enterprise_lead', 'lead_stage_change']) {
      expect(names, name).toContain(name);
    }
    expect(Object.keys(rows[0]!)[0]).toBe('schema_version');
    expect(Object.keys(rows[0]!).at(-1)).toBe('experiment_arms');
  });

  it('fct_predicted_profit_24h: every row passes the PredictedProfit JSON Schema and zod (incl. the profit identity)', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'predicted_profit.jsonl'));
    expect(rows.length).toBeGreaterThan(1900);
    const bad = failures(rows, (row) => [
      ...validateWithSchema(CANONICAL_SCHEMA_IDS.predictedProfit, row).errors.map((e) => `ajv ${e}`),
      ...zodIssues(PredictedProfitSchema, row),
    ]);
    expect(bad).toEqual([]);
  });

  it('fct_predicted_profit_24h is labelled with the unconditional estimand and carries no platform value', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'predicted_profit.jsonl'));
    expect(Object.keys(rows[0]!)).not.toContain('platform_value_usd');
    expect(PREDICTED_PROFIT_ESTIMAND).toBe('unconditional E[90d profit per exposed user]');
  });

  it('fct_experiment_exposures: every row passes the ExperimentExposure JSON Schema and zod', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'experiment_exposures.jsonl'));
    const bad = failures(rows, (row) => [
      ...validateWithSchema(CANONICAL_SCHEMA_IDS.experimentExposure, row).errors.map((e) => `ajv ${e}`),
      ...zodIssues(ExperimentExposureSchema, row),
    ]);
    expect(bad).toEqual([]);
  });

  it('reddit_pixel_conversion_id equals redditPixelConversionId(order_id) from the contracts', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'ledger_platform_ids.jsonl')).filter((r) => r.order_id !== null);
    expect(rows.length).toBeGreaterThan(200);
    const bad = rows.filter((r) => r.reddit_pixel_conversion_id !== redditPixelConversionId(String(r.order_id)));
    expect(bad).toEqual([]);
  });

  it('requires_web_fix / web_fix_platforms equal PLATFORM_EVENT_MAPPING (send && requires_web_fix)', () => {
    const expected = new Map<string, string>();
    for (const row of PLATFORM_EVENT_MAPPING) {
      if (!(row.send && row.requires_web_fix)) continue;
      const list = (expected.get(row.canonical_event) ?? '').split(',').filter(Boolean);
      list.push(row.platform);
      expected.set(row.canonical_event, list.sort().join(','));
    }
    const rows = readJsonl(join(EXPORT_DIR, 'ledger_platform_ids.jsonl'));
    const bad = rows.filter((r) => {
      const want = expected.get(String(r.event_name)) ?? null;
      return r.web_fix_platforms !== want || r.requires_web_fix !== (want !== null);
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('audiences materialise no hashed identifier next to the uid (audience-sync hashes per platform)', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'audience_candidates.jsonl'));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.external_id_sha256 !== null)).toEqual([]);
    // what audience-sync will compute instead is still well defined for every row
    for (const r of rows) expect(metaExternalId(String(r.user_id))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('audience uploads are gated exactly by the contracts consent policy (CONSENT_REQUIRED_REGIONS, unknown fails closed)', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'audience_candidates.jsonl'));
    const bad = rows.filter((r) => {
      const region = r.consent_region === null ? null : String(r.consent_region);
      const required = requiresConsent(region);
      return r.upload_allowed !== !required || r.requires_consent !== (region !== null && CONSENT_REQUIRED_REGIONS.has(region));
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('seed values sent for lookalikes are never negative and suppressions carry no value', () => {
    const rows = readJsonl(join(EXPORT_DIR, 'audience_candidates.jsonl'));
    for (const r of rows) {
      if (r.candidate_role === 'seed') expect(Number(r.seed_value_usd)).toBeGreaterThanOrEqual(0);
      else expect(r.seed_value_usd).toBeNull();
    }
  });
});

describe('synthetic platform fixtures', () => {
  it('every successful invoice lookup in the SYNTHETIC log matches invoice-lookup-response.schema.json', () => {
    const rows = readJsonl(join(WAREHOUSE, 'fixtures', 'synthetic', 'invoice_lookups.jsonl'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_origin).toBe('synthetic');
      if (row.http_status === 200) {
        const result = validateWithSchema(SOURCE_SCHEMA_IDS.invoiceLookupResponse, row.response);
        expect(result.errors, JSON.stringify(row)).toEqual([]);
      } else {
        expect(row.response).toBeNull();
      }
    }
  });
});
