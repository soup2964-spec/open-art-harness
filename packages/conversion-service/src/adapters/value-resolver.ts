/**
 * ValueResolver: the value an ad platform receives with a purchase.
 *
 * Estimand. Ad platforms optimise the value of the conversion they are told about, so the value must
 * be conditioned on that conversion: PurchaseValueScore.predicted_profit_90d =
 * E[gross_profit_90d | purchase], scored at PURCHASE TIME from point-in-time features (contracts
 * PurchaseValueScore, warehouse fct_purchase_value_score). The signup+24h PredictedProfit is the
 * unconditional E[90d profit per exposed user]: right for experiment and bandit readouts, wrong as
 * an ad value, and never read here.
 *
 *   acquisition purchase (is_first_purchase = true)
 *     score scored within VALUE_SCORE_SLA_MS of the purchase -> predicted_profit_90d
 *       (a loss-maker sends VALUE_FLOOR_USD with floored = true; the raw estimate is kept)
 *     no such score yet, SLA still running                  -> provisional cash, pending: every send
 *                                                               is held (hold_gate value_score)
 *     no score within the SLA                                -> cash, value_basis = cash_fallback
 *   later purchases (renewal, upgrade, add-on)               -> cash, value_basis = cash (predicted
 *                                                               value belongs on the acquisition only,
 *                                                               so a user's values never overlap)
 *   non-cash events                                          -> null
 *   refunds / chargebacks                                    -> null here (adjustments restate)
 *
 * First decision wins. The decision for an acquisition purchase is stored (value_decisions/<event_id>)
 * the first time anyone makes it: the server's send, or GET /value, which OpenArt's
 * checkout-session-invoice endpoint calls so the browser pixel sends the SAME number. Meta and TikTok
 * keep the first-received copy (usually the pixel), so identical values are what makes the server
 * value count.
 *
 * FX: amounts are converted to the reporting currency with an injectable FxRateProvider; without a
 * rate an amount is sent whole in its own currency (in_reporting_currency = false), never mixed.
 * The ledger keeps cash only; predicted value never enters it.
 */

import { PURCHASE_EVENT_NAMES, PurchaseValueScoreSchema } from '@openart-signal/contracts';
import type { ConversionLedgerEvent, PurchaseValueScore } from '@openart-signal/contracts';
import { currencyExponent, minorToMajor, roundMajor } from '../money.js';
import { RETENTION, expireAt } from '../retention.js';
import { DAY_MS, toUtc } from '../time.js';
import type { ResolvedValue, ValueBasis } from '../types.js';
import { bqJson, bqScalar, qualifiedTable } from './bigquery.js';
import type { BigQueryPort, TableRef } from './bigquery.js';
import type { DocumentStore } from './document-store.js';
import type { FxRateProvider } from './fx.js';

export const VALUE_DECISIONS = 'value_decisions';

export interface PurchaseValueReader {
  /** The earliest score for a purchase event (purchase_<invoiceId>) that is visible as of asOfMs. */
  byEventId(eventId: string, occurredAtMs: number, asOfMs: number): Promise<PurchaseValueScore | null>;
}

export class InMemoryPurchaseValues implements PurchaseValueReader {
  private readonly rows: PurchaseValueScore[];

  constructor(rows: PurchaseValueScore[] = []) {
    this.rows = rows.map((r) => structuredClone(r));
  }

  add(row: PurchaseValueScore): void {
    this.rows.push(structuredClone(row));
  }

  async byEventId(eventId: string, _occurredAtMs: number, asOfMs: number): Promise<PurchaseValueScore | null> {
    let best: PurchaseValueScore | null = null;
    for (const r of this.rows) {
      if (r.event_id !== eventId || Date.parse(r.scored_at) > asOfMs) continue;
      if (!best || Date.parse(r.scored_at) < Date.parse(best.scored_at)) best = r;
    }
    return best ? structuredClone(best) : null;
  }
}

const SCORE_COLUMNS = [
  'event_id', 'invoice_id', 'user_id', 'occurred_at', 'scored_at', 'estimand', 'horizon_days',
  'predicted_revenue_90d', 'predicted_generation_cost_90d', 'predicted_fees_90d', 'predicted_refund_risk',
  'predicted_profit_90d', 'interval_low', 'interval_high', 'cash_value', 'currency', 'model_version',
  'run_id', 'fitted_params_ref', 'features_snapshot',
] as const satisfies ReadonlyArray<keyof PurchaseValueScore>;

