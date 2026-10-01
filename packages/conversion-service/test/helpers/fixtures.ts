/**
 * Loads the contracts package fixtures (Stripe events, canonical golden rows, click ids,
 * credit ledger, Amplitude, HubSpot) through the package's `./fixtures/*` export.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ClickIdStoreRecordExtended, ConversionLedgerEvent, PredictedProfit, PurchaseValueScore } from '@openart-signal/contracts';
import type { StripeEvent } from '../../src/ingest/stripe-types.js';

const require = createRequire(import.meta.url);
// Resolve one exported fixture file, then walk to the fixtures root.
export const FIXTURES_ROOT = dirname(dirname(require.resolve('@openart-signal/contracts/fixtures/stripe/u01_starter_monthly_renewals_refund.json')));

export function readFixture(rel: string): string {
  return readFileSync(join(FIXTURES_ROOT, rel), 'utf8');
}

export function readJsonFixture<T>(rel: string): T {
  return JSON.parse(readFixture(rel)) as T;
}

export function readJsonlFixture<T>(rel: string): T[] {
  return readFixture(rel)
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export const STRIPE_FIXTURE_FILES = [
  'stripe/u01_starter_monthly_renewals_refund.json',
  'stripe/u02_wonder_annual.json',
  'stripe/u03_plus_add_on_then_upgrade.json',
  'stripe/u04_pro_monthly_chargeback.json',
  'stripe/u05_one_time_pack.json',
] as const;

export function stripeEvents(file: (typeof STRIPE_FIXTURE_FILES)[number]): StripeEvent[] {
  return readJsonFixture<StripeEvent[]>(file);
}

export function allStripeEvents(): StripeEvent[] {
  return STRIPE_FIXTURE_FILES.flatMap((f) => stripeEvents(f));
}

export function goldenLedgerRows(): ConversionLedgerEvent[] {
  return readJsonlFixture<ConversionLedgerEvent>('canonical/conversion_ledger_events.jsonl');
}

export function predictedProfitRows(): PredictedProfit[] {
  return readJsonlFixture<PredictedProfit>('canonical/predicted_profit.jsonl');
}

/** Purchase-time value scores (contracts PurchaseValueScore golden rows). */
export function purchaseValueRows(): PurchaseValueScore[] {
  return readJsonlFixture<PurchaseValueScore>('canonical/purchase_value_scores.jsonl');
}

export function clickIdPayloads(): { current: ClickIdStoreRecordExtended[]; extended: ClickIdStoreRecordExtended[] } {
  return {
    current: readJsonFixture<ClickIdStoreRecordExtended[]>('click_ids/current_payloads.json'),
    extended: readJsonFixture<ClickIdStoreRecordExtended[]>('click_ids/extended_payloads.json'),
  };
}
