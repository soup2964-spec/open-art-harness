import { describe, expect, it } from 'vitest';
import { purchaseEventId, purchaseOrderId } from '../../../contracts/src/event-ids';
import { readFixture } from '../../test-utils/fixtures';
import {
  assertDeterministicId,
  choosePurchaseValue,
  conversionReportedForSkip,
  isFallbackTransactionId,
  planItemFromParams,
  resolveClientPurchase,
  toBusinessSubscriptionPush,
  toFirstPurchasePush,
  toGtagPurchase,
  toMetaPurchase,
  toUetPurchase,
  type CheckoutInvoice,
  type ResolvedPurchase,
} from '../src/fallback-purchase';

/** SubscriptionType enum values from module 6895 (f35f0fc60fe73455.js). */
const SubscriptionType = {
  Free: 0,
  Essential: 1000,
  Advanced: 2000,
  Infinite: 3000,
  Wonder: 3500,
  Team: 4000,
  BusinessTeam50k: 4450,
  BusinessTeam100k: 4500,
  BusinessTeam150k: 4550,
  BusinessTeam250k: 4600,
  BusinessTeam500k: 4650,
  BusinessTeam750k: 4700,
  BusinessTeam1M: 4750,
} as const;
const TIER_KEYS: Record<number, string> = { 1000: 'Essential', 2000: 'Advanced', 3000: 'Infinite', 3500: 'Wonder', 4450: 'BusinessTeam50k' };

const PRICES = new Function('n', `return ${readFixture(import.meta.url, './fixtures/suite-module-399331-prices.js').replace(/^\/\*[\s\S]*?\*\/\s*/, '')}`)({
  SubscriptionType,
}) as Record<number, { monthly: number; yearly: number }>;

/** Shipped Suite functions ek/eN/eE/eR/eA (module 111958), evaluated with fixed time. */
function loadShipped(now: number) {
  const code = readFixture(import.meta.url, './fixtures/suite-module-111958-purchase.js');
  const pushed: unknown[] = [];
  const factory = new Function(
    'ev',
    'ex',
    'k',
    'Date',
    'window',
    `${code}\nreturn { ek, eN, eE, eR, eA };`,
  );
  const fns = factory(
    { PRICES },
    { SubscriptionLevelConfig: Object.fromEntries(Object.entries(TIER_KEYS).map(([k, v]) => [k, { tierKey: v }])) },
    { get: () => Promise.reject(new Error('network disabled')) },
    { now: () => now },
    { dataLayer: pushed },
  ) as {
    ek: (e: unknown, t: CheckoutInvoice) => { value: number; currency: string };
    eE: (p: { tierParam: string; intervalParam: string; uid?: string; email?: string }) => {
      transaction_id: string;
      value: number;
      currency: string;
      items: Array<{ item_id: string; item_name: string; quantity: number; price: number }>;
    } | null;
    eR: (e: unknown, t: CheckoutInvoice) => { transaction_id: string; value: number; currency: string; items: unknown[] };
  };
  return fns;
}

const tierKeyOf = (tier: number) => TIER_KEYS[tier];
const NOW = 1_790_700_000_000;

const PRO_ANNUAL_INVOICE: CheckoutInvoice = {
  invoiceId: 'in_1QxYzAbCdEfGhIjKlMnOpQr',
  isBusiness: false,
  isValidInvoice: true,
  isFirstPurchase: true,
  amountMajor: 528,
  amountMinor: 52800,
  currency: 'usd',
  ltvValueMajor: 911.4,
  ltvCurrency: 'usd',
};

