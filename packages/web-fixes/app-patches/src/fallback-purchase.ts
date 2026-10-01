/**
 * Client purchase reporting with no stale fallback values and deterministic ids only.
 *
 * What ships today:
 *  - Suite module 111958 (d4f45453351837aa.js): `eE()` builds a fallback payload from the
 *    PRICES table in module 399331 (91db8069961c7577.js) — Starter {monthly:14, yearly:7},
 *    Plus {34,17}, Pro {56,28}, Wonder {240,120}: the `yearly` figure is a stale per-month price,
 *    so an annual Starter sale ($156/yr at the live $13/seat/mo) would be reported as $7 — with
 *    transaction_id `sub_<tierKey>_<tier>_<uid>_${Date.now()}`. `eR()` replaces value and id only
 *    when /legacy/api/stripe/checkout-session-invoice resolves; if it fails twice (`eT()`), the
 *    fallback goes to Google Ads (both accounts), UET, Reddit, LinkedIn, X and Brevo.
 *  - `ez()` (gtag purchase_first, webhook-gated) always uses the fallback payload.
 *  - Legacy `_app` module 68039: transaction_id is always the Date.now() fallback, even when
 *    the invoice resolves; value = LTV → amount → list price (Ps table, module 89774).
 *
 * The fix: resolve once from the invoice. If the invoice cannot be resolved (or has no id /
 * amount / currency), the client reports nothing to ad platforms and records why in
 * `conversion_reported`; the server-side sender (Stripe webhook → conversion service) owns
 * the conversion, with the same ids it would have used.
 *
 * Ids (packages/contracts src/event-ids.ts, built by its own functions): the invoice id must be a
 * Stripe invoice id (`in_…`, the contracts rule), so a constant bogus id such as "undefined" can
 * never collapse every purchase into one platform order id.
 *  - `sub_<invoiceId>`       order-style key: Google Ads order_id, Reddit transactionId (+ its SHA-256 as
 *                            conversionId), TikTok event_id, X conversion_id, UET transaction_id and now
 *                            UET event_id and the LinkedIn eventId (GTM fix pack).
 *  - `purchase_<invoiceId>`  event-style key: Meta Purchase eventID, OpenAI Ads subscription_created.
 *
 * Value (choosePurchaseValue): the server-computed `profitValueMajor` whenever the backend returns
 * it, so the pixel's copy and conversion-service's copy of one purchase carry the same number
 * whichever copy a platform keeps (Meta keeps the first received, usually the pixel). Without it
 * each tag keeps today's basis, recorded as `value_basis`.
 */
import { parseBrowserDedupId, purchaseEventId, purchaseOrderId } from '../../../contracts/src/event-ids';

/** Response of /legacy/api/stripe/checkout-session-invoice as normalised by Suite `eP()`. */
export interface CheckoutInvoice {
  invoiceId?: string;
  isBusiness?: boolean;
  isValidInvoice?: boolean;
  isFirstPurchase?: boolean;
  amountMajor?: number;
  amountMinor?: number;
  currency?: string;
  ltvValueMajor?: number | null;
  ltvCurrency?: string | null;
  /**
   * NEW field (backend + conversion-service value endpoint): the server-computed value of this
   * purchase, packages/contracts PurchaseValueScore (`E[gross_profit_90d | purchase]`, floored as
   * conversion-service sends it). The same number conversion-service sends with the same purchase.
   */
  profitValueMajor?: number | null;
  /** Currency of profitValueMajor (the score's `currency`). When absent, the invoice currency. */
  profitCurrency?: string | null;
}

export interface PlanItem {
  item_id: string;
  item_name: string;
  quantity: number;
}

export interface Money {
  value: number;
  currency: string;
}

export type SkipReason = 'invoice_unresolved' | 'invoice_id_invalid' | 'amount_missing' | 'currency_missing';

/**
 * Which number a purchase tag sent: `profit` = the server-computed profitValueMajor (the same value
 * as conversion-service's copy); `ltv` = ltvValueMajor, today's Meta/TikTok value; `cash` = the
 * first-invoice amount. Record it with the conversion (conversion_reported `value_basis`).
 */
export type ValueBasis = 'profit' | 'ltv' | 'cash';

export interface PurchaseValue extends Money {
  value_basis: ValueBasis;
}

export interface ResolvedPurchase {
  kind: 'report';
  invoiceId: string;
  /** `sub_<invoiceId>`: Google Ads, Reddit, TikTok, X, UET (transaction_id and event_id), LinkedIn eventId. */
  transactionId: `sub_${string}`;
  /** `purchase_<invoiceId>`: Meta Purchase eventID and OpenAI Ads subscription_created, as shipped. */
  eventId: `purchase_${string}`;
  /** First-invoice amount (OpenAI Ads amount, Brevo, the business-subscription rule). */
  cash: Money;
  /** Meta Purchase, TikTok (first_purchase), business_subscription: profit, else ltv (Suite `ek()`), else cash. */
  value: PurchaseValue;
  /** gtag purchase (Google Ads x2, Reddit, X, LinkedIn via GTM) and UET: profit, else cash (Suite `eR()`). */
  orderValue: PurchaseValue;
  amountMinor: number | undefined;
  /** isValidInvoice && isFirstPurchase (Meta Purchase, first_purchase, business_subscription). */
  isFirstValid: boolean;
  isBusiness: boolean;
  item: PlanItem;
}

