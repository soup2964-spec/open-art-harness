/**
 * Stripe Event -> canonical ConversionLedgerEvent rows, following the contracts rules
 * (integration-map §2.8, event-ids.ts):
 *
 *   invoice.paid  subscription_create                       -> purchase_first (+ is_first_purchase)
 *                 subscription_cycle                        -> purchase_renewal
 *                 subscription_update, higher tier          -> purchase_upgrade (tiers ranked
 *                   Starter < Plus < Pro < Wonder < Team < Business; within a tier and interval a
 *                   higher price, e.g. a bigger Business credit size; a same-tier interval switch is
 *                   not an upgrade, and raw prices are never compared across intervals)
 *                 subscription_update, CreditPack line      -> purchase_add_on
 *   checkout.session.completed, mode=payment (paid)         -> purchase_one_time_pack
 *   charge.refunded                                         -> refund      (adjusts the purchase)
 *   charge.dispute.created                                  -> chargeback  (adjusts the purchase)
 *   invoice_payment.paid, checkout.session.completed (subscription mode),
 *   customer.subscription.updated / .deleted                -> join state only
 *
 * Stripe does not guarantee ordering, so every join (payment intent -> invoice,
 * subscription -> current plan, purchase row) is looked up in state. When a dependency is
 * missing the event is PARKED on a dependency key and re-driven when that key is satisfied;
 * past the parking deadline it is mapped in degraded mode (cash kept, joins left null).
 *
 * State writes are idempotent and concurrency-safe (subscription state and per-charge refund state
 * are compare-and-set), so a replay maps an event to exactly the same rows. Every state document
 * carries the user id (erasure) and an expire_at refreshed on each write (retention).
 */

import {
  CREDIT_PACK,
  PLAN_TIER_CODES,
  STRIPE_PRODUCTS,
  TIER_CODE,
  canonicalEventId,
  canonicalOrderId,
  emptyAttribution,
  planFromPriceId,
  purchaseEventId,
  purchaseIdsForCheckoutSession,
  purchaseOrderId,
  tierFromProductId,
  unknownConsent,
} from '@openart-signal/contracts';
import type { BillingInterval, ConversionLedgerEvent, PlanTier, PurchaseEventName } from '@openart-signal/contracts';
import type { DocumentStore } from '../adapters/document-store.js';
import type { Ledger } from '../adapters/ledger.js';
import { LEDGER_LOOKBACK_DAYS } from '../adapters/ledger.js';
import { RETENTION, expireAt } from '../retention.js';
import { DAY_MS, systemClock, toUtc } from '../time.js';
import type { Clock } from '../time.js';
import type { NormalizedEvent } from '../types.js';
import type { StripeEvent, StripeObject } from './stripe-types.js';

export const STRIPE_STATE = {
  paymentIntents: 'stripe_payment_intents',
  charges: 'stripe_charges',
  invoiceCheckout: 'stripe_invoice_checkout',
  subscriptions: 'stripe_subscriptions',
  chargeRefunds: 'stripe_charge_refunds',
} as const;

export type StripeMapResult =
  | { kind: 'rows'; rows: NormalizedEvent[]; satisfies: string[] }
  | { kind: 'park'; dependency: string; reason: string; satisfies: string[] }
  | { kind: 'ignore'; reason: string; satisfies: string[] }
  | { kind: 'state'; note: string; satisfies: string[] };

export interface StripeMapOptions {
  /** Past the parking deadline: emit what is known instead of waiting for a join. */
  degraded?: boolean;
}

/** What a refund/chargeback needs to know about the purchase it adjusts. */
interface PurchaseRef {
  purchase_event_id: string;
  purchase_order_id: string;
  invoice_id: string | null;
  checkout_session_id: string | null;
  user_id?: string | null;
  expire_at?: string;
}

/** Per-charge refund state (compare-and-set). */
interface ChargeRefundState {
  max_cumulative_refunded: number;
  /** cumulative amount -> the amount refunded before it, so a replay computes the same delta. */
  previous_by_cumulative: Record<string, number>;
  user_id: string | null;
  expire_at: string;
}