const NUMERIC_COLUMNS = new Set<string>([
  'horizon_days', 'predicted_revenue_90d', 'predicted_generation_cost_90d', 'predicted_fees_90d', 'predicted_refund_risk',
  'predicted_profit_90d', 'interval_low', 'interval_high', 'cash_value',
]);

/** Reads fct_purchase_value_score (built by packages/warehouse; partitioned by DATE(occurred_at)). */
export class BigQueryPurchaseValueReader implements PurchaseValueReader {
  private readonly table: string;

  constructor(
    private readonly bq: BigQueryPort,
    ref: TableRef,
  ) {
    this.table = qualifiedTable(ref);
  }

  async byEventId(eventId: string, occurredAtMs: number, asOfMs: number): Promise<PurchaseValueScore | null> {
    const rows = await this.bq.query<Record<string, unknown>>(
      `SELECT ${SCORE_COLUMNS.join(', ')} FROM ${this.table} ` +
        'WHERE event_id = @event_id AND occurred_at BETWEEN TIMESTAMP(@from) AND TIMESTAMP(@to) AND scored_at <= TIMESTAMP(@as_of) ' +
        'ORDER BY scored_at ASC LIMIT 1',
      { event_id: eventId, from: toUtc(occurredAtMs - DAY_MS), to: toUtc(occurredAtMs + DAY_MS), as_of: toUtc(asOfMs) },
    );
    const r = rows[0];
    if (!r) return null;
    const candidate: Record<string, unknown> = {};
    for (const col of SCORE_COLUMNS) {
      const v = bqScalar(r[col]);
      if (col === 'occurred_at' || col === 'scored_at') candidate[col] = typeof v === 'string' ? toUtc(Date.parse(v)) : v;
      else if (col === 'features_snapshot') candidate[col] = bqJson<unknown>(r[col], null);
      else if (NUMERIC_COLUMNS.has(col)) candidate[col] = v === null || v === undefined ? v : Number(v);
      else candidate[col] = v === undefined ? null : v;
    }
    const parsed = PurchaseValueScoreSchema.safeParse(candidate);
    // A row that breaks the contract (components that do not add up, post-purchase features) is never sent.
    return parsed.success ? parsed.data : null;
  }
}

/** What a value decision needs to know about a purchase (also stored on held outbox records). */
export interface PurchaseValueInput {
  event_id: string;
  user_id: string | null;
  occurred_at_ms: number;
  cash_minor: number;
  currency: string;
  /** is_first_purchase: only acquisition purchases carry a predicted value. */
  acquisition: boolean;
}

const PURCHASES = new Set<string>(PURCHASE_EVENT_NAMES);

export function valueInputOf(row: ConversionLedgerEvent): PurchaseValueInput | null {
  if (!PURCHASES.has(row.event_name) || row.cash_value_minor === null || row.currency === null) return null;
  return {
    event_id: row.event_id,
    user_id: row.user_id,
    occurred_at_ms: Date.parse(row.occurred_at),
    cash_minor: row.cash_value_minor,
    currency: row.currency,
    acquisition: row.is_first_purchase === true,
  };
}

export type ValueDecider = 'server' | 'value_endpoint';

export interface ValueDecisionDoc {
  event_id: string;
  user_id: string | null;
  decided_at_ms: number;
  decided_by: ValueDecider;
  value: ResolvedValue;
  expire_at: string;
}

export interface ValueResolverDeps {
  scores: PurchaseValueReader;
  /** Holds the first-decision-wins records. */
  store: DocumentStore;
  fx: FxRateProvider;
}

export interface ValueResolverOptions {
  /** Floor for predicted values in the reporting currency (must be > 0). */
  floorMajor: number;
  reportingCurrency: string;
  /** A score counts only if scored within this long after the purchase. */
  scoreSlaMs: number;
}

export class ValueResolver {
  private readonly floor: number;

  constructor(
    private readonly deps: ValueResolverDeps,
    private readonly options: ValueResolverOptions,
  ) {
    this.floor = options.floorMajor;
    if (!(this.floor > 0) || !Number.isFinite(this.floor)) throw new Error(`value floor must be > 0 (got ${this.floor})`);
  }