export interface SkippedPurchase {
  kind: 'skip';
  reason: SkipReason;
}

export type PurchaseDecision = ResolvedPurchase | SkippedPurchase;

const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

const moneyAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const currencyCode = (v: unknown): string | null => (typeof v === 'string' && CURRENCY_PATTERN.test(v) ? v.toUpperCase() : null);

/**
 * The value a purchase tag sends. `profitValueMajor` (server-computed, the value conversion-service
 * sends with the same purchase) whenever the backend returns a usable one; otherwise the tag's
 * legacy basis: `'ltv'` (Meta, TikTok today: ltvValueMajor, else the amount) or `'cash'` (gtag
 * purchase today: the amount). `value_basis` says which was used. null when nothing is usable.
 */
export function choosePurchaseValue(invoice: CheckoutInvoice, legacy: 'ltv' | 'cash'): PurchaseValue | null {
  const invoiceCurrency = currencyCode(invoice.currency);
  if (moneyAmount(invoice.profitValueMajor)) {
    const currency = invoice.profitCurrency == null ? invoiceCurrency : currencyCode(invoice.profitCurrency);
    if (currency) return { value: invoice.profitValueMajor, currency, value_basis: 'profit' };
  }
  if (legacy === 'ltv' && moneyAmount(invoice.ltvValueMajor)) {
    const currency = currencyCode(invoice.ltvCurrency);
    if (currency) return { value: invoice.ltvValueMajor, currency, value_basis: 'ltv' };
  }
  if (moneyAmount(invoice.amountMajor) && invoiceCurrency) return { value: invoice.amountMajor, currency: invoiceCurrency, value_basis: 'cash' };
  return null;
}

/**
 * The unstable id shapes shipped today: `sub_<tierKey>_<tier>_<uid|unknown>_<Date.now()>`
 * (Suite eE, legacy s()). A 12+ digit tail is a millisecond timestamp.
 */
export function isFallbackTransactionId(id: string): boolean {
  return /^sub_[A-Za-z0-9]+_\d+_[^_]*_\d{12,}$/.test(id) || /_\d{13}$/.test(id);
}

export function resolveClientPurchase(invoice: CheckoutInvoice | null | undefined, item: PlanItem): PurchaseDecision {
  if (!invoice || invoice.invoiceId === undefined || invoice.invoiceId === null) {
    return { kind: 'skip', reason: 'invoice_unresolved' };
  }
  const invoiceId = String(invoice.invoiceId);
  let transactionId: `sub_${string}`;
  let eventId: `purchase_${string}`;
  try {
    // The contracts rule and builders (in_…): the same ids the server twin sends.
    transactionId = purchaseOrderId(invoiceId) as `sub_${string}`;
    eventId = purchaseEventId(invoiceId) as `purchase_${string}`;
  } catch {
    return { kind: 'skip', reason: 'invoice_id_invalid' };
  }
  const amount = invoice.amountMajor;
  if (!moneyAmount(amount)) return { kind: 'skip', reason: 'amount_missing' };
  const currency = currencyCode(invoice.currency);
  if (!currency) return { kind: 'skip', reason: 'currency_missing' };

  const cash: Money = { value: amount, currency };
  // Both non-null: the amount and currency are valid.
  const value = choosePurchaseValue(invoice, 'ltv')!;
  const orderValue = choosePurchaseValue(invoice, 'cash')!;

  return {
    kind: 'report',
    invoiceId,
    transactionId,
    eventId,
    cash,
    value,
    orderValue,
    amountMinor: typeof invoice.amountMinor === 'number' ? invoice.amountMinor : undefined,
    isFirstValid: invoice.isValidInvoice === true && invoice.isFirstPurchase === true,
    isBusiness: invoice.isBusiness === true,
    item,
  };
}

export interface GtagPurchase {
  transaction_id: string;
  value: number;
  currency: string;
  items: Array<PlanItem & { price: number }>;
}

/** Payload for gtag('event','purchase', …) (Suite module 114607 `purchase()`), as eR() builds it, valued by orderValue. */
export function toGtagPurchase(p: ResolvedPurchase): GtagPurchase {
  return {
    transaction_id: p.transactionId,
    value: p.orderValue.value,
    currency: p.orderValue.currency,
    items: [{ ...p.item, price: p.orderValue.value }],
  };
}

