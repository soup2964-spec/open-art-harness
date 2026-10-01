/**
 * Deterministic event_id / order_id rules for the conversion ledger.
 *
 * The purchase and signup rules REUSE the ids OpenArt's browser code already
 * sends, so a server event dedupes with the existing pixel event
 * (research/02 §3.2 and §3.4, research/11 §3):
 *   - signup           event_id  reg_<uid>            Meta CompleteRegistration eventID, OpenAI registration_completed event_id
 *   - purchase_*       event_id  purchase_<invoiceId> Meta Purchase eventID, OpenAI subscription_created event_id
 *   - purchase_*       order_id  sub_<invoiceId>      Google Ads oid, Reddit transactionId (+SHA-256 as conversionId),
 *                                                     X conversion_id, TikTok event_id, UET transaction_id
 * Every other event has no browser twin today; its id is new but deterministic,
 * so re-processing the same source record always yields the same id.
 */

import type { CanonicalEventName, PurchaseEventName } from './constants.js';
import { PURCHASE_EVENT_NAMES } from './constants.js';
import { sha256Hex } from './sha256.js';

const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
const CHECKOUT_SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]+$/;
const NO_WHITESPACE = /^\S+$/;

function requireToken(value: string | undefined | null, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !NO_WHITESPACE.test(value)) {
    throw new Error(`${what} must be a non-empty string without whitespace (got ${JSON.stringify(value)})`);
  }
  return value;
}

function requireInvoiceId(invoiceId: string): string {
  if (!INVOICE_ID.test(invoiceId)) {
    throw new Error(`expected a Stripe invoice id (in_…), got ${JSON.stringify(invoiceId)}`);
  }
  return invoiceId;
}

/** `reg_<uid>`: the id Meta and OpenAI Ads already receive for signup. */
export function signupEventId(userId: string): string {
  return `reg_${requireToken(userId, 'user_id')}`;
}

/** `purchase_<invoiceId>`: the id Meta and OpenAI Ads already receive for a purchase. */
export function purchaseEventId(invoiceId: string): string {
  return `purchase_${requireInvoiceId(invoiceId)}`;
}

/** `sub_<invoiceId>`: the transaction/order id Google Ads, Reddit, X, TikTok and UET already receive. */
export function purchaseOrderId(invoiceId: string): string {
  return `sub_${requireInvoiceId(invoiceId)}`;
}

/**
 * Purchase ids for a payment-mode Checkout (one-time pack) that produced no invoice.
 * No browser twin exists for one-time packs, so there is nothing to dedupe against.
 */
export function purchaseIdsForCheckoutSession(checkoutSessionId: string): { event_id: string; order_id: string } {
  if (!CHECKOUT_SESSION_ID.test(checkoutSessionId)) {
    throw new Error(`expected a Checkout Session id (cs_live_…/cs_test_…), got ${JSON.stringify(checkoutSessionId)}`);
  }
  return { event_id: `purchase_${checkoutSessionId}`, order_id: `sub_${checkoutSessionId}` };
}

/** `activation_<uid>`: one first-generation activation per user. */
export function activationEventId(userId: string): string {
  return `activation_${requireToken(userId, 'user_id')}`;
}

/** `checkout_<id>`: id = Checkout Session id when known, else the Amplitude event uuid. */
export function checkoutStartedEventId(checkoutSessionOrEventId: string): string {
  return `checkout_${requireToken(checkoutSessionOrEventId, 'checkout id')}`;
}

/**
 * `refund_<chargeId>_<cumulativeAmountRefundedMinor>`: unique per partial-refund
 * step and stable across Stripe webhook redeliveries (the charge.refunded payload
 * carries the cumulative `amount_refunded`).
 */
export function refundEventId(chargeId: string, cumulativeAmountRefundedMinor: number): string {
  if (!Number.isInteger(cumulativeAmountRefundedMinor) || cumulativeAmountRefundedMinor <= 0) {
    throw new Error(`cumulative amount refunded must be a positive integer (got ${cumulativeAmountRefundedMinor})`);
  }
  return `refund_${requireToken(chargeId, 'charge id')}_${cumulativeAmountRefundedMinor}`;
}

/** `chargeback_<disputeId>` */
export function chargebackEventId(disputeId: string): string {
  return `chargeback_${requireToken(disputeId, 'dispute id')}`;
}

/** `lead_<hubspotConversionId>` */
export function enterpriseLeadEventId(hubspotConversionId: string): string {
  return `lead_${requireToken(hubspotConversionId, 'HubSpot conversion id')}`;
}

/** `leadstage_<contactId>_<lifecycleStage>`: one row per contact per stage reached. */
export function leadStageChangeEventId(hubspotContactId: string, lifecycleStage: string): string {
  return `leadstage_${requireToken(hubspotContactId, 'HubSpot contact id')}_${requireToken(lifecycleStage, 'lifecycle stage')}`;
}