  get scoreSlaMs(): number {
    return this.options.scoreSlaMs;
  }

  /** At enrichment: the final value, or provisional cash with pending=true while the SLA runs. */
  async resolve(row: ConversionLedgerEvent, nowMs: number): Promise<ResolvedValue | null> {
    const input = valueInputOf(row);
    if (!input) return null;
    const decided = await this.decide(input, nowMs, 'server', { force: false });
    if (decided) return decided;
    return { ...(await this.cash(input, 'cash_fallback')), pending: true };
  }

  /**
   * The stored decision if one exists; else a purchase-time score if one is usable; else cash_fallback
   * once the SLA has passed (or at once with force). null = keep waiting. The first decision is stored
   * and every later caller (server send, GET /value) gets exactly the same value.
   */
  async decide(input: PurchaseValueInput, nowMs: number, by: ValueDecider, options: { force: boolean }): Promise<ResolvedValue | null> {
    if (!input.acquisition) return this.cash(input, 'cash');
    const existing = await this.deps.store.get<ValueDecisionDoc>(VALUE_DECISIONS, input.event_id);
    if (existing) return { ...existing.data.value, pending: false };

    const score = await this.usableScore(input, nowMs);
    let value: ResolvedValue | null = null;
    if (score) value = await this.fromScore(score, input);
    else if (options.force || nowMs >= input.occurred_at_ms + this.options.scoreSlaMs) value = await this.cash(input, 'cash_fallback');
    if (!value) return null;

    const doc: ValueDecisionDoc = {
      event_id: input.event_id,
      user_id: input.user_id,
      decided_at_ms: nowMs,
      decided_by: by,
      value,
      expire_at: expireAt(nowMs, RETENTION.valueDecisionDays),
    };
    if (await this.deps.store.create(VALUE_DECISIONS, input.event_id, doc)) return value;
    // Someone decided first (the browser path or another instance): theirs wins.
    const winner = await this.deps.store.get<ValueDecisionDoc>(VALUE_DECISIONS, input.event_id);
    return winner ? { ...winner.data.value, pending: false } : value;
  }

  private async usableScore(input: PurchaseValueInput, nowMs: number): Promise<PurchaseValueScore | null> {
    const score = await this.deps.scores.byEventId(input.event_id, input.occurred_at_ms, nowMs);
    if (!score) return null;
    if (input.user_id !== null && score.user_id !== input.user_id) return null;
    const scoredMs = Date.parse(score.scored_at);
    // Purchase-time only: scored at or after the purchase and within the SLA.
    if (scoredMs < input.occurred_at_ms || scoredMs - input.occurred_at_ms > this.options.scoreSlaMs) return null;
    return score;
  }

  private async fromScore(score: PurchaseValueScore, input: PurchaseValueInput): Promise<ResolvedValue> {
    const rate = await this.deps.fx.rate(score.currency, this.options.reportingCurrency, input.occurred_at_ms);
    const currency = rate === null ? score.currency : this.options.reportingCurrency;
    const raw = roundMajor(score.predicted_profit_90d * (rate ?? 1), currency);
    // The floor is defined in the reporting currency; an unconverted amount uses its currency's smallest unit.
    const floor = rate === null ? 10 ** -currencyExponent(currency) : this.floor;
    const floored = raw < floor;
    const value = floored ? roundMajor(floor, currency) : raw;
    return {
      value,
      currency,
      basis: 'predicted_profit_90d',
      floored,
      raw_value: raw,
      model_version: score.model_version,
      predicted_ltv: value,
      in_reporting_currency: rate !== null,
      pending: false,
    };
  }

  private async cash(input: PurchaseValueInput, basis: ValueBasis): Promise<ResolvedValue> {
    const major = minorToMajor(input.cash_minor, input.currency);
    const rate = await this.deps.fx.rate(input.currency, this.options.reportingCurrency, input.occurred_at_ms);
    const currency = rate === null ? input.currency : this.options.reportingCurrency;
    const value = rate === null ? major : roundMajor(major * rate, currency);
    return {
      value,
      currency,
      basis,
      floored: false,
      raw_value: value,
      model_version: null,
      predicted_ltv: null,
      in_reporting_currency: rate !== null,
      pending: false,
    };
  }
}
