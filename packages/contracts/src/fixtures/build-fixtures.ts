/**
 * Builds every hand-specified fixture file (not the cohort) from src/fixtures/scenarios.ts.
 * `buildAllFixtures()` returns { relativePath: fileContent }; the test suite asserts the
 * committed files equal this output, and `tsx src/fixtures/build-fixtures.ts` rewrites them.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { amplitudeRow, assetCreatedProperties, type AmplitudeRow } from '../builders/amplitude.js';
import { LedgerWriter, type LedgerEntry } from '../builders/ledger.js';
import {
  chargeObject,
  checkoutSessionObject,
  disputeObject,
  invoiceObject,
  invoicePaymentObject,
  stripeEvent,
  subscriptionObject,
  type PriceInput,
  type StripeEvent,
  type SubscriptionItemInput,
} from '../builders/stripe.js';
import { emptyAttribution, orderLedgerRow, unknownConsent } from '../canonical-helpers.js';
import { OPENART } from '../constants.js';
import { Prng } from '../cohort/prng.js';
import { hashEmailFor, hashExternalIdFor } from '../normalization.js';
import { platformMappingCsv } from '../platform-event-mapping.js';
import { CREDIT_PACK, ONE_TIME_PACK, PLAN_PRICES, type CatalogPrice } from '../stripe-catalog.js';
import type {
  AudienceMember,
  ConversionLedgerEvent,
  ExperimentExposure,
  PredictedProfit,
  PurchaseValueScore,
} from '../types.js';
import { HUBSPOT_LEADS, SCENARIO_USERS as U, U01, U02, U03, U04, U05, ms, sec } from './scenarios.js';

const price = (p: CatalogPrice): PriceInput => ({
  priceId: p.priceId,
  productId: p.productId,
  unitAmountMinor: p.unitAmountMinor,
  interval: p.interval,
});
const PACK_PRICE: PriceInput = {
  priceId: CREDIT_PACK.priceId,
  productId: CREDIT_PACK.productId,
  unitAmountMinor: CREDIT_PACK.unitAmountMinor,
  interval: 'month',
};
const successQuery = (tier: number, interval: string, uid: string) =>
  // quantity=undefined is OpenArt's own template bug, reproduced faithfully (research/10 §5.3).
  `success=subscription_purchased&tier=${tier}&interval=${interval}&uid=${uid}&quantity=undefined`;

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

function paidSubscriptionInvoice(args: {
  evt: string;
  payEvt: string;
  invoice: string;
  inpay: string;
  pi: string;
  customer: string;
  subscription: string;
  reason: 'subscription_create' | 'subscription_cycle' | 'subscription_update';
  at: string;
  periodStart: string;
  periodEnd: string;
  number: string;
  lines: Array<{ id: string; amount: number; price: PriceInput; qty: number; proration: boolean; item: string; description: string; start?: string }>;
}): StripeEvent[] {
  const inv = invoiceObject({
    id: args.invoice,
    customer: args.customer,
    subscription: args.subscription,
    billingReason: args.reason,
    created: sec(args.at),
    periodStart: sec(args.periodStart),
    periodEnd: sec(args.periodEnd),
    number: args.number,
    lines: args.lines.map((l) => ({
      id: l.id,
      amountMinor: l.amount,
      price: l.price,
      quantity: l.qty,
      periodStart: sec(l.start ?? args.periodStart),
      periodEnd: sec(args.periodEnd),
      proration: l.proration,
      subscriptionItem: l.item,
      description: l.description,
    })),
  });
  const total = args.lines.reduce((s, l) => s + l.amount, 0);
  return [
    stripeEvent(args.evt, 'invoice.paid', sec(args.at) + 2, inv),
    stripeEvent(
      args.payEvt,
      'invoice_payment.paid',
      sec(args.at) + 2,
      invoicePaymentObject({ id: args.inpay, invoice: args.invoice, paymentIntent: args.pi, amountMinor: total, created: sec(args.at) }),
    ),
  ];
}

function checkoutCompleted(evt: string, o: Parameters<typeof checkoutSessionObject>[0]): StripeEvent {
  return stripeEvent(evt, 'checkout.session.completed', o.created + 1, checkoutSessionObject(o));
}

function stripeU01(): StripeEvent[] {
  const starter = price(PLAN_PRICES.essential.month);
  const events: StripeEvent[] = [
    checkoutCompleted('evt_1SynthU01CheckoutDone', {
      id: U01.checkoutSession,
      customer: U.u01.uid,
      mode: 'subscription',
      subscription: U01.subscription,
      invoice: U01.invoices[0],
      paymentIntent: null,
      amountTotalMinor: 1400,
      created: sec(U01.periods[0]) - 60,
      successQuery: successQuery(1000, 'month', U.u01.uid),
      customerEmail: U.u01.email,
    }),
  ];
  const reasons = ['subscription_create', 'subscription_cycle', 'subscription_cycle'] as const;
  for (let i = 0; i < 3; i += 1) {
    events.push(
      ...paidSubscriptionInvoice({
        evt: `evt_1SynthU01InvPaid000${i + 1}`,
        payEvt: `evt_1SynthU01InvPay000${i + 1}`,
        invoice: U01.invoices[i]!,
        inpay: `inpay_1SynthU01Pay000${i + 1}`,
        pi: U01.paymentIntents[i]!,
        customer: U.u01.uid,
        subscription: U01.subscription,
        reason: reasons[i]!,
        at: U01.periods[i]!,
        periodStart: U01.periods[i]!,
        periodEnd: U01.periods[i + 1]!,
        number: `SYNTH0001-000${i + 1}`,
        lines: [{ id: `il_1SynthU01Line000${i + 1}`, amount: 1400, price: starter, qty: 1, proration: false, item: U01.item, description: '1 × OpenArt Starter (at $14.00 / month)' }],
      }),
    );
  }
  events.push(
    stripeEvent(
      'evt_1SynthU01ChargeRefund',
      'charge.refunded',
      sec(U01.refundedAt),
      chargeObject({ id: U01.charges[2], customer: U.u01.uid, paymentIntent: U01.paymentIntents[2], amountMinor: 1400, amountRefundedMinor: 1400, created: sec(U01.periods[2]), disputed: false }),
      { amount_refunded: 0, refunded: false },
    ),
  );
  const periodItem = { id: U01.item, price: starter, quantity: 1, periodStart: sec(U01.periods[2]), periodEnd: sec(U01.periods[3]) };
  events.push(
    stripeEvent(
      'evt_1SynthU01SubCancelReq',
      'customer.subscription.updated',
      sec(U01.cancelRequestedAt),
      subscriptionObject({ id: U01.subscription, customer: U.u01.uid, status: 'active', items: [periodItem], created: sec(U01.periods[0]), cancelAtPeriodEnd: true, cancelAt: sec(U01.periods[3]), canceledAt: sec(U01.cancelRequestedAt), endedAt: null, latestInvoice: U01.invoices[2], cancellationReason: 'cancellation_requested' }),
      { cancel_at_period_end: false, cancel_at: null, canceled_at: null },
    ),
    stripeEvent(
      'evt_1SynthU01SubDeleted',
      'customer.subscription.deleted',
      sec(U01.periods[3]),
      subscriptionObject({ id: U01.subscription, customer: U.u01.uid, status: 'canceled', items: [periodItem], created: sec(U01.periods[0]), cancelAtPeriodEnd: true, cancelAt: sec(U01.periods[3]), canceledAt: sec(U01.cancelRequestedAt), endedAt: sec(U01.periods[3]), latestInvoice: U01.invoices[2], cancellationReason: 'cancellation_requested' }),
    ),
  );
  return events;
}

function stripeU02(): StripeEvent[] {
  const wonder = price(PLAN_PRICES.wonder.year);
  return [
    checkoutCompleted('evt_1SynthU02CheckoutDone', {
      id: U02.checkoutSession,
      customer: U.u02.uid,
      mode: 'subscription',
      subscription: U02.subscription,
      invoice: U02.invoice,
      paymentIntent: null,
      amountTotalMinor: wonder.unitAmountMinor,
      created: sec(U02.purchasedAt) - 90,
      successQuery: successQuery(3500, 'year', U.u02.uid),
      customerEmail: U.u02.email,
    }),
    ...paidSubscriptionInvoice({
      evt: 'evt_1SynthU02InvPaid0001',
      payEvt: 'evt_1SynthU02InvPay0001',
      invoice: U02.invoice,
      inpay: 'inpay_1SynthU02Pay0001',
      pi: U02.paymentIntent,
      customer: U.u02.uid,
      subscription: U02.subscription,
      reason: 'subscription_create',
      at: U02.purchasedAt,
      periodStart: U02.purchasedAt,
      periodEnd: U02.periodEnd,
      number: 'SYNTH0002-0001',
      lines: [{ id: 'il_1SynthU02Line0001', amount: wonder.unitAmountMinor, price: wonder, qty: 1, proration: false, item: U02.item, description: '1 × OpenArt Wonder (at $2,102.40 / year)' }],
    }),
  ];
}

function stripeU03(): StripeEvent[] {
  const plus = price(PLAN_PRICES.advanced.month);
  const pro = price(PLAN_PRICES.infinite.month);
  const start = sec(U03.purchasedAt);
  const end = sec(U03.periodEnd);
  const planItem = (p: PriceInput): SubscriptionItemInput => ({ id: U03.planItem, price: p, quantity: 1, periodStart: start, periodEnd: end });
  const packItem: SubscriptionItemInput = { id: U03.packItem, price: PACK_PRICE, quantity: 1, periodStart: start, periodEnd: end };
  const itemsList = (items: SubscriptionItemInput[]) => ({
    object: 'list',
    has_more: false,
    url: `/v1/subscription_items?subscription=${U03.subscription}`,
    data: (subscriptionObject({ id: U03.subscription, customer: U.u03.uid, status: 'active', items, created: start, cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, endedAt: null, latestInvoice: U03.invoices.first }).items as { data: unknown[] }).data,
  });
  const sub = (items: SubscriptionItemInput[], latest: string) =>
    subscriptionObject({ id: U03.subscription, customer: U.u03.uid, status: 'active', items, created: start, cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, endedAt: null, latestInvoice: latest });

  return [
    checkoutCompleted('evt_1SynthU03CheckoutDone', {
      id: U03.checkoutSession,
      customer: U.u03.uid,
      mode: 'subscription',
      subscription: U03.subscription,
      invoice: U03.invoices.first,
      paymentIntent: null,
      amountTotalMinor: 3400,
      created: start - 45,
      successQuery: successQuery(2000, 'month', U.u03.uid),
      customerEmail: U.u03.email,
    }),
    ...paidSubscriptionInvoice({
      evt: 'evt_1SynthU03InvPaid0001',
      payEvt: 'evt_1SynthU03InvPay0001',
      invoice: U03.invoices.first,
      inpay: 'inpay_1SynthU03Pay0001',
      pi: U03.paymentIntents.first,
      customer: U.u03.uid,
      subscription: U03.subscription,
      reason: 'subscription_create',
      at: U03.purchasedAt,
      periodStart: U03.purchasedAt,
      periodEnd: U03.periodEnd,
      number: 'SYNTH0003-0001',
      lines: [{ id: 'il_1SynthU03Line0001', amount: 3400, price: plus, qty: 1, proration: false, item: U03.planItem, description: '1 × OpenArt Plus (at $34.00 / month)' }],
    }),
    stripeEvent('evt_1SynthU03SubAddOn', 'customer.subscription.updated', sec(U03.addOnAt), sub([planItem(plus), packItem], U03.invoices.addOn), {
      items: itemsList([planItem(plus)]),
    }),
    ...paidSubscriptionInvoice({
      evt: 'evt_1SynthU03InvPaid0002',
      payEvt: 'evt_1SynthU03InvPay0002',
      invoice: U03.invoices.addOn,
      inpay: 'inpay_1SynthU03Pay0002',
      pi: U03.paymentIntents.addOn,
      customer: U.u03.uid,
      subscription: U03.subscription,
      reason: 'subscription_update',
      at: U03.addOnAt,
      periodStart: U03.addOnAt,
      periodEnd: U03.periodEnd,
      number: 'SYNTH0003-0002',
      lines: [{ id: 'il_1SynthU03Line0002', amount: U03.addOnProrationMinor, price: PACK_PRICE, qty: 1, proration: true, item: U03.packItem, description: 'Remaining time on 1 × Extra Credit after 25 Jun 2026' }],
    }),
    stripeEvent('evt_1SynthU03SubUpgrade', 'customer.subscription.updated', sec(U03.upgradeAt), sub([planItem(pro), packItem], U03.invoices.upgrade), {
      items: itemsList([planItem(plus), packItem]),
    }),
    ...paidSubscriptionInvoice({
      evt: 'evt_1SynthU03InvPaid0003',
      payEvt: 'evt_1SynthU03InvPay0003',
      invoice: U03.invoices.upgrade,
      inpay: 'inpay_1SynthU03Pay0003',
      pi: U03.paymentIntents.upgrade,
      customer: U.u03.uid,
      subscription: U03.subscription,
      reason: 'subscription_update',
      at: U03.upgradeAt,
      periodStart: U03.upgradeAt,
      periodEnd: U03.periodEnd,
      number: 'SYNTH0003-0003',
      lines: [
        { id: 'il_1SynthU03Line0003', amount: U03.unusedPlusMinor, price: plus, qty: 1, proration: true, item: U03.planItem, description: 'Unused time on OpenArt Plus after 05 Jul 2026' },
        { id: 'il_1SynthU03Line0004', amount: U03.remainingProMinor, price: pro, qty: 1, proration: true, item: U03.planItem, description: 'Remaining time on OpenArt Pro after 05 Jul 2026' },
      ],
    }),
  ];
}

function stripeU04(): StripeEvent[] {
  const pro = price(PLAN_PRICES.infinite.month);
  return [
    checkoutCompleted('evt_1SynthU04CheckoutDone', {
      id: U04.checkoutSession,
      customer: U.u04.uid,
      mode: 'subscription',
      subscription: U04.subscription,
      invoice: U04.invoice,
      paymentIntent: null,
      amountTotalMinor: 5600,
      created: sec(U04.purchasedAt) - 30,
      successQuery: successQuery(3000, 'month', U.u04.uid),
      customerEmail: U.u04.email,
    }),
    ...paidSubscriptionInvoice({
      evt: 'evt_1SynthU04InvPaid0001',
      payEvt: 'evt_1SynthU04InvPay0001',
      invoice: U04.invoice,
      inpay: 'inpay_1SynthU04Pay0001',
      pi: U04.paymentIntent,
      customer: U.u04.uid,
      subscription: U04.subscription,
      reason: 'subscription_create',
      at: U04.purchasedAt,
      periodStart: U04.purchasedAt,
      periodEnd: U04.periodEnd,
      number: 'SYNTH0004-0001',
      lines: [{ id: 'il_1SynthU04Line0001', amount: 5600, price: pro, qty: 1, proration: false, item: U04.item, description: '1 × OpenArt Pro (at $56.00 / month)' }],
    }),
    stripeEvent(
      'evt_1SynthU04DisputeNew',
      'charge.dispute.created',
      sec(U04.disputedAt),
      disputeObject({ id: U04.dispute, charge: U04.charge, paymentIntent: U04.paymentIntent, amountMinor: 5600, created: sec(U04.disputedAt), reason: 'fraudulent' }),
    ),
  ];
}

function stripeU05(): StripeEvent[] {
  return [
    checkoutCompleted('evt_1SynthU05PackCheckout', {
      id: U05.checkoutSession,
      customer: U.u05.uid,
      mode: 'payment',
      subscription: null,
      invoice: null,
      paymentIntent: U05.paymentIntent,
      amountTotalMinor: ONE_TIME_PACK.unitAmountMinor,
      created: sec(U05.packPurchasedAt) - 1,
      successQuery: `offer=one_time_pack_800&uid=${U.u05.uid}`,
      customerEmail: U.u05.email,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Credit ledger
// ---------------------------------------------------------------------------

function logsResponse(entries: LedgerEntry[], note: string): object {
  return { success: true, entries, hasMore: false, _synthetic_note: note };
}

function ledgerU05Observed(prng: Prng): LedgerEntry[] {
  const w = new LedgerWriter(prng.fork('ledger-u05-observed'));
  w.signupTrial(U.u05.uid, ms(U05.signupAt));
  w.consume({ userId: U.u05.uid, field: 'trial_credit_balance', businessType: 'openart-sdxl:text2image', historyId: 'SynthHistU05SdxlA001', projectId: 'SynthProjU05Main0001', unitCredits: 1, quantity: 1, atMs: ms(U05.firstGenerationAt) });
  return w.forUserNewestFirst(U.u05.uid);
}

function ledgerU05Pack(prng: Prng): LedgerEntry[] {
  const w = new LedgerWriter(prng.fork('ledger-u05-pack'));
  w.oneTimePack(U.u05.uid, U05.checkoutSession, ONE_TIME_PACK.credits, ms(U05.packPurchasedAt) + 4000);
  for (let i = 0; i < 2; i += 1) {
    w.consume({ userId: U.u05.uid, field: 'one_time_pack_credit', businessType: 'nano-banana-2:text2image', historyId: `SynthHistU05Nb2A00${i + 1}`, projectId: 'SynthProjU05Main0001', unitCredits: 20, quantity: 1, atMs: ms('2026-07-05T10:12:00Z') + i * 60_000 });
  }
  return w.forUserNewestFirst(U.u05.uid);
}

function ledgerU01(prng: Prng): LedgerEntry[] {
  const w = new LedgerWriter(prng.fork('ledger-u01'));
  const uid = U.u01.uid;
  const gen = (bt: string, n: number, unit: number, qty: number, at: string, field: 'trial_credit_balance' | 'subscription_monthly_credit' = 'subscription_monthly_credit') =>
    w.consume({ userId: uid, field, businessType: bt, historyId: `SynthHistU01Gen${String(n).padStart(5, '0')}`, projectId: 'SynthProjU01Main0001', unitCredits: unit, quantity: qty, atMs: ms(at) });
  w.signupTrial(uid, ms('2026-06-02T15:00:00Z'));
  gen('nano-banana-pro:text2image', 1, 40, 1, '2026-06-02T15:10:00Z', 'trial_credit_balance');
  w.refill(uid, U01.invoices[0], 4000, ms(U01.periods[0]) + 4000);
  gen('byte-plus-seedance-2:text2video', 2, 400, 1, '2026-06-04T10:00:00Z');
  gen('gpt-image-2-5-flare:text2image', 3, 5, 4, '2026-06-05T11:00:00Z');
  const failed = gen('byte-plus-seedance-2-5:text2video', 4, 650, 1, '2026-06-06T12:00:00Z');
  w.refundGeneration({ userId: uid, field: 'subscription_monthly_credit', businessType: failed.reference.businessType, historyId: failed.reference.businessId, credits: 650, atMs: ms('2026-06-06T12:02:00Z') });
  gen('wan3-0:text2video', 5, 200, 1, '2026-06-07T13:00:00Z');
  gen('nano-banana-2:text2image', 6, 20, 1, '2026-06-08T14:00:00Z');
  // Monthly credits don't roll over: the refill tops the plan bucket back up to 4,000.
  w.refill(uid, U01.invoices[1], 4000 - w.balance(uid, 'subscription_monthly_credit'), ms(U01.periods[1]) + 4000);
  gen('kling-v3:text2video', 7, 175, 1, '2026-07-10T09:00:00Z');
  w.refill(uid, U01.invoices[2], 4000 - w.balance(uid, 'subscription_monthly_credit'), ms(U01.periods[2]) + 4000);
  return w.forUserNewestFirst(uid);
}

function ledgerU03(prng: Prng): LedgerEntry[] {
  const w = new LedgerWriter(prng.fork('ledger-u03'));
  const uid = U.u03.uid;
  w.signupTrial(uid, ms('2026-06-14T09:00:00Z'));
  w.refill(uid, U03.invoices.first, 12000, ms(U03.purchasedAt) + 4000);
  w.creditPack(uid, U03.invoices.addOn, CREDIT_PACK.creditsPerPack, ms(U03.addOnAt) + 4000);
  w.consume({ userId: uid, field: 'subscription_monthly_credit', businessType: 'veo3-1:text2video', historyId: 'SynthHistU03Veo00001', projectId: 'SynthProjU03Main0001', unitCredits: 160, quantity: 1, atMs: ms('2026-06-26T16:00:00Z') });
  // INFERRED: an upgrade grants the allowance difference (Pro 24,000 - Plus 12,000).
  w.refill(uid, U03.invoices.upgrade, 12000, ms(U03.upgradeAt) + 4000);
  return w.forUserNewestFirst(uid);
}

// ---------------------------------------------------------------------------
// Amplitude
// ---------------------------------------------------------------------------

const AB_IMAGE = 'ab_suite-default-model-create-image';
const AB_VIDEO = 'ab_suite-default-model-create-video';

function u01UserProps(subscribed: boolean): Record<string, unknown> {
  return {
    signed_in: true,
    subscription_active: subscribed,
    ...(subscribed ? { subscription_tier: 'essential' } : {}),
    subscription_source: 'v2',
    creation_panel_version: 'v2',
    signup_date: '2026-06-02',
    signup_at: '2026-06-02T15:00:00Z',
    [AB_IMAGE]: 'nano-banana-pro',
    [AB_VIDEO]: 'byte-plus-seedance-2',
    initial_utm_source: 'google',
    initial_utm_medium: 'cpc',
    initial_utm_campaign: 'synth_search_brand',
    initial_gclid: 'Cj0KCQjwSYNTHgclidU01',
    gclid: 'Cj0KCQjwSYNTHgclidU01',
  };
}

function amplitudeFixtures(prng: Prng): { assets: AmplitudeRow[]; exposures: AmplitudeRow[]; checkout: AmplitudeRow[] } {
  const p = prng.fork('amplitude');
  let eventId = 100;
  const session = ms('2026-06-02T14:58:00Z');
  const row = (uid: string | null, deviceId: string, type: string, at: string, props: Record<string, unknown>, userProps: Record<string, unknown>, sessionId = session) =>
    amplitudeRow(p, { eventType: type, atMs: ms(at), userId: uid, deviceId, sessionId, eventId: (eventId += 1), eventProperties: props, userProperties: userProps });

  const u05Props = {
    signed_in: true,
    subscription_active: false,
    subscription_source: 'v2',
    creation_panel_version: 'v2',
    signup_date: '2026-07-01',
    signup_at: '2026-07-01T10:00:00Z',
    [AB_IMAGE]: 'gpt-image-2-5',
    [AB_VIDEO]: 'wan3-0',
  };
  const assets = [
    row(U.u05.uid, U.u05.deviceId, 'asset_created', U05.firstGenerationAt, assetCreatedProperties({ model: 'openart-sdxl', creationMode: 'image', featureName: 'text_to_image', assetNum: 1, creditsNum: 1 }), u05Props, ms('2026-07-01T09:59:00Z')),
    row(U.u01.uid, U.u01.deviceId, 'asset_created', '2026-06-02T15:10:00Z', assetCreatedProperties({ model: 'nano-banana-pro', creationMode: 'image', featureName: 'text_to_image', assetNum: 1, creditsNum: 40 }), u01UserProps(false)),
    row(U.u01.uid, U.u01.deviceId, 'asset_created', '2026-06-04T10:00:00Z', assetCreatedProperties({ model: 'byte-plus-seedance-2', creationMode: 'video', featureName: 'text_to_video', assetNum: 1, creditsNum: 400 }), u01UserProps(true), ms('2026-06-04T09:55:00Z')),
    row(U.u01.uid, U.u01.deviceId, 'asset_created', '2026-06-05T11:00:00Z', assetCreatedProperties({ model: 'gpt-image-2-5', creationMode: 'image', featureName: 'text_to_image', assetNum: 4, creditsNum: 20 }), u01UserProps(true), ms('2026-06-05T10:58:00Z')),
  ];
  const exposures = [
    row(U.u01.uid, U.u01.deviceId, 'experiment_flags_ready', '2026-06-02T14:58:05Z', { [AB_IMAGE]: 'nano-banana-pro', [AB_VIDEO]: 'byte-plus-seedance-2' }, u01UserProps(false)),
    row(U.u01.uid, U.u01.deviceId, '$exposure', '2026-06-02T14:58:06Z', { flag_key: 'suite-default-model-create-image', variant: 'nano-banana-pro' }, u01UserProps(false)),
    row(U.u01.uid, U.u01.deviceId, '$exposure', '2026-06-02T14:58:06Z', { flag_key: 'suite-default-model-create-video', variant: 'byte-plus-seedance-2' }, u01UserProps(false)),
    row(U.u05.uid, U.u05.deviceId, '$exposure', '2026-07-01T09:59:30Z', { flag_key: 'suite-default-model-create-image', variant: 'gpt-image-2-5' }, u05Props, ms('2026-07-01T09:59:00Z')),
  ];
  const buySession = ms('2026-06-03T16:55:00Z');
  const conv = (channel: string, fired: boolean, outcome: string) =>
    row(U.u01.uid, U.u01.deviceId, 'conversion_reported', '2026-06-03T17:05:02Z', { report_layer: 'client', channel, conversion_type: 'purchase', environment: 'production', fired, outcome, gclid: 'Cj0KCQjwSYNTHgclidU01' }, u01UserProps(true), buySession);
  const checkout = [
    row(U.u01.uid, U.u01.deviceId, 'subscription_started', U01.checkoutStartedAt, { device: 'pc', creation_panel_version: 'v2', subscription_tier: 'essential', subscription_interval: 'month', click_source: 'plan_card' }, u01UserProps(false), buySession),
    conv('google_ads', true, 'fired'),
    conv('meta_pixel', true, 'fired'),
    conv('bing_uet', true, 'fired'),
    conv('openai_ads', true, 'fired'),
  ];
  return { assets, exposures, checkout };
}

// ---------------------------------------------------------------------------
// Click ids, HubSpot, app API
// ---------------------------------------------------------------------------

const T0 = ms('2026-06-02T14:57:40Z');
const clickIdsCurrent = [
  { gclid: 'Cj0KCQjwSYNTHgclidU01', gclid_created_at: T0 },
  { fbclid: 'IwAR3SYNTHfbclidU03xYz', fbclid_created_at: ms('2026-06-14T08:58:00Z'), ttclid: 'E.CPSYNTHttclidU03.1718355480', ttclid_created_at: ms('2026-06-13T20:01:00Z') },
];
const clickIdsExtended = [
  {
    gclid: 'Cj0KCQjwSYNTHgclidU01',
    gclid_created_at: T0,
    gbraid: '0AAAAASYNTHgbraidU01',
    gbraid_created_at: T0,
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'synth_search_brand',
    landing_url: 'https://openart.ai/ai-model/seedance-2-5/?utm_source=google&utm_medium=cpc&utm_campaign=synth_search_brand&gclid=Cj0KCQjwSYNTHgclidU01',
    referrer: 'https://www.google.com/',
    context_captured_at: T0,
  },
  {
    rdt_cid: 'SYNTHrdtcidU04.reddit',
    rdt_cid_created_at: ms('2026-07-19T21:00:00Z'),
    twclid: 'SYNTHtwclidU04',
    twclid_created_at: ms('2026-07-18T12:00:00Z'),
    li_fat_id: '4f1c2a9e-5b6d-4e8f-9a0b-aaaaa0000004',
    li_fat_id_created_at: ms('2026-07-17T08:00:00Z'),
    oppref: 'SYNTHoppref_U04',
    oppref_created_at: ms('2026-07-19T21:05:00Z'),
    msclkid: 'b1c2d3e4f5a6478899aa000000000004',
    msclkid_created_at: ms('2026-07-19T20:00:00Z'),
    referrer: '',
    context_captured_at: ms('2026-07-19T21:05:00Z'),
  },
];
const oaAdClidsStore = {
  gclid: { v: 'Cj0KCQjwSYNTHgclidU01', ts: T0 },
  gbraid: { v: '0AAAAASYNTHgbraidU01', ts: T0 },
  fbclid: { v: 'IwAR3SYNTHfbclidU03xYz', ts: ms('2026-06-14T08:58:00Z') },
};

function hubspotSubmissions(): object[] {
  const fields = (email: string, first: string, company: string, size: string, gclid: string | null) => [
    { objectTypeId: '0-1', name: 'firstname', value: first },
    { objectTypeId: '0-1', name: 'lastname', value: 'Synthetic' },
    { objectTypeId: '0-1', name: 'company', value: company },
    { objectTypeId: '0-1', name: 'jobtitle', value: 'Head of Creative' },
    { objectTypeId: '0-1', name: 'company_size', value: size },
    { objectTypeId: '0-1', name: 'email', value: email },
    { objectTypeId: '0-1', name: 'message', value: 'Video ads at scale for our brand team.' },
    // Hidden defaults hard-coded in the live form (research/00 B1).
    { objectTypeId: '0-1', name: 'lead_source', value: 'Event' },
    { objectTypeId: '0-1', name: 'latest_form_submit_url', value: 'https://openart.ai/enterprise/#contact' },
    ...(gclid ? [{ objectTypeId: '0-1', name: 'gclid', value: gclid }] : []),
    { objectTypeId: '0-1', name: 'lead_source_detail', value: 'Brandweek' },
  ];
  return [
    {
      conversionId: HUBSPOT_LEADS.adClick.conversionId,
      submittedAt: ms(HUBSPOT_LEADS.adClick.submittedAt),
      pageUrl: 'https://openart.ai/enterprise?gclid=Cj0KCQjwSYNTHgclidLEAD1',
      values: fields('lead.one@synthetic-brand.example.test', 'Avery', 'Synthetic Brand Co', '101-1,000', 'Cj0KCQjwSYNTHgclidLEAD1'),
    },
    {
      conversionId: HUBSPOT_LEADS.organic.conversionId,
      submittedAt: ms(HUBSPOT_LEADS.organic.submittedAt),
      pageUrl: 'https://openart.ai/enterprise',
      values: fields('lead.two@synthetic-studio.example.test', 'Jordan', 'Synthetic Studio', '11-100', null),
    },
  ];
}

function hubspotLifecycle(): object[] {
  const base = { subscriptionId: 2100001, portalId: OPENART.hubspot.portalId, appId: 3100001, subscriptionType: 'contact.propertyChange', attemptNumber: 0, objectId: HUBSPOT_LEADS.adClick.contactId, propertyName: 'lifecyclestage', changeSource: 'CRM_UI', sourceId: 'userId:0' };
  return [
    { ...base, eventId: 4100001, occurredAt: ms(HUBSPOT_LEADS.mqlAt), propertyValue: 'marketingqualifiedlead' },
    { ...base, eventId: 4100002, occurredAt: ms(HUBSPOT_LEADS.sqlAt), propertyValue: 'salesqualifiedlead' },
  ];
}

const invoiceLookups = [
  // ltvValueMajor is ILLUSTRATIVE: the backend's LTV model is not visible.
  { invoiceId: U01.invoices[0], isFirstPurchase: true, isValidInvoice: true, isBusiness: false, amountMinor: 1400, amountMajor: 14, currency: 'usd', ltvValueMajor: 61.25, ltvCurrency: 'usd' },
  { invoiceId: U02.invoice, isFirstPurchase: true, isValidInvoice: true, isBusiness: false, amountMinor: 210240, amountMajor: 2102.4, currency: 'usd', ltvValueMajor: null, ltvCurrency: null },
];

// ---------------------------------------------------------------------------
// Golden canonical rows
// ---------------------------------------------------------------------------

type Row = ConversionLedgerEvent;
const ARMS_U01 = { 'suite-default-model-create-image': 'nano-banana-pro', 'suite-default-model-create-video': 'byte-plus-seedance-2' };
const ARMS_U05 = { 'suite-default-model-create-image': 'gpt-image-2-5', 'suite-default-model-create-video': 'wan3-0' };

function blank(): Omit<Row, 'event_id' | 'event_name' | 'occurred_at' | 'source_system' | 'source_event_id'> {
  return {
    schema_version: 1,
    user_id: null,
    device_id: null,
    order_id: null,
    adjusts_event_id: null,
    adjusts_order_id: null,
    cash_value_minor: null,
    currency: null,
    invoice_id: null,
    subscription_id: null,
    checkout_session_id: null,
    charge_id: null,
    plan_tier: null,
    plan_tier_code: null,
    billing_interval: null,
    previous_plan_tier: null,
    credit_pack_quantity: null,
    is_first_purchase: null,
    is_business: null,
    generation: null,
    lead: null,
    ...emptyAttribution(),
    consent: unknownConsent('US'),
    experiment_arms: {},
  };
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const gclidU01 = { gclid: { value: 'Cj0KCQjwSYNTHgclidU01', created_at: new Date(T0).toISOString() } };

function goldenRows(ledgerU05: LedgerEntry[], amp: { checkout: AmplitudeRow[] }): Row[] {
  const trialAdd = ledgerU05.find((e) => e.type === 'ADD')!;
  const sdxl = ledgerU05.find((e) => e.type === 'CONSUME')!;
  const subscriptionStarted = amp.checkout[0]!;
  const u01Purchase = (name: Row['event_name'], idx: number, evt: string, first: boolean): Row => ({
    ...blank(),
    event_id: `purchase_${U01.invoices[idx]}`,
    event_name: name,
    occurred_at: iso(sec(U01.periods[idx]!)),
    source_system: 'stripe',
    source_event_id: evt,
    user_id: U.u01.uid,
    device_id: U.u01.deviceId,
    order_id: `sub_${U01.invoices[idx]}`,
    cash_value_minor: 1400,
    currency: 'USD',
    invoice_id: U01.invoices[idx]!,
    subscription_id: U01.subscription,
    checkout_session_id: first ? U01.checkoutSession : null,
    plan_tier: 'essential',
    plan_tier_code: 1000,
    billing_interval: 'month',
    is_first_purchase: first,
    is_business: false,
    click_ids: gclidU01,
    utm: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'synth_search_brand' },
    experiment_arms: ARMS_U01,
  });
  const u03Base = {
    ...blank(),
    source_system: 'stripe' as const,
    user_id: U.u03.uid,
    device_id: U.u03.deviceId,
    currency: 'USD',
    subscription_id: U03.subscription,
    billing_interval: 'month' as const,
    is_first_purchase: false,
    is_business: false,
  };
  return [
    {
      ...blank(),
      event_id: `reg_${U.u05.uid}`,
      event_name: 'signup',
      occurred_at: trialAdd.createdAt.replace('.000Z', 'Z'),
      source_system: 'credit_ledger',
      source_event_id: trialAdd.id,
      user_id: U.u05.uid,
      device_id: U.u05.deviceId,
      experiment_arms: ARMS_U05,
    },
    {
      ...blank(),
      event_id: `activation_${U.u05.uid}`,
      event_name: 'activation_first_generation',
      occurred_at: sdxl.createdAt.replace('.000Z', 'Z'),
      source_system: 'credit_ledger',
      source_event_id: sdxl.id,
      user_id: U.u05.uid,
      device_id: U.u05.deviceId,
      generation: { business_type: 'openart-sdxl:text2image', model_id: 'openart-sdxl', credits: 1 },
      experiment_arms: ARMS_U05,
    },
    {
      ...blank(),
      event_id: `checkout_${subscriptionStarted.uuid}`,
      event_name: 'checkout_started',
      occurred_at: U01.checkoutStartedAt,
      source_system: 'amplitude',
      source_event_id: subscriptionStarted.uuid,
      user_id: U.u01.uid,
      device_id: U.u01.deviceId,
      plan_tier: 'essential',
      plan_tier_code: 1000,
      billing_interval: 'month',
      click_ids: gclidU01,
      experiment_arms: ARMS_U01,
    },
    u01Purchase('purchase_first', 0, 'evt_1SynthU01InvPaid0001', true),
    u01Purchase('purchase_renewal', 1, 'evt_1SynthU01InvPaid0002', false),
    {
      ...u03Base,
      event_id: `purchase_${U03.invoices.upgrade}`,
      event_name: 'purchase_upgrade',
      occurred_at: U03.upgradeAt,
      source_event_id: 'evt_1SynthU03InvPaid0003',
      order_id: `sub_${U03.invoices.upgrade}`,
      cash_value_minor: U03.unusedPlusMinor + U03.remainingProMinor,
      invoice_id: U03.invoices.upgrade,
      plan_tier: 'infinite',
      plan_tier_code: 3000,
      previous_plan_tier: 'advanced',
      credit_pack_quantity: 1,
    },
    {
      ...u03Base,
      event_id: `purchase_${U03.invoices.addOn}`,
      event_name: 'purchase_add_on',
      occurred_at: U03.addOnAt,
      source_event_id: 'evt_1SynthU03InvPaid0002',
      order_id: `sub_${U03.invoices.addOn}`,
      cash_value_minor: U03.addOnProrationMinor,
      invoice_id: U03.invoices.addOn,
      plan_tier: 'advanced',
      plan_tier_code: 2000,
      credit_pack_quantity: 1,
    },
    {
      ...blank(),
      event_id: `purchase_${U05.checkoutSession}`,
      event_name: 'purchase_one_time_pack',
      occurred_at: U05.packPurchasedAt,
      source_system: 'stripe',
      source_event_id: 'evt_1SynthU05PackCheckout',
      user_id: U.u05.uid,
      device_id: U.u05.deviceId,
      order_id: `sub_${U05.checkoutSession}`,
      cash_value_minor: ONE_TIME_PACK.unitAmountMinor,
      currency: 'USD',
      checkout_session_id: U05.checkoutSession,
      is_first_purchase: true,
      is_business: false,
      experiment_arms: ARMS_U05,
    },
    {
      ...blank(),
      event_id: `refund_${U01.charges[2]}_1400`,
      event_name: 'refund',
      occurred_at: U01.refundedAt,
      source_system: 'stripe',
      source_event_id: 'evt_1SynthU01ChargeRefund',
      user_id: U.u01.uid,
      device_id: U.u01.deviceId,
      adjusts_event_id: `purchase_${U01.invoices[2]}`,
      adjusts_order_id: `sub_${U01.invoices[2]}`,
      cash_value_minor: -1400,
      currency: 'USD',
      invoice_id: U01.invoices[2],
      subscription_id: U01.subscription,
      charge_id: U01.charges[2],
      plan_tier: 'essential',
      plan_tier_code: 1000,
      billing_interval: 'month',
      experiment_arms: ARMS_U01,
    },
    {
      ...blank(),
      event_id: `chargeback_${U04.dispute}`,
      event_name: 'chargeback',
      occurred_at: U04.disputedAt,
      source_system: 'stripe',
      source_event_id: 'evt_1SynthU04DisputeNew',
      user_id: U.u04.uid,
      device_id: U.u04.deviceId,
      adjusts_event_id: `purchase_${U04.invoice}`,
      adjusts_order_id: `sub_${U04.invoice}`,
      cash_value_minor: -5600,
      currency: 'USD',
      invoice_id: U04.invoice,
      subscription_id: U04.subscription,
      charge_id: U04.charge,
      plan_tier: 'infinite',
      plan_tier_code: 3000,
      billing_interval: 'month',
    },
    {
      ...blank(),
      event_id: `lead_${HUBSPOT_LEADS.adClick.conversionId}`,
      event_name: 'enterprise_lead',
      occurred_at: HUBSPOT_LEADS.adClick.submittedAt,
      source_system: 'hubspot',
      source_event_id: HUBSPOT_LEADS.adClick.conversionId,
      lead: {
        hubspot_portal_id: OPENART.hubspot.portalId,
        form_id: OPENART.hubspot.enterpriseFormId,
        contact_id: String(HUBSPOT_LEADS.adClick.contactId),
        lifecycle_stage: 'lead',
        previous_lifecycle_stage: null,
        lead_source: 'Event',
        lead_source_detail: 'Brandweek',
        company_size: '101-1,000',
      },
      click_ids: { gclid: { value: 'Cj0KCQjwSYNTHgclidLEAD1', created_at: null } },
    },
    {
      ...blank(),
      event_id: `leadstage_${HUBSPOT_LEADS.adClick.contactId}_salesqualifiedlead`,
      event_name: 'lead_stage_change',
      occurred_at: HUBSPOT_LEADS.sqlAt,
      source_system: 'hubspot',
      source_event_id: '4100002',
      lead: {
        hubspot_portal_id: OPENART.hubspot.portalId,
        form_id: null,
        contact_id: String(HUBSPOT_LEADS.adClick.contactId),
        lifecycle_stage: 'salesqualifiedlead',
        previous_lifecycle_stage: 'marketingqualifiedlead',
        lead_source: 'Event',
        lead_source_detail: 'Brandweek',
        company_size: '101-1,000',
      },
    },
  ];
}

/** ILLUSTRATIVE predictions: the numbers show the contract, not a trained model. */
const predictedProfit: PredictedProfit[] = [
  {
    user_id: U.u01.uid,
    computed_at: '2026-06-03T15:00:00Z',
    horizon_days: 90,
    feature_window_hours: 24,
    currency: 'USD',
    predicted_revenue: 36.4,
    predicted_generation_cost: 11.9,
    predicted_fees: 1.66,
    predicted_refund_risk: 0.73,
    refund_probability: 0.05,
    predicted_profit: 22.11,
    model_version: 'illustrative-heuristic-0.1',
    features: { plan_tier: null, arm_create_image: 'nano-banana-pro', arm_create_video: 'byte-plus-seedance-2', generations_24h: 1, video_generations_24h: 0, credits_consumed_24h: 40, generation_cost_24h_usd: 0.134, paid_within_24h: false, acquisition_channel: 'google_cpc' },
  },
  {
    user_id: U.u02.uid,
    computed_at: '2026-06-11T21:30:00Z',
    horizon_days: 90,
    feature_window_hours: 24,
    currency: 'USD',
    predicted_revenue: 2102.4,
    predicted_generation_cost: 612.5,
    predicted_fees: 61.27,
    predicted_refund_risk: 42.05,
    refund_probability: 0.02,
    predicted_profit: 1386.58,
    model_version: 'illustrative-heuristic-0.1',
    features: { plan_tier: 'wonder', billing_interval: 'year', paid_within_24h: true, first_purchase_value_usd: 2102.4, generations_24h: 14, video_generations_24h: 9 },
  },
];