describe('what ships today (evidence, not the fix)', () => {
  it('the fallback PRICES table reports annual plans at a stale per-month figure', () => {
    expect(PRICES[SubscriptionType.Essential]).toEqual({ monthly: 14, yearly: 7 });
    expect(PRICES[SubscriptionType.Infinite]).toEqual({ monthly: 56, yearly: 28 });
    const shipped = loadShipped(NOW);
    const fallback = shipped.eE({ tierParam: '1000', intervalParam: 'year', uid: 'u1' })!;
    // Invoice lookup failed twice -> eT() returns {} -> eR(fallback, {}) is what gets sent.
    const sent = shipped.eR(fallback, {});
    expect(sent.value).toBe(7); // an annual Starter sale ($13 x 12 = $156 on the live pricing page)
    expect(sent.transaction_id).toBe(`sub_Essential_1000_u1_${NOW}`);
    expect(isFallbackTransactionId(sent.transaction_id)).toBe(true);
  });
});

describe('resolveClientPurchase', () => {
  const item = planItemFromParams({ tierParam: '3000', intervalParam: 'year' }, tierKeyOf)!;

  it('matches the shipped eR()/ek() output whenever the invoice resolves', () => {
    const shipped = loadShipped(NOW);
    const fallback = shipped.eE({ tierParam: '3000', intervalParam: 'year', uid: 'u1' })!;
    const decision = resolveClientPurchase(PRO_ANNUAL_INVOICE, item) as ResolvedPurchase;
    expect(decision.kind).toBe('report');
    // eR keeps the fallback currency's case handling: currency from the invoice (normalised upper by eP()).
    const shippedSent = shipped.eR(fallback, { ...PRO_ANNUAL_INVOICE, currency: 'USD' });
    expect(toGtagPurchase(decision)).toEqual(shippedSent);
    const { value, currency } = decision.value;
    expect({ value, currency }).toEqual(shipped.ek(fallback, { ...PRO_ANNUAL_INVOICE, ltvCurrency: 'usd' }));
    expect(decision.eventId).toBe('purchase_in_1QxYzAbCdEfGhIjKlMnOpQr');
    expect(assertDeterministicId(decision.transactionId)).toBe('sub_in_1QxYzAbCdEfGhIjKlMnOpQr');
  });

  it('never reports a stale value: failed lookup, missing id, amount or currency all skip', () => {
    expect(resolveClientPurchase({}, item)).toEqual({ kind: 'skip', reason: 'invoice_unresolved' });
    expect(resolveClientPurchase(null, item)).toEqual({ kind: 'skip', reason: 'invoice_unresolved' });
    expect(resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, invoiceId: 'bad id' }, item)).toEqual({ kind: 'skip', reason: 'invoice_id_invalid' });
    expect(resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, amountMajor: undefined }, item)).toEqual({ kind: 'skip', reason: 'amount_missing' });
    expect(resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, amountMajor: Number.NaN }, item)).toEqual({ kind: 'skip', reason: 'amount_missing' });
    expect(resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, currency: undefined }, item)).toEqual({ kind: 'skip', reason: 'currency_missing' });
  });

  it('uses cash when the backend sends no LTV (ek fallback) and keeps a $0 coupon sale', () => {
    const d = resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, ltvValueMajor: undefined, ltvCurrency: undefined }, item) as ResolvedPurchase;
    expect(d.value).toEqual({ value: 528, currency: 'USD', value_basis: 'cash' });
    const free = resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, amountMajor: 0 }, item) as ResolvedPurchase;
    expect(free.cash.value).toBe(0);
  });

  it('builds first_purchase / business_subscription pushes with the shipped shapes and rules', () => {
    const d = resolveClientPurchase(PRO_ANNUAL_INVOICE, item) as ResolvedPurchase;
    expect(toFirstPurchasePush(d, ' Jane@Example.com ')).toEqual({
      event: 'first_purchase',
      eventModel: {
        transaction_id: 'sub_in_1QxYzAbCdEfGhIjKlMnOpQr',
        value: 911.4,
        currency: 'USD',
        items: [{ item_id: 'Infinite_3000_year', item_name: 'Infinite', quantity: 1, price: 911.4 }],
      },
      user_data: { email: 'jane@example.com' },
    });
    expect(toBusinessSubscriptionPush(d, 'a@b.co')).toBeNull(); // not business
    const biz = resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, isBusiness: true }, { item_id: 'BusinessTeam50k_4450', item_name: 'BusinessTeam50k', quantity: 1 }) as ResolvedPurchase;
    expect(toBusinessSubscriptionPush(biz, 'a@b.co')?.event).toBe('business_subscription');
    const renewal = resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, isFirstPurchase: false }, item) as ResolvedPurchase;
    expect(toFirstPurchasePush(renewal, 'a@b.co')).toBeNull();
  });
});