/** Plan rank = OpenArt's tier codes: Starter 1000 < Plus 2000 < Pro 3000 < Wonder 3500 < Team 4000 < Business 44xx. */
const TIER_RANK: Readonly<Record<PlanTier, number>> = { essential: 1, advanced: 2, infinite: 3, wonder: 4, team: 5, business: 6 };

type PlanChange = 'upgrade' | 'downgrade' | 'interval_change' | 'same' | 'unknown';

/** Compare the plan a proration credits back (from) with the plan it charges (to). */
function classifyPlanChange(from: LineInfo, to: LineInfo): PlanChange {
  if (from.tier && to.tier && from.tier !== to.tier) return TIER_RANK[to.tier] > TIER_RANK[from.tier] ? 'upgrade' : 'downgrade';
  if (from.interval && to.interval && from.interval !== to.interval) {
    // Same tier on another interval: a billing switch, not a better plan (and raw prices are per interval).
    if (from.tier && to.tier) return 'interval_change';
    const monthly = (l: LineInfo) => (l.unit_amount === null ? null : l.interval === 'year' ? l.unit_amount / 12 : l.unit_amount);
    const a = monthly(from);
    const b = monthly(to);
    if (a === null || b === null) return 'unknown';
    return b > a ? 'upgrade' : 'interval_change';
  }
  if (from.unit_amount === null || to.unit_amount === null) return 'unknown';
  if (to.unit_amount > from.unit_amount) return 'upgrade';
  return to.unit_amount < from.unit_amount ? 'downgrade' : 'same';
}

interface PlanInfo {
  tier: PlanTier;
  interval: BillingInterval | null;
  price_id: string | null;
  unit_amount: number | null;
}

interface SubscriptionState {
  subscription_id: string;
  /** Stripe timestamp (s) of the snapshot; a lower version never overwrites a higher one. */
  version: number;
  status: string | null;
  plan: PlanInfo | null;
  pack_quantity: number | null;
  user_id?: string | null;
  expire_at?: string;
}

interface LineInfo {
  amount: number;
  quantity: number;
  price_id: string | null;
  product_id: string | null;
  unit_amount: number | null;
  interval: BillingInterval | null;
  kind: 'plan' | 'pack' | 'other';
  tier: PlanTier | null;
}

type Obj = Record<string, any>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const asInterval = (v: unknown): BillingInterval | null => (v === 'month' || v === 'year' ? v : null);

function tierForProduct(productId: string | null): PlanTier | null {
  if (!productId) return null;
  const selfServe = tierFromProductId(productId);
  if (selfServe) return selfServe;
  if (productId === STRIPE_PRODUCTS.team) return 'team';
  if (productId === STRIPE_PRODUCTS.business) return 'business';
  return null;
}

function tierCode(tier: PlanTier | null): number | null {
  if (!tier) return null;
  if (tier === 'team') return PLAN_TIER_CODES.team;
  if (tier === 'business') return null; // one code per credit size; not derivable from the product
  return TIER_CODE[tier];
}

function lineInfo(line: Obj): LineInfo {
  const priceDetails = (line.pricing?.price_details ?? null) as Obj | null;
  const legacyPrice = (line.price && typeof line.price === 'object' ? line.price : null) as Obj | null;
  const priceId = str(priceDetails?.price) ?? str(legacyPrice?.id);
  const productId = str(priceDetails?.product) ?? str(legacyPrice?.product);
  const unitDecimal = line.pricing?.unit_amount_decimal ?? legacyPrice?.unit_amount_decimal;
  const unitAmount = int(legacyPrice?.unit_amount) ?? (typeof unitDecimal === 'string' && /^\d+(\.\d+)?$/.test(unitDecimal) ? Number(unitDecimal) : null);
  const catalog = priceId ? planFromPriceId(priceId) : null;
  const isPack = productId === CREDIT_PACK.productId || priceId === CREDIT_PACK.priceId;
  const tier = isPack ? null : (catalog?.tier ?? tierForProduct(productId));
  return {
    amount: int(line.amount) ?? 0,
    quantity: int(line.quantity) ?? 1,
    price_id: priceId,
    product_id: productId,
    unit_amount: unitAmount,
    interval: catalog?.interval ?? asInterval(legacyPrice?.recurring?.interval),
    kind: isPack ? 'pack' : tier ? 'plan' : 'other',
    tier,
  };
}