/**
 * ILLUSTRATIVE purchase-time scores (E[gross_profit_90d | purchase]) for golden purchases.
 * u05's one-time pack is a loss-maker: heavy video generation costs more than the pack.
 */
const purchaseValueScores: PurchaseValueScore[] = [
  {
    event_id: 'purchase_in_1SynthU01Inv0001First',
    invoice_id: 'in_1SynthU01Inv0001First',
    user_id: U.u01.uid,
    occurred_at: '2026-06-03T17:04:11Z',
    scored_at: '2026-06-03T17:04:52Z',
    estimand: 'E[gross_profit_90d | purchase]',
    horizon_days: 90,
    predicted_revenue_90d: 36.4,
    predicted_generation_cost_90d: 11.9,
    predicted_fees_90d: 1.66,
    predicted_refund_risk: 0.73,
    predicted_profit_90d: 22.11,
    interval_low: 15.4,
    interval_high: 28.9,
    cash_value: 14,
    currency: 'USD',
    model_version: 'purchase-value-illustrative-0.1',
    run_id: 'pv_run_2026-06-03T17:04:52Z',
    fitted_params_ref: 'gs://openart-signal-example/purchase-value/illustrative-0.1/params.json',
    features_snapshot: { as_of: '2026-06-03T17:04:11Z', event_name: 'purchase_first', plan_tier: 'essential', billing_interval: 'month', generations_before_purchase: 1, credits_consumed_before_purchase: 40, acquisition_channel: 'google_cpc' },
  },
  {
    event_id: 'purchase_in_1SynthU03Inv0002AddOn',
    invoice_id: 'in_1SynthU03Inv0002AddOn',
    user_id: U.u03.uid,
    occurred_at: '2026-06-25T12:00:00Z',
    scored_at: '2026-06-25T12:00:31Z',
    estimand: 'E[gross_profit_90d | purchase]',
    horizon_days: 90,
    predicted_revenue_90d: 58.3,
    predicted_generation_cost_90d: 24.1,
    predicted_fees_90d: 2.35,
    predicted_refund_risk: 0.9,
    predicted_profit_90d: 30.95,
    interval_low: 21.2,
    interval_high: 40.1,
    cash_value: 10,
    currency: 'USD',
    model_version: 'purchase-value-illustrative-0.1',
    run_id: 'pv_run_2026-06-25T12:00:31Z',
    fitted_params_ref: 'gs://openart-signal-example/purchase-value/illustrative-0.1/params.json',
    features_snapshot: { as_of: '2026-06-25T12:00:00Z', event_name: 'purchase_add_on', plan_tier: 'advanced', billing_interval: 'month', credit_pack_quantity: 1, last_generation_at: '2026-06-25T11:48:00Z' },
  },
  {
    event_id: 'purchase_cs_live_a1SynthU05Pack00000001',
    invoice_id: null,
    user_id: U.u05.uid,
    occurred_at: '2026-07-05T10:00:00Z',
    scored_at: '2026-07-05T10:00:44Z',
    estimand: 'E[gross_profit_90d | purchase]',
    horizon_days: 90,
    predicted_revenue_90d: 12.5,
    predicted_generation_cost_90d: 15.8,
    predicted_fees_90d: 0.67,
    predicted_refund_risk: 0.4,
    predicted_profit_90d: -4.37,
    interval_low: -9.1,
    interval_high: 0.6,
    cash_value: 9.99,
    currency: 'USD',
    model_version: 'purchase-value-illustrative-0.1',
    run_id: 'pv_run_2026-07-05T10:00:44Z',
    fitted_params_ref: 'gs://openart-signal-example/purchase-value/illustrative-0.1/params.json',
    features_snapshot: { as_of: '2026-07-05T10:00:00Z', event_name: 'purchase_one_time_pack', plan_tier: null, video_generations_before_purchase: 6, acquisition_channel: null },
  },
];

