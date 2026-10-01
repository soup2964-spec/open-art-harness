import { describe, expect, it } from 'vitest';
import { ConversionLedgerEventSchema, PLAN_PRICES, STRIPE_PRODUCTS } from '@openart-signal/contracts';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { InMemoryLedger } from '../src/adapters/ledger.js';
import { StripeMapper } from '../src/ingest/stripe-mapper.js';
import type { StripeMapResult } from '../src/ingest/stripe-mapper.js';
import type { StripeEvent } from '../src/ingest/stripe-types.js';
import { allStripeEvents, goldenLedgerRows, stripeEvents } from './helpers/fixtures.js';

/** Fields a Stripe event determines on its own (enrichment fields come later in the pipeline). */
const CORE_FIELDS = [
  'event_id', 'event_name', 'occurred_at', 'source_system', 'source_event_id', 'user_id', 'order_id',
  'adjusts_event_id', 'adjusts_order_id', 'cash_value_minor', 'currency', 'invoice_id', 'subscription_id',
  'checkout_session_id', 'charge_id', 'plan_tier', 'plan_tier_code', 'billing_interval', 'previous_plan_tier',
  'credit_pack_quantity', 'is_first_purchase', 'is_business',
] as const satisfies ReadonlyArray<keyof ConversionLedgerEvent>;

function core(row: ConversionLedgerEvent): Partial<ConversionLedgerEvent> {
  return Object.fromEntries(CORE_FIELDS.map((k) => [k, row[k]]));
}

/** Mimics the pipeline: writes mapped rows to the ledger and re-drives parked events when dependencies arrive. */
async function run(events: StripeEvent[]) {
  const ledger = new InMemoryLedger();
  const mapper = new StripeMapper(new InMemoryDocumentStore(), ledger);
  const rows: ConversionLedgerEvent[] = [];
  const parked: Array<{ event: StripeEvent; dependency: string }> = [];
  const results: Array<{ id: string; result: StripeMapResult }> = [];

  const apply = async (event: StripeEvent): Promise<string[]> => {
    const result = await mapper.map(event);
    results.push({ id: event.id, result });
    const released = [...result.satisfies];
    if (result.kind === 'park') parked.push({ event, dependency: result.dependency });
    if (result.kind === 'rows') {
      await ledger.write(result.rows.map((r) => r.row));
      rows.push(...result.rows.map((r) => r.row));
      released.push(...result.rows.map((r) => `purchase:${r.row.event_id}`));
    }
    return released;
  };

  for (const event of events) {
    const queue = await apply(event);
    while (queue.length > 0) {
      const dep = queue.shift()!;
      for (const p of parked.filter((x) => x.dependency === dep)) {
        parked.splice(parked.indexOf(p), 1);
        queue.push(...(await apply(p.event)));
      }
    }
  }
  return { rows, parked, results, mapper, ledger };
}