/** Shipped Suite module 114607 (08d6e61a49e7dfba.js): G/K/Z — K() is `purchase()`, which also calls UET. */
function loadShippedPurchaseCall(win: Record<string, unknown>) {
  const code = readFixture(import.meta.url, './fixtures/suite-module-114607-purchase-call.js');
  const exported: Record<string, unknown> = {};
  const e = {
    i: (id: number) => (id === 358207 ? { publicEnv: { isProductionEnv: true } } : {}),
    s: (pairs: unknown[]) => {
      for (let k = 0; k < pairs.length; k += 2) exported[pairs[k] as string] = (pairs[k + 1] as () => unknown)();
    },
  };
  new Function('e', 'window', code)(e, win);
  return exported as { purchase: (payload: Record<string, unknown>, callbacks?: Record<string, unknown>) => void };
}

describe('UET purchase: shipped call plus the dedup event_id', () => {
  const item = planItemFromParams({ tierParam: '3000', intervalParam: 'year' }, tierKeyOf)!;

  it('K() sends transaction_id / revenue_value / currency but no event_id today', () => {
    const win: Record<string, unknown> = { gtag: () => undefined };
    const d = resolveClientPurchase(PRO_ANNUAL_INVOICE, item) as ResolvedPurchase;
    loadShippedPurchaseCall(win).purchase({ ...toGtagPurchase(d), user_email: 'a@b.co' });
    expect(win.uetq).toEqual(['event', 'purchase', { transaction_id: 'sub_in_1QxYzAbCdEfGhIjKlMnOpQr', revenue_value: 528, currency: 'USD' }]);
  });

  it('toUetPurchase() is the same call with event_id = sub_<invoiceId>', () => {
    const d = resolveClientPurchase(PRO_ANNUAL_INVOICE, item) as ResolvedPurchase;
    const win: Record<string, unknown> = { gtag: () => undefined };
    loadShippedPurchaseCall(win).purchase({ ...toGtagPurchase(d), user_email: 'a@b.co' });
    const [, , shipped] = win.uetq as [string, string, Record<string, unknown>];
    const [cmd, action, fixed] = toUetPurchase(d);
    expect([cmd, action]).toEqual(['event', 'purchase']);
    expect(fixed).toEqual({ ...shipped, event_id: 'sub_in_1QxYzAbCdEfGhIjKlMnOpQr' });
    expect(assertDeterministicId(fixed.event_id)).toBe(fixed.transaction_id);
  });
});