const exposures: ExperimentExposure[] = [
  { user_id: U.u01.uid, flag_key: 'suite-default-model-create-image', arm: 'nano-banana-pro', first_exposed_at: '2026-06-02T14:58:06Z', source: 'amplitude_exposure_event', device_id: U.u01.deviceId },
  { user_id: U.u05.uid, flag_key: 'suite-default-model-create-video', arm: 'wan3-0', first_exposed_at: '2026-07-01T09:59:30Z', source: 'amplitude_user_property', device_id: U.u05.deviceId },
];

function audienceMembers(): AudienceMember[] {
  return [
    { platform: 'meta', list_name: 'oa_high_predicted_profit_90d', action: 'add', reason: 'high_predicted_profit', identifiers: { email_sha256: hashEmailFor('meta', U.u02.email), external_id_sha256: hashExternalIdFor('meta', U.u02.uid) }, value: 1386.58, user_id: U.u02.uid, computed_at: '2026-06-11T22:00:00Z' },
    { platform: 'reddit', list_name: 'oa_high_predicted_profit_90d', action: 'add', reason: 'high_predicted_profit', identifiers: { email_sha256: hashEmailFor('reddit', U.u02.email) }, value: null, user_id: U.u02.uid, computed_at: '2026-06-11T22:00:00Z' },
    { platform: 'google_ads', list_name: 'oa_refund_or_chargeback_suppress', action: 'add', reason: 'refund_or_chargeback_suppression', identifiers: { email_sha256: hashEmailFor('google_ads', U.u04.email) }, value: null, user_id: U.u04.uid, computed_at: '2026-08-02T12:00:00Z' },
  ];
}

