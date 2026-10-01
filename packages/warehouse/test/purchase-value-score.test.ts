/**
 * fct_purchase_value_score is the ad value (ML review 1): every row must pass the
 * PurchaseValueScore contract, zod (identity, interval containment, scored_at >= occurred_at,
 * point-in-time feature snapshot, event id format) AND the JSON Schema, and it must be what the
 * contract says it is: E[gross_profit_90d | purchase], one row per ledger purchase.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_IDS, validateWithSchema } from '@openart-signal/contracts/schema-registry';
import { PURCHASE_VALUE_ESTIMAND, PREDICTED_PROFIT_ESTIMAND, PurchaseValueScoreSchema } from '@openart-signal/contracts';
import { EXPORT_DIR, exportAvailable, readJsonl } from './helpers.js';

type Row = Record<string, unknown>;

function zodIssues(row: Row): string[] {
  const parsed = PurchaseValueScoreSchema.safeParse(row);
  return parsed.success ? [] : parsed.error.issues.map((i) => `zod ${i.path.join('.')}: ${i.message}`);
}

describe.skipIf(!exportAvailable())('fct_purchase_value_score satisfies the PurchaseValueScore contract', () => {
  const scores = () => readJsonl<Row>(join(EXPORT_DIR, 'purchase_value_scores.jsonl'));

  it('every row passes the JSON Schema and zod (incl. identity, interval and point-in-time rules)', () => {
    const rows = scores();
    expect(rows.length).toBeGreaterThan(200);
    const bad: string[] = [];
    for (const row of rows) {
      const problems = [
        ...validateWithSchema(CANONICAL_SCHEMA_IDS.purchaseValueScore, row).errors.map((e) => `ajv ${e}`),
        ...zodIssues(row),
      ];
      if (problems.length) bad.push(`${String(row.event_id)} -> ${problems.join('; ')}`);
      if (bad.length >= 10) break;
    }
    expect(bad).toEqual([]);
  });

  it('columns come in contract order, with the purchase-time estimand (not the 24h one)', () => {
    const rows = scores();
    expect(Object.keys(rows[0]!)).toEqual([
      'event_id', 'invoice_id', 'user_id', 'occurred_at', 'scored_at', 'estimand', 'horizon_days',
      'predicted_revenue_90d', 'predicted_generation_cost_90d', 'predicted_fees_90d', 'predicted_refund_risk',
      'predicted_profit_90d', 'interval_low', 'interval_high', 'cash_value', 'currency', 'model_version',
      'run_id', 'fitted_params_ref', 'features_snapshot',
    ]);
    for (const r of rows) {
      expect(r.estimand).toBe(PURCHASE_VALUE_ESTIMAND);
      expect(r.estimand).not.toBe(PREDICTED_PROFIT_ESTIMAND);
    }
  });

  it('one score per ledger purchase event, scored from features known at the purchase', () => {
    const rows = scores();
    const purchases = readJsonl<Row>(join(EXPORT_DIR, 'conversion_ledger_events.jsonl')).filter((r) => String(r.event_name).startsWith('purchase'));
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(rows.length);
    expect(rows.map((r) => r.event_id).sort()).toEqual(purchases.map((r) => r.event_id).sort());
    for (const r of rows) {
      const snapshot = r.features_snapshot as Row;
      // the feature cut-off is the purchase itself: nothing after it
      expect(Date.parse(String(snapshot.as_of)), String(r.event_id)).toBe(Date.parse(String(r.occurred_at)));
      expect(String(r.fitted_params_ref)).toMatch(/^dim_model_parameters@[0-9a-f]{64}$/);
    }
  });

  it('the append-only log holds contract-valid rows for every purchase', () => {
    const log = readJsonl<Row>(join(EXPORT_DIR, 'purchase_value_score_log.jsonl'));
    expect(log.length).toBeGreaterThanOrEqual(scores().length);
    const bad = log.filter((r) => zodIssues(r).length > 0).slice(0, 5);
    expect(bad).toEqual([]);
  });
});