describe('invoice ids follow the contracts rule (review: any 4-128 character id was accepted)', () => {
  const item = planItemFromParams({ tierParam: '3000', intervalParam: 'year' }, tierKeyOf)!;
  const VECTORS = [
    'in_1QxYzAbCdEfGhIjKlMnOpQr',
    'in_A',
    'undefined',
    'null',
    '0000',
    'test',
    'sub_in_1Qx',
    'in_',
    'in_abc-def',
    'in_abc_def',
    'IN_ABC',
    'cs_live_a1B2c3',
    'ch_3QxYz',
    ' in_1Qx',
    'in_1Qx\n',
  ];

  it('reports exactly the ids packages/contracts accepts, with the ids contracts builds', () => {
    for (const id of VECTORS) {
      let accepted = true;
      try {
        purchaseEventId(id);
      } catch {
        accepted = false;
      }
      const d = resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, invoiceId: id }, item);
      if (!accepted) {
        expect(d, id).toEqual({ kind: 'skip', reason: 'invoice_id_invalid' });
        continue;
      }
      expect(d.kind, id).toBe('report');
      expect((d as ResolvedPurchase).transactionId).toBe(purchaseOrderId(id));
      expect((d as ResolvedPurchase).eventId).toBe(purchaseEventId(id));
    }
  });

  it('a constant bogus id (e.g. "undefined") no longer collapses every purchase into one platform order id', () => {
    const ids = ['undefined', 'null', '0000'].map((id) => resolveClientPurchase({ ...PRO_ANNUAL_INVOICE, invoiceId: id }, item).kind);
    expect(ids).toEqual(['skip', 'skip', 'skip']);
  });

  it('assertDeterministicId only lets invoice-derived ids leave the browser', () => {
    for (const bad of ['sub_undefined', 'purchase_0000', 'sub_SEALTEST_1', 'sub_cs_live_a1B2']) expect(() => assertDeterministicId(bad), bad).toThrow();
    expect(assertDeterministicId('sub_in_1Qx')).toBe('sub_in_1Qx');
    expect(assertDeterministicId('purchase_in_1Qx')).toBe('purchase_in_1Qx');
  });
});

describe('purchase value: the server-computed profitValueMajor (review: value consistency with Meta dedup)', () => {
  const item = planItemFromParams({ tierParam: '3000', intervalParam: 'year' }, tierKeyOf)!;
  const WITH_PROFIT: CheckoutInvoice = { ...PRO_ANNUAL_INVOICE, profitValueMajor: 342.17, profitCurrency: 'usd' };

  it('choosePurchaseValue prefers profitValueMajor, else the tag’s legacy basis, and records which (value_basis)', () => {
    expect(choosePurchaseValue(WITH_PROFIT, 'ltv')).toEqual({ value: 342.17, currency: 'USD', value_basis: 'profit' });
    expect(choosePurchaseValue(WITH_PROFIT, 'cash')).toEqual({ value: 342.17, currency: 'USD', value_basis: 'profit' });
    expect(choosePurchaseValue(PRO_ANNUAL_INVOICE, 'ltv')).toEqual({ value: 911.4, currency: 'USD', value_basis: 'ltv' });
    expect(choosePurchaseValue(PRO_ANNUAL_INVOICE, 'cash')).toEqual({ value: 528, currency: 'USD', value_basis: 'cash' });
    expect(choosePurchaseValue({ ...PRO_ANNUAL_INVOICE, ltvValueMajor: null, ltvCurrency: null }, 'ltv')).toEqual({ value: 528, currency: 'USD', value_basis: 'cash' });
    expect(choosePurchaseValue({ currency: 'usd' }, 'cash')).toBeNull();
  });

  it('a profit value without profitCurrency is in the invoice currency', () => {
    expect(choosePurchaseValue({ ...PRO_ANNUAL_INVOICE, currency: 'eur', profitValueMajor: 12.5 }, 'cash')).toEqual({ value: 12.5, currency: 'EUR', value_basis: 'profit' });
  });

  it('an unusable profit value (null, negative, NaN, not a number, bad currency) falls back', () => {
    const bad: Array<Partial<CheckoutInvoice>> = [
      { profitValueMajor: null },
      { profitValueMajor: -3 },
      { profitValueMajor: Number.NaN },
      { profitValueMajor: '12' as unknown as number },
      { profitValueMajor: 10, profitCurrency: 'dollars' },
    ];
    for (const b of bad) expect(choosePurchaseValue({ ...PRO_ANNUAL_INVOICE, ...b }, 'ltv')?.value_basis, JSON.stringify(b)).toBe('ltv');
  });

  it('with profitValueMajor, every value-carrying browser purchase tag sends the SAME value the server copy carries', () => {
    const d = resolveClientPurchase(WITH_PROFIT, item) as ResolvedPurchase;
    const biz = resolveClientPurchase({ ...WITH_PROFIT, isBusiness: true }, item) as ResolvedPurchase;
    const [, , uet] = toUetPurchase(d);
    const [, , meta, metaOptions] = toMetaPurchase(d);
    const sent: Array<[string, number, string]> = [
      ['gtag purchase (Google Ads x2, Reddit, X, LinkedIn via GTM)', toGtagPurchase(d).value, toGtagPurchase(d).currency],
      ['UET', uet.revenue_value, uet.currency],
      ['first_purchase (TikTok tag 78)', toFirstPurchasePush(d, 'a@b.co')!.eventModel.value, toFirstPurchasePush(d, 'a@b.co')!.eventModel.currency],
      ['business_subscription', toBusinessSubscriptionPush(biz, 'a@b.co')!.eventModel.value, toBusinessSubscriptionPush(biz, 'a@b.co')!.eventModel.currency],
      ['Meta pixel', meta.value, meta.currency],
    ];
    for (const [tag, value, currency] of sent) expect([value, currency], tag).toEqual([342.17, 'USD']);
    expect(toGtagPurchase(d).items[0]!.price).toBe(342.17);
    expect(metaOptions).toEqual({ eventID: 'purchase_in_1QxYzAbCdEfGhIjKlMnOpQr' });
    expect([d.value.value_basis, d.orderValue.value_basis]).toEqual(['profit', 'profit']);
  });

  it('without it, each tag keeps today’s value (shipped eR() for gtag, ek() for Meta/TikTok) and value_basis says so', () => {
    const d = resolveClientPurchase(PRO_ANNUAL_INVOICE, item) as ResolvedPurchase;
    expect(toGtagPurchase(d).value).toBe(528);
    expect(d.orderValue.value_basis).toBe('cash');
    expect(toMetaPurchase(d)[2]).toEqual({ value: 911.4, currency: 'USD' });
    expect(toFirstPurchasePush(d, undefined)!.eventModel.value).toBe(911.4);
    expect(d.value.value_basis).toBe('ltv');
  });
});