describe('StripeMapper against the contracts fixtures (file order)', () => {
  it('emits exactly one canonical row per money event and none for state-only events', async () => {
    const { rows, parked } = await run(allStripeEvents());
    expect(parked).toEqual([]);
    expect(rows.map((r) => `${r.event_name}:${r.event_id}`)).toEqual([
      'purchase_first:purchase_in_1SynthU01Inv0001First',
      'purchase_renewal:purchase_in_1SynthU01Inv0002Cycle',
      'purchase_renewal:purchase_in_1SynthU01Inv0003Cycle',
      'refund:refund_ch_3SynthU01Chg0003_1400',
      'purchase_first:purchase_in_1SynthU02Inv0001First',
      'purchase_first:purchase_in_1SynthU03Inv0001First',
      'purchase_add_on:purchase_in_1SynthU03Inv0002AddOn',
      'purchase_upgrade:purchase_in_1SynthU03Inv0003Upgrade',
      'purchase_first:purchase_in_1SynthU04Inv0001First',
      'chargeback:chargeback_dp_1SynthU04Dispute0001',
      'purchase_one_time_pack:purchase_cs_live_a1SynthU05Pack00000001',
    ]);
  });

  it('matches every Stripe-sourced golden canonical row on the fields Stripe determines', async () => {
    const { rows } = await run(allStripeEvents());
    const goldens = goldenLedgerRows().filter((g) => g.source_system === 'stripe');
    expect(goldens.length).toBe(7);
    for (const golden of goldens) {
      const mine = rows.find((r) => r.event_id === golden.event_id);
      expect(mine, golden.event_id).toBeDefined();
      expect(core(mine!), golden.event_id).toEqual(core(golden));
    }
  });

  it('every emitted row passes the contracts zod validator (cross-field id invariants included)', async () => {
    const { rows } = await run(allStripeEvents());
    for (const row of rows) {
      const parsed = ConversionLedgerEventSchema.safeParse(row);
      expect(parsed.success, `${row.event_id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('keeps first-purchase semantics: renewals, upgrades and add-ons are not first purchases', async () => {
    const { rows } = await run(allStripeEvents());
    const flags = Object.fromEntries(rows.filter((r) => r.is_first_purchase !== null).map((r) => [r.event_id, r.is_first_purchase]));
    expect(flags).toEqual({
      purchase_in_1SynthU01Inv0001First: true,
      purchase_in_1SynthU01Inv0002Cycle: false,
      purchase_in_1SynthU01Inv0003Cycle: false,
      purchase_in_1SynthU02Inv0001First: true,
      purchase_in_1SynthU03Inv0001First: true,
      purchase_in_1SynthU03Inv0002AddOn: false,
      purchase_in_1SynthU03Inv0003Upgrade: false,
      purchase_in_1SynthU04Inv0001First: true,
      purchase_cs_live_a1SynthU05Pack00000001: true,
    });
  });

  it('a win-back subscription (subscription_create after an earlier purchase) is purchase_first with is_first_purchase=false', async () => {
    const u05 = stripeEvents('stripe/u05_one_time_pack.json'); // pack bought 2026-07-05
    // Re-home U04's subscription purchase (2026-07-20) onto U05, who bought the pack first.
    const u04 = structuredClone(stripeEvents('stripe/u04_pro_monthly_chargeback.json')).filter((e) => e.type !== 'charge.dispute.created');
    for (const e of u04) e.data.object = { ...e.data.object, customer: 'SynthU05FreeTrialE5x' };
    const { rows } = await run([...u05, ...u04]);
    const sub = rows.find((r) => r.event_name === 'purchase_first')!;
    expect(sub.user_id).toBe('SynthU05FreeTrialE5x');
    expect(sub.is_first_purchase).toBe(false);
  });
});

describe('StripeMapper never trusts event ordering', () => {
  it('a refund that arrives before invoice_payment.paid is parked on the payment intent, then released unchanged', async () => {
    const inOrder = (await run(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json'))).rows;
    const events = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json');
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    const reordered = [refund, ...events.filter((e) => e !== refund)];
    const { rows, results } = await run(reordered);
    expect(results[0]!.result).toMatchObject({ kind: 'park', dependency: 'pi:pi_3SynthU01Pi0003' });
    expect(rows.find((r) => r.event_name === 'refund')).toEqual(inOrder.find((r) => r.event_name === 'refund'));
  });

  it('an add-on invoice that arrives before any plan state is parked on the subscription, then mapped', async () => {
    const events = stripeEvents('stripe/u03_plus_add_on_then_upgrade.json');
    const addOn = events.find((e) => e.id === 'evt_1SynthU03InvPaid0002')!;
    const reordered = [addOn, ...events.filter((e) => e !== addOn)];
    const { rows, results } = await run(reordered);
    expect(results[0]!.result).toMatchObject({ kind: 'park', dependency: 'sub:sub_1SynthU03Plus00000001' });
    const golden = goldenLedgerRows().find((g) => g.event_id === 'purchase_in_1SynthU03Inv0002AddOn')!;
    expect(core(rows.find((r) => r.event_id === golden.event_id)!)).toEqual(core(golden));
  });

  it('an older customer.subscription.updated never overwrites newer subscription state', async () => {
    const events = stripeEvents('stripe/u03_plus_add_on_then_upgrade.json');
    const upgradeState = events.find((e) => e.id === 'evt_1SynthU03SubUpgrade')!;
    const addOnState = events.find((e) => e.id === 'evt_1SynthU03SubAddOn')!;
    const store = new InMemoryDocumentStore();
    const mapper = new StripeMapper(store, new InMemoryLedger());
    await mapper.map(upgradeState);
    await mapper.map(addOnState); // older, arrives later
    const state = await store.get<{ plan: { tier: string } }>('stripe_subscriptions', 'sub_1SynthU03Plus00000001');
    expect(state?.data.plan.tier).toBe('infinite');
  });
});

describe('upgrade detection ranks tiers and never compares raw prices across billing intervals', () => {
  const u03 = () => structuredClone(stripeEvents('stripe/u03_plus_add_on_then_upgrade.json'));
  type Price = { priceId: string; productId: string; unitAmountMinor: number };

  /** The U03 upgrade invoice (Plus month -> Pro month) with its two plan lines swapped for other prices. */
  function planChange(from: Price, to: Price) {
    const inv = u03().find((e) => e.id === 'evt_1SynthU03InvPaid0003')!;
    const [negative, positive] = (inv.data.object as Record<string, any>).lines.data;
    Object.assign(negative.pricing, { price_details: { price: from.priceId, product: from.productId }, unit_amount_decimal: String(from.unitAmountMinor) });
    Object.assign(positive.pricing, { price_details: { price: to.priceId, product: to.productId }, unit_amount_decimal: String(to.unitAmountMinor) });
    return inv;
  }

  it('Pro annual -> Wonder monthly is an upgrade (the raw unit amount goes DOWN: 524.16/yr -> 240/mo)', async () => {
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    const result = await mapper.map(planChange(PLAN_PRICES.infinite.year, PLAN_PRICES.wonder.month));
    expect(result.kind).toBe('rows');
    const row = (result as Extract<StripeMapResult, { kind: 'rows' }>).rows[0]!.row;
    expect(row).toMatchObject({ event_name: 'purchase_upgrade', plan_tier: 'wonder', billing_interval: 'month', previous_plan_tier: 'infinite' });
  });

  it('Starter monthly -> Starter annual is an interval change, not a tier upgrade (the raw unit amount goes UP)', async () => {
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    expect(await mapper.map(planChange(PLAN_PRICES.essential.month, PLAN_PRICES.essential.year))).toMatchObject({ kind: 'ignore', reason: 'interval_change_not_upgrade' });
  });

  it('Wonder monthly -> Pro annual is a downgrade even though the unit amount rises', async () => {
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    expect(await mapper.map(planChange(PLAN_PRICES.wonder.month, PLAN_PRICES.infinite.year))).toMatchObject({ kind: 'ignore', reason: 'plan_downgrade' });
  });

  it('same tier and interval at a higher price (e.g. a bigger Business credit size) is an upgrade', async () => {
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    const business = (unit: number, id: string) => ({ priceId: id, productId: STRIPE_PRODUCTS.business, unitAmountMinor: unit });
    const inv = planChange(business(20000, 'price_SYNTHbusiness50k'), business(35000, 'price_SYNTHbusiness100k'));
    for (const line of (inv.data.object as Record<string, any>).lines.data) {
      // Business prices are not in the catalog: the legacy line.price carries the interval.
      line.price = { id: line.pricing.price_details.price, object: 'price', product: line.pricing.price_details.product, unit_amount: Number(line.pricing.unit_amount_decimal), recurring: { interval: 'month' } };
    }
    const result = await mapper.map(inv);
    expect(result).toMatchObject({ kind: 'rows' });
    expect((result as Extract<StripeMapResult, { kind: 'rows' }>).rows[0]!.row).toMatchObject({ event_name: 'purchase_upgrade', plan_tier: 'business', previous_plan_tier: 'business' });
  });
});

describe('refund state is compare-and-set and replays are deterministic', () => {
  const u01 = () => structuredClone(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json'));

  it('two refunds of one charge processed concurrently never lower max_cumulative_refunded', async () => {
    const store = new InMemoryDocumentStore();
    const mapper = new StripeMapper(store, new InMemoryLedger());
    const refund = u01().find((e) => e.type === 'charge.refunded')!;
    const small = structuredClone(refund);
    Object.assign(small.data.object, { amount_refunded: 500 });
    small.data.previous_attributes = { amount_refunded: 0 };
    small.id = 'evt_1SynthU01PartialRefund1';
    const big = structuredClone(refund);
    big.data.previous_attributes = { amount_refunded: 500 };
    await Promise.all([mapper.map(big), mapper.map(small)]);
    expect((await store.get<{ max_cumulative_refunded: number }>('stripe_charge_refunds', 'ch_3SynthU01Chg0003'))?.data.max_cumulative_refunded).toBe(1400);
  });

  it('a refund without previous_attributes that is replayed (parked, then released) keeps its original delta', async () => {
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    const refund = u01().find((e) => e.type === 'charge.refunded')!;
    delete refund.data.previous_attributes;
    expect((await mapper.map(refund)).kind).toBe('park');
    const replay = await mapper.map(refund, { degraded: true });
    expect(replay.kind).toBe('rows');
    expect((replay as Extract<StripeMapResult, { kind: 'rows' }>).rows[0]!.row).toMatchObject({ event_id: 'refund_ch_3SynthU01Chg0003_1400', cash_value_minor: -1400 });
  });
});

describe('join state carries the user id and a TTL', () => {
  it('subscription, payment-intent and charge-refund state docs have user_id and expire_at', async () => {
    const store = new InMemoryDocumentStore();
    const now = Date.parse('2026-06-03T17:05:00Z');
    const mapper = new StripeMapper(store, new InMemoryLedger(), () => now);
    for (const e of stripeEvents('stripe/u01_starter_monthly_renewals_refund.json')) await mapper.map(e);
    for (const collection of ['stripe_subscriptions', 'stripe_charge_refunds', 'stripe_invoice_checkout']) {
      const docs = store.dump<{ user_id: string | null; expire_at: string }>(collection);
      expect(docs.length, collection).toBeGreaterThan(0);
      for (const d of docs) {
        expect(d.data.user_id, collection).toBe('SynthU01StarterMonA1');
        expect(Date.parse(d.data.expire_at), collection).toBe(now + 400 * 86_400_000);
      }
    }
    for (const d of store.dump<{ expire_at: string }>('stripe_payment_intents')) expect(d.data.expire_at).toBeDefined();
  });
});

describe('StripeMapper edge cases', () => {
  const u01 = () => structuredClone(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json'));

  it('maps the legacy (pre-basil) invoice shape: top-level subscription and line.price', async () => {
    const events = u01();
    const inv = events.find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;
    const obj = inv.data.object as Record<string, any>;
    obj.subscription = obj.parent.subscription_details.subscription;
    obj.parent = null;
    for (const line of obj.lines.data) {
      line.price = { id: line.pricing.price_details.price, object: 'price', product: line.pricing.price_details.product, unit_amount: 1400, recurring: { interval: 'month' } };
      delete line.pricing;
      line.proration = false;
    }
    const { rows } = await run([events[0]!, inv]);
    const golden = goldenLedgerRows().find((g) => g.event_id === 'purchase_in_1SynthU01Inv0001First')!;
    expect(core(rows[0]!)).toEqual(core(golden));
  });

  it('ignores invoices that are not subscription purchases and zero-cash cycles', async () => {
    const events = u01();
    const manual = structuredClone(events.find((e) => e.id === 'evt_1SynthU01InvPaid0002')!);
    (manual.data.object as Record<string, unknown>).billing_reason = 'manual';
    const zero = structuredClone(events.find((e) => e.id === 'evt_1SynthU01InvPaid0003')!);
    Object.assign(zero.data.object, { amount_paid: 0, total: 0 });
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    expect(await mapper.map(manual)).toMatchObject({ kind: 'ignore', reason: 'unsupported_billing_reason:manual' });
    expect(await mapper.map(zero)).toMatchObject({ kind: 'ignore', reason: 'no_cash' });
  });

  it('turns successive partial refunds into cumulative ids with incremental negative cash', async () => {
    const events = u01();
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    const first = structuredClone(refund);
    Object.assign(first.data.object, { amount_refunded: 500, refunded: false });
    first.data.previous_attributes = { amount_refunded: 0, refunded: false };
    first.id = 'evt_1SynthU01PartialRefund1';
    const second = structuredClone(refund);
    second.data.previous_attributes = { amount_refunded: 500 };
    const { rows } = await run([...events.filter((e) => e !== refund), first, second]);
    const refunds = rows.filter((r) => r.event_name === 'refund');
    expect(refunds.map((r) => [r.event_id, r.cash_value_minor])).toEqual([
      ['refund_ch_3SynthU01Chg0003_500', -500],
      ['refund_ch_3SynthU01Chg0003_1400', -900],
    ]);
  });

  it('after the parking deadline a refund is emitted degraded (cash kept, no adjusts) instead of being lost', async () => {
    const refund = u01().find((e) => e.type === 'charge.refunded')!;
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    expect((await mapper.map(refund)).kind).toBe('park');
    const degraded = await mapper.map(refund, { degraded: true });
    expect(degraded.kind).toBe('rows');
    const row = (degraded as Extract<StripeMapResult, { kind: 'rows' }>).rows[0]!.row;
    expect(row).toMatchObject({ event_id: 'refund_ch_3SynthU01Chg0003_1400', cash_value_minor: -1400, adjusts_event_id: null, adjusts_order_id: null, user_id: 'SynthU01StarterMonA1' });
    expect(ConversionLedgerEventSchema.safeParse(row).success).toBe(true);
  });

  it('carries the Stripe invoice customer_email as a transient identity hint (never in the row)', async () => {
    const events = u01();
    const inv = events.find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;
    (inv.data.object as Record<string, unknown>).customer_email = 'synth.u01@example.test';
    const mapper = new StripeMapper(new InMemoryDocumentStore(), new InMemoryLedger());
    const result = await mapper.map(inv);
    expect(result.kind).toBe('rows');
    const n = (result as Extract<StripeMapResult, { kind: 'rows' }>).rows[0]!;
    expect(n.identity.email).toBe('synth.u01@example.test');
    expect(JSON.stringify(n.row)).not.toContain('synth.u01@example.test');
  });
});
