/**
 * Data minimisation for parked Stripe events: keep only the fields the mapper reads.
 * A real Charge carries billing_details and payment_method_details (name, email, address,
 * card fingerprint); none of that is needed to map a refund, so none of it is stored.
 */

import type { StripeEvent, StripeObject } from '../ingest/stripe-types.js';

const KEEP: Record<string, readonly string[]> = {
  charge: ['id', 'object', 'amount', 'amount_refunded', 'currency', 'customer', 'payment_intent', 'invoice', 'created', 'status', 'refunded', 'livemode'],
  dispute: ['id', 'object', 'amount', 'charge', 'payment_intent', 'currency', 'created', 'reason', 'status', 'livemode'],
  invoice: [
    'id', 'object', 'customer', 'status', 'billing_reason', 'currency', 'amount_paid', 'amount_due', 'total', 'subtotal', 'created',
    'period_start', 'period_end', 'livemode', 'parent', 'subscription', 'payment_intent', 'charge', 'status_transitions', 'lines',
  ],
};

const LINE_KEEP = ['id', 'object', 'amount', 'currency', 'quantity', 'period', 'pricing', 'parent', 'price', 'proration'];

function pick(obj: StripeObject, keys: readonly string[]): StripeObject {
  const out: StripeObject = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export function projectStripeEvent(event: StripeEvent): StripeEvent {
  const obj = event.data.object;
  const type = typeof obj.object === 'string' ? obj.object : '';
  const keep = KEEP[type];
  let projected: StripeObject = keep ? pick(obj, keep) : obj;
  if (type === 'invoice' && projected.lines && typeof projected.lines === 'object') {
    const lines = projected.lines as { data?: StripeObject[]; has_more?: boolean; object?: string };
    projected = { ...projected, lines: { object: 'list', has_more: Boolean(lines.has_more), data: (lines.data ?? []).map((l) => pick(l, LINE_KEEP)) } };
  }
  const prev = event.data.previous_attributes;
  const data: StripeEvent['data'] =
    prev && typeof prev.amount_refunded === 'number' ? { object: projected, previous_attributes: { amount_refunded: prev.amount_refunded } } : { object: projected };
  return { id: event.id, object: 'event', api_version: event.api_version, created: event.created, data, livemode: event.livemode, type: event.type };
}