describe('ids and telemetry', () => {
  it('detects every unstable id shape shipped today and accepts invoice ids', () => {
    expect(isFallbackTransactionId(`sub_Essential_1000_u1_${NOW}`)).toBe(true); // Suite eE
    expect(isFallbackTransactionId(`sub_tier_9999_unknown_${NOW}`)).toBe(true); // Suite eE, unknown tier
    expect(isFallbackTransactionId(`sub_Infinite_3000_dOp6BlUh0AgkVu3ILV59_${NOW}`)).toBe(true); // legacy s()
    expect(isFallbackTransactionId('sub_in_1QxYzAbCdEfGhIjKlMnOpQr')).toBe(false);
    expect(isFallbackTransactionId('sub_SEALTEST_1')).toBe(false);
    expect(() => assertDeterministicId(`sub_Essential_1000_u1_${NOW}`)).toThrow();
    expect(() => assertDeterministicId('purchase_in_1QxYz')).not.toThrow();
  });

  it('records client skips in conversion_reported', () => {
    expect(conversionReportedForSkip('google_ads', 'purchase', 'invoice_unresolved')).toEqual({
      report_layer: 'client',
      channel: 'google_ads',
      conversion_type: 'purchase',
      fired: false,
      outcome: 'skipped_invoice_unresolved',
      has_dedup_id: false,
    });
  });

  it('builds plan items like eE() without price or time', () => {
    expect(planItemFromParams({ tierParam: '1000', intervalParam: 'month' }, tierKeyOf)).toEqual({
      item_id: 'Essential_1000',
      item_name: 'Essential',
      quantity: 1,
    });
    expect(planItemFromParams({ tierParam: '9999', intervalParam: 'year' }, tierKeyOf)?.item_id).toBe('tier_9999_9999_year');
    expect(planItemFromParams({ tierParam: undefined, intervalParam: 'year' }, tierKeyOf)).toBeNull();
  });
});