// ---------------------------------------------------------------------------

const json = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** relative path under fixtures/ -> file content */
export function buildAllFixtures(): Record<string, string> {
  const prng = new Prng('openart-signal/fixtures/v1');
  const ledger05 = ledgerU05Observed(prng);
  const amp = amplitudeFixtures(prng);
  const INFERRED = 'SYNTHETIC. businessType values other than USER_SIGNUP_TRIAL and openart-sdxl:text2image are INFERRED from capability ids in shipped code; subscription-refill is an INFERRED name for SUBSCRIPTION_ADJUSTMENT "Subscription Refill" rows.';
  return {
    'stripe/u01_starter_monthly_renewals_refund.json': json(stripeU01()),
    'stripe/u02_wonder_annual.json': json(stripeU02()),
    'stripe/u03_plus_add_on_then_upgrade.json': json(stripeU03()),
    'stripe/u04_pro_monthly_chargeback.json': json(stripeU04()),
    'stripe/u05_one_time_pack.json': json(stripeU05()),
    'credit_ledger/u05_observed_shape_trial_and_sdxl.json': json(logsResponse(ledger05, 'SYNTHETIC values in the exact observed shape (crawl/loggedin/generation/ledger_post.json): trial ADD + openart-sdxl:text2image CONSUME.')),
    'credit_ledger/u05_one_time_pack.json': json(logsResponse(ledgerU05Pack(prng), INFERRED)),
    'credit_ledger/u01_default_arm_models_and_refills.json': json(logsResponse(ledgerU01(prng), INFERRED)),
    'credit_ledger/u03_credit_pack_and_upgrade.json': json(logsResponse(ledgerU03(prng), `${INFERRED} Upgrade grant of the allowance difference is INFERRED.`)),
    'amplitude/asset_created.jsonl': jsonl(amp.assets),
    'amplitude/exposures.jsonl': jsonl(amp.exposures),
    'amplitude/checkout_and_conversion_reported.jsonl': jsonl(amp.checkout),
    'click_ids/current_payloads.json': json(clickIdsCurrent),
    'click_ids/extended_payloads.json': json(clickIdsExtended),
    'click_ids/oa_ad_clids_store.json': json(oaAdClidsStore),
    'hubspot/enterprise_form_submissions.json': json(hubspotSubmissions()),
    'hubspot/contact_lifecycle_changes.json': json(hubspotLifecycle()),
    'app_api/checkout_session_invoice.json': json(invoiceLookups),
    'canonical/conversion_ledger_events.jsonl': jsonl(goldenRows(ledger05, amp).map(orderLedgerRow)),
    'canonical/predicted_profit.jsonl': jsonl(predictedProfit),
    'canonical/purchase_value_scores.jsonl': jsonl(purchaseValueScores),
    'canonical/experiment_exposures.jsonl': jsonl(exposures),
    'canonical/audience_members.jsonl': jsonl(audienceMembers()),
    'seeds/platform_event_mapping.csv': platformMappingCsv(),
  };
}

/** CLI: rewrite fixtures/ from the scenario definitions. */
export function writeAllFixtures(root = fileURLToPath(new URL('../../fixtures/', import.meta.url))): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(buildAllFixtures())) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(rel);
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const rel of writeAllFixtures()) console.log(`wrote fixtures/${rel}`);
}
