/**
 * Builders for Stripe Event payloads in the documented 2026-08-26.dahlia shape
 * (see src/sources/stripe-event.schema.json). Used by the hand-written scenario
 * fixtures and by the synthetic cohort generator, so both emit identical shapes.
 * All ids passed in are synthetic.
 */

import type { BillingInterval } from '../constants.js';

export const STRIPE_API_VERSION = '2026-08-26.dahlia';

type Obj = Record<string, unknown>;

export interface StripeEvent {
  id: string;
  object: 'event';
  api_version: string;
  created: number;
  data: { object: Obj; previous_attributes?: Obj };
  livemode: boolean;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: string;
}

export function stripeEvent(
  id: string,
  type: string,
  created: number,
  object: Obj,
  previousAttributes?: Obj,
): StripeEvent {
  return {
    id,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    created,
    data: previousAttributes ? { object, previous_attributes: previousAttributes } : { object },
    livemode: true,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
}

export interface PriceInput {
  priceId: string;
  productId: string;
  unitAmountMinor: number;
  interval: BillingInterval | null;
}

export function priceObject(p: PriceInput): Obj {
  return {
    id: p.priceId,
    object: 'price',
    active: true,
    currency: 'usd',
    product: p.productId,
    type: p.interval ? 'recurring' : 'one_time',
    recurring: p.interval ? { interval: p.interval, interval_count: 1, usage_type: 'licensed' } : null,
    unit_amount: p.unitAmountMinor,
    unit_amount_decimal: String(p.unitAmountMinor),
    lookup_key: null,
    livemode: true,
    metadata: {},
  };
}

export interface CheckoutSessionInput {
  id: string;
  customer: string;
  mode: 'subscription' | 'payment';
  subscription: string | null;
  invoice: string | null;
  paymentIntent: string | null;
  amountTotalMinor: number;
  created: number;
  /** Query string OpenArt puts on success_url (tier, interval, uid). */
  successQuery: string;
  customerEmail: string;
  metadata?: Record<string, string>;
}

/** Checkout Session as configured by POST /api/stripe/subscription (research/10 §5.3). */
export function checkoutSessionObject(s: CheckoutSessionInput): Obj {
  return {
    id: s.id,
    object: 'checkout.session',
    mode: s.mode,
    status: 'complete',
    payment_status: 'paid',
    customer: s.customer,
    customer_creation: null,
    customer_details: { email: s.customerEmail, name: null, address: null, phone: null, tax_exempt: 'none', tax_ids: [] },
    client_reference_id: null,
    subscription: s.subscription,
    invoice: s.invoice,
    payment_intent: s.paymentIntent,
    amount_subtotal: s.amountTotalMinor,
    amount_total: s.amountTotalMinor,
    currency: 'usd',
    allow_promotion_codes: true,
    automatic_tax: { enabled: false, liability: null, status: null },
    created: s.created,
    expires_at: s.created + 86_400,
    livemode: true,
    locale: null,
    metadata: s.metadata ?? {},
    payment_method_types: ['card', 'amazon_pay', 'crypto'],
    success_url: `https://openart.ai/suite/subscriptions?${s.successQuery}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: 'https://openart.ai/pricing',
    url: null,
  };
}

export interface InvoiceLineInput {
  id: string;
  amountMinor: number;
  price: PriceInput;
  quantity: number;
  periodStart: number;
  periodEnd: number;
  proration: boolean;
  subscriptionItem: string;
  description: string;
}

export interface InvoiceInput {
  id: string;
  customer: string;
  subscription: string;
  billingReason: 'subscription_create' | 'subscription_cycle' | 'subscription_update';
  created: number;
  periodStart: number;
  periodEnd: number;
  lines: InvoiceLineInput[];
  number: string;
}

/** Paid subscription invoice; totals are computed from the lines (no tax: automatic_tax is off). */
export function invoiceObject(i: InvoiceInput): Obj {
  const total = i.lines.reduce((sum, l) => sum + l.amountMinor, 0);
  return {
    id: i.id,
    object: 'invoice',
    account_country: 'US',
    account_name: 'OpenArt AI',
    amount_due: total,
    amount_overpaid: 0,
    amount_paid: total,
    amount_remaining: 0,
    attempt_count: 1,
    attempted: true,
    billing_reason: i.billingReason,
    collection_method: 'charge_automatically',
    created: i.created,
    currency: 'usd',
    customer: i.customer,
    customer_email: null,
    discounts: [],
    effective_at: i.created,
    hosted_invoice_url: null,
    livemode: true,
    metadata: {},
    number: i.number,
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: { metadata: {}, subscription: i.subscription },
    },
    period_end: i.periodEnd,
    period_start: i.periodStart,
    status: 'paid',
    status_transitions: { finalized_at: i.created, paid_at: i.created, marked_uncollectible_at: null, voided_at: null },
    subtotal: total,
    subtotal_excluding_tax: total,
    total,
    total_excluding_tax: total,
    lines: {
      object: 'list',
      has_more: false,
      url: `/v1/invoices/${i.id}/lines`,
      data: i.lines.map((l) => ({
        id: l.id,
        object: 'line_item',
        amount: l.amountMinor,
        currency: 'usd',
        description: l.description,
        discount_amounts: [],
        discountable: true,
        discounts: [],
        invoice: i.id,
        livemode: true,
        metadata: {},
        parent: {
          type: 'subscription_item_details',
          invoice_item_details: null,
          subscription_item_details: {
            invoice_item: null,
            proration: l.proration,
            proration_details: null,
            subscription: i.subscription,
            subscription_item: l.subscriptionItem,
          },
        },
        period: { start: l.periodStart, end: l.periodEnd },
        pricing: {
          type: 'price_details',
          price_details: { price: l.price.priceId, product: l.price.productId },
          unit_amount_decimal: String(l.price.unitAmountMinor),
        },
        quantity: l.quantity,
        subscription: i.subscription,
        taxes: [],
      })),
    },
  };
}

/** The InvoicePayment that links an invoice to its PaymentIntent (the only charge->invoice join since basil). */
export function invoicePaymentObject(p: {
  id: string;
  invoice: string;
  paymentIntent: string;
  amountMinor: number;
  created: number;
}): Obj {
  return {
    id: p.id,
    object: 'invoice_payment',
    amount_paid: p.amountMinor,
    amount_requested: p.amountMinor,
    created: p.created,
    currency: 'usd',
    invoice: p.invoice,
    is_default: true,
    livemode: true,
    payment: { type: 'payment_intent', payment_intent: p.paymentIntent },
    status: 'paid',
    status_transitions: { canceled_at: null, paid_at: p.created },
  };
}

export interface SubscriptionItemInput {
  id: string;
  price: PriceInput;
  quantity: number;
  periodStart: number;
  periodEnd: number;
}

export function subscriptionObject(s: {
  id: string;
  customer: string;
  status: 'active' | 'canceled' | 'past_due';
  items: SubscriptionItemInput[];
  created: number;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  canceledAt: number | null;
  endedAt: number | null;
  latestInvoice: string;
  cancellationReason?: string | null;
}): Obj {
  return {
    id: s.id,
    object: 'subscription',
    billing_cycle_anchor: s.items[0]?.periodStart ?? s.created,
    cancel_at: s.cancelAt,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt,
    cancellation_details: { comment: null, feedback: null, reason: s.cancellationReason ?? null },
    collection_method: 'charge_automatically',
    created: s.created,
    currency: 'usd',
    customer: s.customer,
    ended_at: s.endedAt,
    items: {
      object: 'list',
      has_more: false,
      url: `/v1/subscription_items?subscription=${s.id}`,
      data: s.items.map((it) => ({
        id: it.id,
        object: 'subscription_item',
        created: s.created,
        current_period_start: it.periodStart,
        current_period_end: it.periodEnd,
        metadata: {},
        price: priceObject(it.price),
        quantity: it.quantity,
        subscription: s.id,
      })),
    },
    latest_invoice: s.latestInvoice,
    livemode: true,
    metadata: {},
    pause_collection: null,
    schedule: null,
    start_date: s.created,
    status: s.status,
  };
}

export function chargeObject(c: {
  id: string;
  customer: string;
  paymentIntent: string;
  amountMinor: number;
  amountRefundedMinor: number;
  created: number;
  disputed: boolean;
}): Obj {
  return {
    id: c.id,
    object: 'charge',
    amount: c.amountMinor,
    amount_captured: c.amountMinor,
    amount_refunded: c.amountRefundedMinor,
    balance_transaction: null,
    captured: true,
    created: c.created,
    currency: 'usd',
    customer: c.customer,
    description: null,
    disputed: c.disputed,
    livemode: true,
    metadata: {},
    paid: true,
    payment_intent: c.paymentIntent,
    refunded: c.amountRefundedMinor >= c.amountMinor,
    status: 'succeeded',
  };
}

export function disputeObject(d: {
  id: string;
  charge: string;
  paymentIntent: string;
  amountMinor: number;
  created: number;
  reason: string;
}): Obj {
  return {
    id: d.id,
    object: 'dispute',
    amount: d.amountMinor,
    balance_transactions: [],
    charge: d.charge,
    created: d.created,
    currency: 'usd',
    evidence_details: { due_by: d.created + 7 * 86_400, has_evidence: false, past_due: false, submission_count: 0 },
    is_charge_refundable: false,
    livemode: true,
    metadata: {},
    payment_intent: d.paymentIntent,
    reason: d.reason,
    status: 'needs_response',
  };
}