function baseRow(): ConversionLedgerEvent {
  return {
    schema_version: 1,
    event_id: '',
    event_name: 'purchase_first',
    occurred_at: '',
    source_system: 'stripe',
    source_event_id: '',
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
    consent: unknownConsent(null),
    experiment_arms: {},
  };
}

function normalized(row: ConversionLedgerEvent, email: string | null): NormalizedEvent {
  return { row, identity: email ? { email } : {}, context: {}, consentFromSource: false };
}

export class StripeMapper {
  constructor(
    private readonly store: DocumentStore,
    private readonly ledger: Ledger,
    private readonly clock: Clock = systemClock,
  ) {}

  private expiry(): string {
    return expireAt(this.clock(), RETENTION.stateDays);
  }

  /** The ledger window a refund's purchase lives in: before the refund, within the look-back. */
  private purchaseWindow(refundMs: number): { fromMs: number; toMs: number } {
    return { fromMs: refundMs - LEDGER_LOOKBACK_DAYS * DAY_MS, toMs: refundMs + DAY_MS };
  }

  async map(event: StripeEvent, options: StripeMapOptions = {}): Promise<StripeMapResult> {
    const obj = event.data.object as Obj;
    switch (event.type) {
      case 'checkout.session.completed':
        return this.checkoutCompleted(event, obj);
      case 'invoice.paid':
        return this.invoicePaid(event, obj, options);
      case 'invoice_payment.paid':
        return this.invoicePaymentPaid(obj);
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.subscriptionChanged(event, obj);
      case 'charge.refunded':
        return this.chargeRefunded(event, obj, options);
      case 'charge.dispute.created':
        return this.disputeCreated(event, obj, options);
      default:
        return { kind: 'ignore', reason: `unsupported_event_type:${event.type}`, satisfies: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Join state
  // ---------------------------------------------------------------------------

  private async putPaymentIntent(pi: string, ref: PurchaseRef): Promise<void> {
    await this.store.put(STRIPE_STATE.paymentIntents, pi, { ...ref, user_id: ref.user_id ?? null, expire_at: this.expiry() });
  }

  private async subscriptionState(id: string): Promise<SubscriptionState | null> {
    return (await this.store.get<SubscriptionState>(STRIPE_STATE.subscriptions, id))?.data ?? null;
  }

  /** Merge a snapshot into subscription state unless a newer snapshot is already stored. */
  private async mergeSubscriptionState(next: SubscriptionState, partial: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.store.get<SubscriptionState>(STRIPE_STATE.subscriptions, next.subscription_id);
      if (!current) {
        if (await this.store.create(STRIPE_STATE.subscriptions, next.subscription_id, next)) return true;
        continue;
      }
      if (current.data.version > next.version) return false;
      const merged: SubscriptionState = partial
        ? {
            ...current.data,
            version: next.version,
            plan: next.plan ?? current.data.plan,
            pack_quantity: next.pack_quantity ?? current.data.pack_quantity,
            user_id: next.user_id ?? current.data.user_id ?? null,
            expire_at: next.expire_at ?? this.expiry(),
          }
        : { ...next, user_id: next.user_id ?? current.data.user_id ?? null };
      if (await this.store.replace(STRIPE_STATE.subscriptions, next.subscription_id, merged, current.version)) return true;
    }
    throw new Error(`subscription state contention on ${next.subscription_id}`);
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async checkoutCompleted(event: StripeEvent, cs: Obj): Promise<StripeMapResult> {
    const csId = String(cs.id);
    const invoice = str(cs.invoice);
    if (invoice) await this.store.put(STRIPE_STATE.invoiceCheckout, invoice, { checkout_session_id: csId, user_id: str(cs.customer), expire_at: this.expiry() });
    if (cs.mode !== 'payment') return { kind: 'state', note: 'checkout_session_linked', satisfies: [] };
    if (cs.status !== 'complete' || cs.payment_status !== 'paid') {
      // Async payment methods settle later (checkout.session.async_payment_succeeded is not subscribed).
      return { kind: 'ignore', reason: `checkout_not_paid:${String(cs.payment_status)}`, satisfies: [] };
    }
    const userId = str(cs.customer);
    const currency = str(cs.currency);
    const amount = int(cs.amount_total);
    if (!userId || !currency || amount === null) return { kind: 'ignore', reason: 'checkout_missing_customer_or_amount', satisfies: [] };

    const ids = invoice
      ? { event_id: purchaseEventId(invoice), order_id: purchaseOrderId(invoice) }
      : purchaseIdsForCheckoutSession(csId);
    const occurredMs = event.created * 1000;
    const row: ConversionLedgerEvent = {
      ...baseRow(),
      event_id: ids.event_id,
      event_name: 'purchase_one_time_pack',
      occurred_at: toUtc(occurredMs),
      source_event_id: event.id,
      user_id: userId,
      order_id: ids.order_id,
      cash_value_minor: amount,
      currency: currency.toUpperCase(),
      invoice_id: invoice,
      checkout_session_id: csId,
      is_first_purchase: !(await this.ledger.hasPurchaseBefore(userId, occurredMs, ids.event_id)),
      is_business: false,
    };
    const satisfies: string[] = [];
    const pi = str(cs.payment_intent);
    if (pi) {
      await this.putPaymentIntent(pi, { purchase_event_id: ids.event_id, purchase_order_id: ids.order_id, invoice_id: invoice, checkout_session_id: csId, user_id: userId });
      satisfies.push(`pi:${pi}`);
    }
    return { kind: 'rows', rows: [normalized(row, str(cs.customer_details?.email))], satisfies };
  }

  private async invoicePaid(event: StripeEvent, inv: Obj, options: StripeMapOptions): Promise<StripeMapResult> {
    const invoiceId = String(inv.id);
    const subscriptionId = str(inv.parent?.subscription_details?.subscription) ?? str(inv.subscription);
    const reason = inv.billing_reason as string | null;
    const satisfies: string[] = [];

    // Legacy (pre-basil) invoices carry the payment join directly.
    const customer = str(inv.customer);
    const legacyPi = str(inv.payment_intent);
    if (legacyPi) {
      await this.putPaymentIntent(legacyPi, { purchase_event_id: purchaseEventId(invoiceId), purchase_order_id: purchaseOrderId(invoiceId), invoice_id: invoiceId, checkout_session_id: null, user_id: customer });
      satisfies.push(`pi:${legacyPi}`);
    }
    const legacyCharge = str(inv.charge);
    if (legacyCharge) {
      await this.store.put(STRIPE_STATE.charges, legacyCharge, { invoice_id: invoiceId, user_id: customer, expire_at: this.expiry() });
      satisfies.push(`charge:${legacyCharge}`);
    }

    if (!subscriptionId) return { kind: 'ignore', reason: 'invoice_without_subscription', satisfies };
    const lines = ((inv.lines?.data ?? []) as Obj[]).map(lineInfo);
    const positivePlan = lines.find((l) => l.kind === 'plan' && l.amount > 0) ?? null;
    const negativePlan = lines.find((l) => l.kind === 'plan' && l.amount < 0) ?? null;
    const packQty = lines.filter((l) => l.kind === 'pack' && l.amount > 0).reduce((s, l) => s + l.quantity, 0);
    const createdS = int(inv.status_transitions?.paid_at) ?? int(inv.created) ?? event.created;

    // Every paid invoice with a plan line refreshes the subscription's known plan (partial snapshot).
    if (positivePlan?.tier) {
      const updated = await this.mergeSubscriptionState(
        {
          subscription_id: subscriptionId,
          version: createdS,
          status: null,
          plan: { tier: positivePlan.tier, interval: positivePlan.interval, price_id: positivePlan.price_id, unit_amount: positivePlan.unit_amount },
          pack_quantity: null,
          user_id: customer,
          expire_at: this.expiry(),
        },
        true,
      );
      if (updated) satisfies.push(`sub:${subscriptionId}`);
    }

    let eventName: PurchaseEventName;
    if (reason === 'subscription_create') eventName = 'purchase_first';
    else if (reason === 'subscription_cycle') eventName = 'purchase_renewal';
    else if (reason === 'subscription_update') {
      const change: PlanChange = positivePlan && negativePlan ? classifyPlanChange(negativePlan, positivePlan) : 'unknown';
      if (change === 'upgrade') eventName = 'purchase_upgrade';
      else if (packQty > 0 && !positivePlan) eventName = 'purchase_add_on';
      else if (change === 'interval_change') return { kind: 'ignore', reason: 'interval_change_not_upgrade', satisfies };
      else if (change === 'downgrade') return { kind: 'ignore', reason: 'plan_downgrade', satisfies };
      else return { kind: 'ignore', reason: 'unmapped_subscription_update', satisfies };
    } else {
      return { kind: 'ignore', reason: `unsupported_billing_reason:${String(reason)}`, satisfies };
    }

    const amountPaid = int(inv.amount_paid) ?? 0;
    if (eventName !== 'purchase_first' && amountPaid <= 0) return { kind: 'ignore', reason: 'no_cash', satisfies };

    // Resolve the plan the row describes.
    const state = await this.subscriptionState(subscriptionId);
    let plan: PlanInfo | null = null;
    if (eventName === 'purchase_add_on') {
      plan = state?.plan ?? null;
      if (!plan) {
        if (!options.degraded) return { kind: 'park', dependency: `sub:${subscriptionId}`, reason: 'add_on_without_known_plan', satisfies };
        return { kind: 'ignore', reason: 'unresolvable_plan', satisfies };
      }
    } else if (positivePlan?.tier) {
      plan = { tier: positivePlan.tier, interval: positivePlan.interval ?? state?.plan?.interval ?? null, price_id: positivePlan.price_id, unit_amount: positivePlan.unit_amount };
    } else {
      plan = state?.plan ?? null;
    }
    if (!plan || !plan.interval) {
      if (!options.degraded) return { kind: 'park', dependency: `sub:${subscriptionId}`, reason: 'plan_interval_unknown', satisfies };
      return { kind: 'ignore', reason: 'unresolvable_plan', satisfies };
    }

    const userId = String(inv.customer);
    const occurredMs = createdS * 1000;
    const event_id = canonicalEventId({ event_name: eventName, invoice_id: invoiceId });
    const creditPackQuantity = packQty > 0 ? packQty : eventName === 'purchase_upgrade' || eventName === 'purchase_add_on' ? (state?.pack_quantity ?? null) : null;
    const checkout =
      eventName === 'purchase_first' ? ((await this.store.get<{ checkout_session_id: string }>(STRIPE_STATE.invoiceCheckout, invoiceId))?.data.checkout_session_id ?? null) : null;

    const row: ConversionLedgerEvent = {
      ...baseRow(),
      event_id,
      event_name: eventName,
      occurred_at: toUtc(occurredMs),
      source_event_id: event.id,
      user_id: userId,
      order_id: canonicalOrderId({ event_name: eventName, invoice_id: invoiceId }),
      cash_value_minor: amountPaid,
      currency: String(inv.currency).toUpperCase(),
      invoice_id: invoiceId,
      subscription_id: subscriptionId,
      checkout_session_id: checkout,
      plan_tier: plan.tier,
      plan_tier_code: tierCode(plan.tier),
      billing_interval: plan.interval,
      previous_plan_tier: eventName === 'purchase_upgrade' ? (negativePlan?.tier ?? null) : null,
      credit_pack_quantity: creditPackQuantity,
      is_first_purchase: eventName === 'purchase_first' ? !(await this.ledger.hasPurchaseBefore(userId, occurredMs, event_id)) : false,
      is_business: plan.tier === 'team' || plan.tier === 'business',
    };
    return { kind: 'rows', rows: [normalized(row, str(inv.customer_email))], satisfies };
  }

  private async invoicePaymentPaid(p: Obj): Promise<StripeMapResult> {
    const invoice = String(p.invoice);
    const ref: PurchaseRef = { purchase_event_id: purchaseEventId(invoice), purchase_order_id: purchaseOrderId(invoice), invoice_id: invoice, checkout_session_id: null };
    const satisfies: string[] = [];
    const pi = str(p.payment?.payment_intent);
    if (pi) {
      await this.putPaymentIntent(pi, ref);
      satisfies.push(`pi:${pi}`);
    }
    const charge = str(p.payment?.charge);
    if (charge) {
      await this.store.put(STRIPE_STATE.charges, charge, { invoice_id: invoice, user_id: null, expire_at: this.expiry() });
      satisfies.push(`charge:${charge}`);
    }
    return { kind: 'state', note: 'payment_linked', satisfies };
  }

  private async subscriptionChanged(event: StripeEvent, sub: Obj): Promise<StripeMapResult> {
    const items = ((sub.items?.data ?? []) as Obj[]).map((item) => {
      const price = (item.price ?? {}) as Obj;
      const priceId = str(price.id);
      const productId = str(price.product);
      const isPack = productId === CREDIT_PACK.productId || priceId === CREDIT_PACK.priceId;
      return {
        tier: isPack ? null : ((priceId ? planFromPriceId(priceId)?.tier : null) ?? tierForProduct(productId)),
        interval: asInterval(price.recurring?.interval) ?? (priceId ? (planFromPriceId(priceId)?.interval ?? null) : null),
        price_id: priceId,
        unit_amount: int(price.unit_amount),
        quantity: int(item.quantity) ?? 0,
        isPack,
      };
    });
    const planItem = items.find((i) => i.tier);
    const updated = await this.mergeSubscriptionState(
      {
        subscription_id: String(sub.id),
        version: event.created,
        status: str(sub.status),
        plan: planItem?.tier ? { tier: planItem.tier, interval: planItem.interval, price_id: planItem.price_id, unit_amount: planItem.unit_amount } : null,
        pack_quantity: items.filter((i) => i.isPack).reduce((s, i) => s + i.quantity, 0),
        user_id: str(sub.customer),
        expire_at: this.expiry(),
      },
      false,
    );
    return { kind: 'state', note: updated ? 'subscription_state_updated' : 'stale_subscription_snapshot', satisfies: updated ? [`sub:${String(sub.id)}`] : [] };
  }

  /** Payment intent (or charge) -> the purchase a refund/dispute adjusts. */
  private async purchaseRefFor(pi: string | null, charge: string | null, legacyInvoice: string | null): Promise<PurchaseRef | null> {
    if (legacyInvoice) {
      return { purchase_event_id: purchaseEventId(legacyInvoice), purchase_order_id: purchaseOrderId(legacyInvoice), invoice_id: legacyInvoice, checkout_session_id: null };
    }
    if (pi) {
      const hit = await this.store.get<PurchaseRef>(STRIPE_STATE.paymentIntents, pi);
      if (hit) return hit.data;
    }
    if (charge) {
      const hit = await this.store.get<{ invoice_id: string }>(STRIPE_STATE.charges, charge);
      if (hit) {
        const invoice = hit.data.invoice_id;
        return { purchase_event_id: purchaseEventId(invoice), purchase_order_id: purchaseOrderId(invoice), invoice_id: invoice, checkout_session_id: null };
      }
    }
    return null;
  }

  private async adjustmentRow(
    base: ConversionLedgerEvent,
    ref: PurchaseRef | null,
    options: StripeMapOptions,
    missingDependency: string,
  ): Promise<{ row: ConversionLedgerEvent } | { park: string }> {
    if (!ref) {
      if (!options.degraded) return { park: missingDependency };
      return { row: base };
    }
    const purchase = await this.ledger.get(ref.purchase_event_id, this.purchaseWindow(Date.parse(base.occurred_at)));
    if (!purchase && !options.degraded) return { park: `purchase:${ref.purchase_event_id}` };
    return {
      row: {
        ...base,
        user_id: base.user_id ?? purchase?.user_id ?? null,
        adjusts_event_id: ref.purchase_event_id,
        adjusts_order_id: ref.purchase_order_id,
        invoice_id: ref.invoice_id,
        subscription_id: purchase?.subscription_id ?? null,
        // A one-time pack has no invoice: its Checkout Session is the purchase identity.
        checkout_session_id: ref.invoice_id ? null : ref.checkout_session_id,
        plan_tier: purchase?.plan_tier ?? null,
        plan_tier_code: purchase?.plan_tier_code ?? null,
        billing_interval: purchase?.billing_interval ?? null,
      },
    };
  }

  /**
   * Record a refund in the charge's state with compare-and-set and return the amount refunded before
   * it. The max never goes down (a stale event cannot lower it), and the previous amount chosen the
   * first time is remembered per cumulative value, so a replay (after parking) gets the same delta.
   */
  private async recordRefund(chargeId: string, cumulative: number, previousAttr: number | null, userId: string | null): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.store.get<ChargeRefundState>(STRIPE_STATE.chargeRefunds, chargeId);
      const state: ChargeRefundState = current?.data ?? { max_cumulative_refunded: 0, previous_by_cumulative: {}, user_id: userId, expire_at: '' };
      const recorded = state.previous_by_cumulative?.[String(cumulative)];
      const previous = previousAttr ?? recorded ?? state.max_cumulative_refunded ?? 0;
      const next: ChargeRefundState = {
        max_cumulative_refunded: Math.max(state.max_cumulative_refunded ?? 0, cumulative),
        previous_by_cumulative: { ...(state.previous_by_cumulative ?? {}), [String(cumulative)]: recorded ?? previous },
        user_id: state.user_id ?? userId,
        expire_at: this.expiry(),
      };
      const ok = current
        ? await this.store.replace(STRIPE_STATE.chargeRefunds, chargeId, next, current.version)
        : await this.store.create(STRIPE_STATE.chargeRefunds, chargeId, next);
      if (ok) return recorded ?? previous;
    }
    throw new Error(`charge refund state contention on ${chargeId}`);
  }

  private async chargeRefunded(event: StripeEvent, charge: Obj, options: StripeMapOptions): Promise<StripeMapResult> {
    const chargeId = String(charge.id);
    const cumulative = int(charge.amount_refunded) ?? 0;
    if (cumulative <= 0) return { kind: 'ignore', reason: 'no_refund_delta', satisfies: [] };
    const previous = await this.recordRefund(chargeId, cumulative, int(event.data.previous_attributes?.amount_refunded), str(charge.customer));
    const delta = cumulative - previous;
    if (delta <= 0) return { kind: 'ignore', reason: 'no_refund_delta', satisfies: [] };
    const pi = str(charge.payment_intent);
    const ref = await this.purchaseRefFor(pi, chargeId, str(charge.invoice));
    const base: ConversionLedgerEvent = {
      ...baseRow(),
      event_id: canonicalEventId({ event_name: 'refund', charge_id: chargeId, amount_refunded_minor: cumulative }),
      event_name: 'refund',
      occurred_at: toUtc(event.created * 1000),
      source_event_id: event.id,
      user_id: str(charge.customer),
      cash_value_minor: -delta,
      currency: String(charge.currency).toUpperCase(),
      charge_id: chargeId,
    };
    const out = await this.adjustmentRow(base, ref, options, pi ? `pi:${pi}` : `charge:${chargeId}`);
    if ('park' in out) return { kind: 'park', dependency: out.park, reason: 'refund_before_purchase_join', satisfies: [] };
    return { kind: 'rows', rows: [normalized(out.row, null)], satisfies: [] };
  }

  private async disputeCreated(event: StripeEvent, dispute: Obj, options: StripeMapOptions): Promise<StripeMapResult> {
    const chargeId = String(dispute.charge);
    const pi = str(dispute.payment_intent);
    const ref = await this.purchaseRefFor(pi, chargeId, null);
    const base: ConversionLedgerEvent = {
      ...baseRow(),
      event_id: canonicalEventId({ event_name: 'chargeback', dispute_id: String(dispute.id) }),
      event_name: 'chargeback',
      occurred_at: toUtc((int(dispute.created) ?? event.created) * 1000),
      source_event_id: event.id,
      cash_value_minor: -(int(dispute.amount) ?? 0),
      currency: String(dispute.currency).toUpperCase(),
      charge_id: chargeId,
    };
    const out = await this.adjustmentRow(base, ref, options, pi ? `pi:${pi}` : `charge:${chargeId}`);
    if ('park' in out) return { kind: 'park', dependency: out.park, reason: 'dispute_before_purchase_join', satisfies: [] };
    return { kind: 'rows', rows: [normalized(out.row, null)], satisfies: [] };
  }
}

/** Parse the cumulative refunded amount back out of a refund event id (refund_<charge>_<cumulative>). */
export function cumulativeFromRefundEventId(eventId: string): number | null {
  const m = /^refund_(.+)_([1-9]\d*)$/.exec(eventId);
  return m ? Number(m[2]) : null;
}

export type { StripeObject };
