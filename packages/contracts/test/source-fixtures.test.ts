import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_SCHEMA_IDS, validateWithSchema } from '../src/schema-registry.js';
import { buildAllFixtures } from '../src/fixtures/build-fixtures.js';
import { CAPABILITY_IDS_IN_CODE } from '../src/model-catalog.js';
import { FIXTURES, fixtureFiles, fixtureRecords, readJson } from './helpers.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function expectValid(schemaId: string, record: unknown, label: string) {
  const r = validateWithSchema(schemaId, record);
  expect(r.errors, label).toEqual([]);
}

describe('every fixture validates against its source schema', () => {
  it('stripe/*.json are Stripe Events', () => {
    const files = fixtureFiles('stripe', ['.json']);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) for (const ev of fixtureRecords(f)) expectValid(SOURCE_SCHEMA_IDS.stripeEvent, ev, f);
  });

  it('credit_ledger/*.json are credits/logs responses of valid entries', () => {
    for (const f of fixtureFiles('credit_ledger', ['.json'])) {
      const body = readJson(f) as Json;
      expectValid(SOURCE_SCHEMA_IDS.creditLedgerLogsResponse, body, f);
      for (const entry of body.entries) expectValid(SOURCE_SCHEMA_IDS.creditLedgerEntry, entry, f);
    }
  });

  it('amplitude/*.jsonl are Amplitude BigQuery export rows', () => {
    const files = fixtureFiles('amplitude', ['.jsonl']);
    const types = new Set<string>();
    for (const f of files) {
      for (const row of fixtureRecords(f)) {
        expectValid(SOURCE_SCHEMA_IDS.amplitudeExportRow, row, f);
        types.add((row as Json).event_type);
      }
    }
    for (const t of ['asset_created', '$exposure', 'conversion_reported', 'subscription_started']) expect(types).toContain(t);
  });

  it('click_ids store value, hubspot and app_api fixtures validate', () => {
    for (const rec of fixtureRecords(join(FIXTURES, 'click_ids', 'oa_ad_clids_store.json'))) {
      expectValid(SOURCE_SCHEMA_IDS.oaAdClidsStore, rec, 'oa_ad_clids_store');
    }
    for (const rec of fixtureRecords(join(FIXTURES, 'hubspot', 'enterprise_form_submissions.json'))) {
      expectValid(SOURCE_SCHEMA_IDS.hubspotFormSubmission, rec, 'hubspot form');
    }
    for (const rec of fixtureRecords(join(FIXTURES, 'hubspot', 'contact_lifecycle_changes.json'))) {
      expectValid(SOURCE_SCHEMA_IDS.hubspotContactPropertyChange, rec, 'hubspot webhook');
    }
    for (const rec of fixtureRecords(join(FIXTURES, 'app_api', 'checkout_session_invoice.json'))) {
      expectValid(SOURCE_SCHEMA_IDS.invoiceLookupResponse, rec, 'invoice lookup');
    }
  });

  it('negative controls: schemas reject malformed source records', () => {
    const [ev] = fixtureRecords(fixtureFiles('stripe', ['.json'])[0]!) as Json[];
    expect(validateWithSchema(SOURCE_SCHEMA_IDS.stripeEvent, { ...ev, type: 'invoice.created' }).valid).toBe(false);
    const body = readJson(fixtureFiles('credit_ledger', ['.json'])[0]!) as Json;
    const consume = body.entries.find((e: Json) => e.type === 'CONSUME');
    expect(validateWithSchema(SOURCE_SCHEMA_IDS.creditLedgerEntry, { ...consume, amount: 40 }).valid).toBe(false);
    expect(validateWithSchema(SOURCE_SCHEMA_IDS.creditLedgerEntry, { ...consume, creditField: 'credits' }).valid).toBe(false);
  });
});

describe('fixtures are internally consistent', () => {
  it('are exactly what src/fixtures/build-fixtures.ts produces (no hand drift)', () => {
    for (const [relPath, content] of Object.entries(buildAllFixtures())) {
      expect(readFileSync(join(FIXTURES, relPath), 'utf8'), relPath).toBe(content);
    }
  });

  it('ledger balances chain per bucket and idempotency keys follow <businessType>:<ACTION>:<businessId>', () => {
    for (const f of fixtureFiles('credit_ledger', ['.json'])) {
      const entries = (readJson(f) as Json).entries as Json[];
      const balances = new Map<string, number>();
      // API returns newest first; replay oldest first.
      for (const e of [...entries].reverse()) {
        const key = `${e.userId}|${e.creditField}`;
        expect(e.balanceBefore, `${f} ${e.id}`).toBe(balances.get(key) ?? 0);
        expect(e.balanceAfter).toBe(e.balanceBefore + e.amount);
        balances.set(key, e.balanceAfter);
        const action = e.type === 'CONSUME' ? 'REDUCE' : e.type;
        expect(e.idempotencyKey).toBe(`${e.reference.businessType}:${action}:${e.reference.businessId}`);
        if (e.type === 'CONSUME') {
          const detail = e.businessDetails[0];
          expect(-e.amount).toBe(detail.unitCredits * detail.quantity);
          expect(detail.subBusinessType).toBe(e.reference.businessType);
          expect(CAPABILITY_IDS_IN_CODE).toContain(e.reference.businessType);
        }
      }
    }
  });

  it('stripe scenarios: invoice totals equal their lines and every paid invoice has an invoice_payment', () => {
    const events = fixtureFiles('stripe', ['.json']).flatMap((f) => fixtureRecords(f) as Json[]);
    const payments = new Map<string, Json>();
    for (const ev of events) if (ev.type === 'invoice_payment.paid') payments.set(ev.data.object.invoice, ev.data.object);
    for (const ev of events.filter((e) => e.type === 'invoice.paid')) {
      const inv = ev.data.object;
      const lineSum = inv.lines.data.reduce((s: number, l: Json) => s + l.amount, 0);
      expect(inv.total, inv.id).toBe(lineSum);
      expect(inv.amount_paid).toBe(inv.total);
      expect(payments.get(inv.id)?.amount_paid, `payment for ${inv.id}`).toBe(inv.amount_paid);
      expect(inv.parent.subscription_details.subscription).toMatch(/^sub_/);
    }
    // charge -> payment_intent -> invoice join works for every refund and dispute
    const piToInvoice = new Map([...payments.values()].map((p) => [p.payment.payment_intent, p.invoice]));
    for (const ev of events.filter((e) => e.type === 'charge.refunded')) {
      expect(piToInvoice.get(ev.data.object.payment_intent)).toMatch(/^in_/);
    }
    for (const ev of events.filter((e) => e.type === 'charge.dispute.created')) {
      expect(piToInvoice.get(ev.data.object.payment_intent)).toMatch(/^in_/);
    }
  });

  it('covers the requested scenarios and billing reasons', () => {
    const events = fixtureFiles('stripe', ['.json']).flatMap((f) => fixtureRecords(f) as Json[]);
    const reasons = events.filter((e) => e.type === 'invoice.paid').map((e) => e.data.object.billing_reason);
    expect(new Set(reasons)).toEqual(new Set(['subscription_create', 'subscription_cycle', 'subscription_update']));
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      'checkout.session.completed',
      'invoice.paid',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'charge.refunded',
      'charge.dispute.created',
    ]) {
      expect(types).toContain(t);
    }
    // Stripe customer id is the OpenArt uid (never cus_…).
    for (const ev of events) {
      const customer = ev.data.object.customer;
      if (typeof customer === 'string') expect(customer).not.toMatch(/^cus_/);
    }
  });
});