export interface UetPurchase {
  transaction_id: string;
  revenue_value: number;
  currency: string;
  /**
   * UET JS ↔ UET Conversions API dedup key. Microsoft: "If you use UET JavaScript and CAPI for the
   * same conversion event, use the same UET tagId, eventId, and eventName"; the JS parameter is
   * `event_id` (uet-conversion-api-integration, "Deduplication example").
   */
  event_id: string;
}

/**
 * Arguments for `uetq.push('event','purchase', …)` as Suite module 114607 `K()` (and legacy `_app`
 * `o()`) build them, plus `event_id` = `sub_<invoiceId>` (contracts: microsoft purchase
 * dedup_key_template `sub_{invoice_id}`, event name `purchase`).
 */
export function toUetPurchase(p: ResolvedPurchase): ['event', 'purchase', UetPurchase] {
  return ['event', 'purchase', { transaction_id: p.transactionId, revenue_value: p.orderValue.value, currency: p.orderValue.currency, event_id: p.transactionId }];
}

/**
 * Arguments for `fbq('track', 'Purchase', …)`: the value conversion-service's Meta copy carries
 * (profit) whenever the backend returns it. Meta keeps the FIRST received copy of a deduplicated
 * event, usually this one, so this is the value Meta reports.
 */
export function toMetaPurchase(p: ResolvedPurchase): ['track', 'Purchase', Money, { eventID: string }] {
  return ['track', 'Purchase', { value: p.value.value, currency: p.value.currency }, { eventID: p.eventId }];
}

export interface FirstPurchasePush {
  event: 'first_purchase' | 'business_subscription';
  eventModel: { transaction_id: string; value: number; currency: string; items: Array<PlanItem & { price: number }> };
  user_data?: { email: string };
}

function firstPurchasePush(p: ResolvedPurchase, email: string | undefined, event: FirstPurchasePush['event']): FirstPurchasePush {
  const normalized = email?.trim().toLowerCase();
  return {
    event,
    eventModel: {
      transaction_id: p.transactionId,
      value: p.value.value,
      currency: p.value.currency,
      items: [{ ...p.item, price: p.value.value / p.item.quantity }],
    },
    ...(normalized ? { user_data: { email: normalized } } : {}),
  };
}

/** `first_purchase` push (Suite `eN()` shape) — only for the first valid invoice. */
export function toFirstPurchasePush(p: ResolvedPurchase, email: string | undefined): FirstPurchasePush | null {
  return p.isFirstValid ? firstPurchasePush(p, email, 'first_purchase') : null;
}

/** `business_subscription` push (Suite `eA()` rules: business, first valid, positive value). */
export function toBusinessSubscriptionPush(p: ResolvedPurchase, email: string | undefined): FirstPurchasePush | null {
  if (!p.isBusiness || !p.isFirstValid || !(p.value.value > 0) || !(p.cash.value > 0)) return null;
  return firstPurchasePush(p, email, 'business_subscription');
}

/**
 * Plan item from the Stripe return params (same naming as Suite eE(), without price or time):
 * item_id `<tierKey>_<tier>[_year]`, item_name `<tierKey>`.
 */
export function planItemFromParams(
  params: { tierParam: string | undefined | null; intervalParam: string | undefined | null; quantity?: number },
  tierKeyOf: (tier: number) => string | undefined,
): PlanItem | null {
  const tier = Number(params.tierParam);
  if (!params.tierParam || !Number.isFinite(tier)) return null;
  const tierKey = tierKeyOf(tier) ?? `tier_${tier}`;
  const yearly = params.intervalParam === 'year';
  return { item_id: `${tierKey}_${tier}${yearly ? '_year' : ''}`, item_name: tierKey, quantity: params.quantity ?? 1 };
}

/** `conversion_reported.outcome` for channels the client deliberately left to the server. */
export function skippedOutcome(reason: SkipReason): `skipped_${SkipReason}` {
  return `skipped_${reason}`;
}

/** Properties for the Amplitude `conversion_reported` event when the client skips (see eO()). */
export function conversionReportedForSkip(
  channel: string,
  conversionType: 'purchase' | 'purchase_first',
  reason: SkipReason,
): Record<string, string | boolean> {
  return {
    report_layer: 'client',
    channel,
    conversion_type: conversionType,
    fired: false,
    outcome: skippedOutcome(reason),
    has_dedup_id: false,
  };
}

/** Guard for any id about to leave the browser: deterministic invoice-derived ids only (contracts parseBrowserDedupId). */
export function assertDeterministicId(id: string): string {
  const parsed = parseBrowserDedupId(id);
  const invoiceDerived = (parsed.kind === 'purchase_event' || parsed.kind === 'purchase_order') && 'invoice_id' in parsed;
  if (!invoiceDerived || isFallbackTransactionId(id)) {
    throw new Error(`non-deterministic conversion id: ${id}`);
  }
  return id;
}
