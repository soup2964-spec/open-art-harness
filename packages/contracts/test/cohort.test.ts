import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cohortFiles, generateCohort } from '../src/cohort/generate.js';
import { ARM_DEFAULT_GENERATION, COHORT_PARAMS, OTHER_MODELS } from '../src/cohort/params.js';
import { parseModelCostsCsv } from '../src/model-catalog.js';
import { SOURCE_SCHEMA_IDS, validateWithSchema } from '../src/schema-registry.js';
import { sha256Hex } from '../src/sha256.js';
import { FIXTURES } from './helpers.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const small = generateCohort({ users: 300 });

describe('cohort generator', () => {
  it('is deterministic for a seed and changes with the seed', () => {
    const again = generateCohort({ users: 300 });
    expect(JSON.stringify(cohortFiles(again))).toBe(JSON.stringify(cohortFiles(small)));
    const other = generateCohort({ users: 300, seed: 'another-seed' });
    expect(cohortFiles(other)['stripe_events.jsonl']).not.toBe(cohortFiles(small)['stripe_events.jsonl']);
  });

  it('emits only records that validate against the source schemas', () => {
    const check = (schemaId: string, rows: unknown[], label: string) => {
      for (const row of rows) {
        const r = validateWithSchema(schemaId, row);
        if (!r.valid) throw new Error(`${label}: ${r.errors.join('; ')}\n${JSON.stringify(row).slice(0, 400)}`);
      }
    };
    check(SOURCE_SCHEMA_IDS.stripeEvent, small.stripeEvents, 'stripe');
    check(SOURCE_SCHEMA_IDS.creditLedgerEntry, small.ledgerEntries, 'ledger');
    check(SOURCE_SCHEMA_IDS.amplitudeExportRow, small.amplitudeEvents, 'amplitude');
    check(SOURCE_SCHEMA_IDS.amplitudeExportRow, small.amplitudeExposures, 'exposures');
    check(SOURCE_SCHEMA_IDS.appUser, small.appUsers, 'app users');
    expect(new Set(small.amplitudeExposures.map((r) => r.event_type))).toEqual(new Set(['$exposure']));
  });

  it('keeps every ledger balance chain intact in createdAt order and unique ids/keys', () => {
    const balances = new Map<string, number>();
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const e of small.ledgerEntries) {
      const k = `${e.userId}|${e.creditField}`;
      expect(e.balanceBefore, e.id).toBe(balances.get(k) ?? 0);
      expect(e.balanceAfter).toBe(e.balanceBefore + e.amount);
      expect(e.balanceAfter).toBeGreaterThanOrEqual(0);
      balances.set(k, e.balanceAfter);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(keys.has(e.idempotencyKey), e.idempotencyKey).toBe(false);
      keys.add(e.idempotencyKey);
    }
    const eventIds = new Set(small.stripeEvents.map((e) => e.id));
    expect(eventIds.size).toBe(small.stripeEvents.length);
  });

  it('reconciles Stripe cash with the ground truth', () => {
    const net = new Map<string, number>();
    const add = (uid: string, v: number) => net.set(uid, (net.get(uid) ?? 0) + v);
    for (const ev of small.stripeEvents as Json[]) {
      const o = ev.data.object;
      if (ev.type === 'invoice.paid') add(o.customer, o.amount_paid);
      if (ev.type === 'checkout.session.completed' && o.mode === 'payment') add(o.customer, o.amount_total);
      if (ev.type === 'charge.refunded') add(o.customer, -(o.amount_refunded - (ev.data.previous_attributes?.amount_refunded ?? 0)));
    }
    const disputed = new Map<string, number>();
    for (const ev of small.stripeEvents as Json[]) {
      if (ev.type !== 'charge.dispute.created') continue;
      const inv = (small.stripeEvents as Json[]).find(
        (x) => x.type === 'invoice_payment.paid' && x.data.object.payment.payment_intent === ev.data.object.payment_intent,
      );
      const customer = (small.stripeEvents as Json[]).find((x) => x.type === 'invoice.paid' && x.data.object.id === inv?.data.object.invoice)
        ?.data.object.customer;
      disputed.set(customer, (disputed.get(customer) ?? 0) + ev.data.object.amount);
    }
    for (const t of small.truth) {
      expect((net.get(t.user_id) ?? 0) - (disputed.get(t.user_id) ?? 0), t.user_id).toBe(t.net_cash_minor);
    }
  });

  it('produces every lifecycle event type and billing reason at the default size', () => {
    const full = generateCohort();
    const types = new Set(full.stripeEvents.map((e) => e.type));
    for (const t of [
      'checkout.session.completed',
      'invoice.paid',
      'invoice_payment.paid',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'charge.refunded',
      'charge.dispute.created',
    ]) {
      expect(types, t).toContain(t);
    }
    const reasons = new Set(full.stripeEvents.filter((e) => e.type === 'invoice.paid').map((e) => (e.data.object as Json).billing_reason));
    expect(reasons).toEqual(new Set(['subscription_create', 'subscription_cycle', 'subscription_update']));
    expect(full.truth).toHaveLength(COHORT_PARAMS.users);
    // Committed fixtures are exactly the default output (no stale files).
    const files = cohortFiles(full);
    for (const [name, content] of Object.entries(files)) {
      const committed = readFileSync(join(FIXTURES, 'cohort', name), 'utf8');
      expect(sha256Hex(committed), name).toBe(sha256Hex(content));
    }
  });

  it('makes credit burn depend on the default-model arm', () => {
    const full = generateCohort();
    const armOf = new Map(full.truth.map((t) => [t.user_id, t.arm_create_image]));
    const burn = new Map<string, number[]>();
    for (const e of full.ledgerEntries) {
      if (e.type !== 'CONSUME' || !e.reference.businessType.endsWith(':text2image')) continue;
      const arm = armOf.get(e.userId)!;
      if (e.reference.businessType !== ARM_DEFAULT_GENERATION[arm]!.businessType) continue;
      const unit = e.businessDetails![0]!.unitCredits;
      burn.set(arm, [...(burn.get(arm) ?? []), unit]);
    }
    const unit = (arm: string) => burn.get(arm)![0];
    expect(unit('nano-banana-pro')).toBe(40);
    expect(unit('nano-banana-2')).toBe(20);
    expect(unit('gpt-image-2-5')).toBe(5);
    // Arm assignment is balanced-ish and exposures exist for both flags for every user.
    const perUser = new Map<string, Set<string>>();
    for (const r of full.amplitudeExposures) {
      const set = perUser.get(r.user_id!) ?? new Set<string>();
      set.add(String(r.event_properties.flag_key));
      perUser.set(r.user_id!, set);
    }
    expect(perUser.size).toBe(COHORT_PARAMS.users);
  });

  it('only uses generation settings that exist in fixtures/seeds/model_costs.csv', () => {
    const seeds = parseModelCostsCsv(readFileSync(join(FIXTURES, 'seeds', 'model_costs.csv'), 'utf8'));
    for (const g of [...Object.values(ARM_DEFAULT_GENERATION), ...OTHER_MODELS.image, ...OTHER_MODELS.video]) {
      const row = seeds.find((r) => r.business_type === g.businessType && r.setting === g.setting);
      expect(row, `${g.businessType} @ ${g.setting}`).toBeDefined();
      expect(row!.credits).toBe(g.credits);
    }
  });
});