/** What the Reddit pixel puts in `m.conversionId`: SHA-256 hex of the order id (research/11 §3.2). */
export function redditPixelConversionId(orderId: string): string {
  return sha256Hex(requireToken(orderId, 'order id'));
}

export interface CanonicalIdInput {
  event_name: CanonicalEventName;
  user_id?: string | null;
  invoice_id?: string | null;
  checkout_session_id?: string | null;
  charge_id?: string | null;
  amount_refunded_minor?: number | null;
  dispute_id?: string | null;
  /** Amplitude uuid for checkout_started rows without a Checkout Session id. */
  source_event_id?: string | null;
  hubspot_conversion_id?: string | null;
  hubspot_contact_id?: string | null;
  lifecycle_stage?: string | null;
}

function isPurchase(name: CanonicalEventName): name is PurchaseEventName {
  return (PURCHASE_EVENT_NAMES as readonly string[]).includes(name);
}

/** The single dispatcher every package should use to build a ledger event_id. */
export function canonicalEventId(input: CanonicalIdInput): string {
  const { event_name: name } = input;
  if (name === 'signup') return signupEventId(input.user_id ?? '');
  if (name === 'activation_first_generation') return activationEventId(input.user_id ?? '');
  if (name === 'checkout_started') {
    return checkoutStartedEventId(input.checkout_session_id ?? input.source_event_id ?? '');
  }
  if (isPurchase(name)) {
    if (input.invoice_id) return purchaseEventId(input.invoice_id);
    if (name === 'purchase_one_time_pack' && input.checkout_session_id) {
      return purchaseIdsForCheckoutSession(input.checkout_session_id).event_id;
    }
    throw new Error(`${name} needs invoice_id (or checkout_session_id for a one-time pack without an invoice)`);
  }
  if (name === 'refund') return refundEventId(input.charge_id ?? '', input.amount_refunded_minor ?? 0);
  if (name === 'chargeback') return chargebackEventId(input.dispute_id ?? '');
  if (name === 'enterprise_lead') return enterpriseLeadEventId(input.hubspot_conversion_id ?? '');
  if (name === 'lead_stage_change') {
    return leadStageChangeEventId(input.hubspot_contact_id ?? '', input.lifecycle_stage ?? '');
  }
  const exhaustive: never = name;
  throw new Error(`unknown event_name ${String(exhaustive)}`);
}

/** Order id for purchase rows (null for every other event). */
export function canonicalOrderId(input: CanonicalIdInput): string | null {
  if (!isPurchase(input.event_name)) return null;
  if (input.invoice_id) return purchaseOrderId(input.invoice_id);
  if (input.event_name === 'purchase_one_time_pack' && input.checkout_session_id) {
    return purchaseIdsForCheckoutSession(input.checkout_session_id).order_id;
  }
  throw new Error(`${input.event_name} needs invoice_id to build an order id`);
}

export type ParsedBrowserDedupId =
  | { kind: 'signup'; user_id: string }
  | { kind: 'purchase_event'; invoice_id: string }
  | { kind: 'purchase_event'; checkout_session_id: string }
  | { kind: 'purchase_order'; invoice_id: string }
  | { kind: 'purchase_order'; checkout_session_id: string }
  | { kind: 'unstable_fallback' }
  | { kind: 'unknown' };

/**
 * Classify an id seen in a browser hit or platform report.
 * `unstable_fallback` is the Suite's `sub_<tierKey>_<code>_<uid|unknown>_<Date.now()>`
 * id, used when the invoice lookup fails (research/02 §3.2); it cannot dedupe.
 */
export function parseBrowserDedupId(id: string): ParsedBrowserDedupId {
  if (id.startsWith('reg_') && id.length > 4) return { kind: 'signup', user_id: id.slice(4) };
  if (id.startsWith('purchase_')) {
    const rest = id.slice('purchase_'.length);
    if (INVOICE_ID.test(rest)) return { kind: 'purchase_event', invoice_id: rest };
    if (CHECKOUT_SESSION_ID.test(rest)) return { kind: 'purchase_event', checkout_session_id: rest };
  }
  if (id.startsWith('sub_')) {
    const rest = id.slice('sub_'.length);
    if (INVOICE_ID.test(rest)) return { kind: 'purchase_order', invoice_id: rest };
    if (CHECKOUT_SESSION_ID.test(rest)) return { kind: 'purchase_order', checkout_session_id: rest };
    if (/^[A-Za-z]+_\d+_.+_\d{13}$/.test(rest)) return { kind: 'unstable_fallback' };
  }
  return { kind: 'unknown' };
}
