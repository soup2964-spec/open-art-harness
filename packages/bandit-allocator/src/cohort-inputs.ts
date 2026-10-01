/**
 * Allocator inputs computed from the contracts' synthetic cohort, so this package can be tested
 * and simulated without the warehouse. In production the same rows come from packages/warehouse.
 *
 * What a row exposes, and when (the delays the warehouse would have):
 *   - the 24h score: a SIGNALS-ONLY predicted-profit model (24h behaviour: paid within 24h,
 *     activation, trial credits spent, affiliate channel; no arm feature) fit on reference users'
 *     realized 90-day profit (`fitScoreModel`). Available one day after exposure;
 *   - matured outcomes at a FIXED horizon (default 14 days, the generator's conversion window):
 *     conversion, net value (winsorized), measured serving cost and refunds. A user only counts once
 *     the horizon has elapsed at the as-of date, so recent days carry 0 matured users;
 *   - 24h guardrail metrics: activation, generations started and failed.
 * Realized 90-day profit is never put in a row: it is what the simulation scores policies on.
 *
 * Profit = cash in - generation cost at vendor list price - fees - refund/chargeback loss. Fee
 * rates are ILLUSTRATIVE assumptions (Stripe standard card pricing, a Stripe dispute fee and the
 * Tolt 20% default commission from OpenArt's affiliate terms, research/12 A4); generation costs come
 * from the contracts seed fixtures/seeds/model_costs.csv.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MODEL_FLAGS,
  parseModelCostsCsv,
  type ExperimentExposure,
  type PredictedProfit,
} from '@openart-signal/contracts';
import type { AmplitudeRow, LedgerEntry, StripeEvent } from '@openart-signal/contracts/builders';
import type { CohortOutput } from '@openart-signal/contracts/cohort';
import { COHORT_PARAMS } from '@openart-signal/contracts/cohort/params';
import { channelFromUserProperties, countryBucket, deviceFromAmplitude, type Segment } from './segments.js';
import { daysBetween, type AllocationSlice, type ExperimentProfitByArmRow } from './warehouse.js';

const require = createRequire(import.meta.url);
const DAY_MS = 86_400_000;

export const PROFIT_ASSUMPTIONS = {
  /** PredictedProfit.horizon_days is 90. */
  horizonDays: 90,
  /** Fixed horizon of the matured outcomes (the generator converts within 14 days of signup). */
  outcomeHorizonDays: 14,
  /** ILLUSTRATIVE: Stripe standard card pricing (2.9% + $0.30 per successful charge). */
  stripePercentFee: 0.029,
  stripeFixedFeeUsd: 0.3,
  /** ILLUSTRATIVE: Stripe dispute fee per chargeback. */
  disputeFeeUsd: 15,
  /** Tolt default commission, 20% of each valid purchase for a year (research/12 A4). */
  affiliateCommission: 0.2,
} as const;

export type ProfitAssumptions = { [K in keyof typeof PROFIT_ASSUMPTIONS]: number };

/** ILLUSTRATIVE per-user winsorization cap of the matured value (an annual Wonder plan is ~$1.2k). */
export const DEFAULT_VALUE_CAP_USD = 500;

export type CostLookup = (businessType: string, unitCredits: number) => number;

/** (business_type, credits per unit) -> vendor list cost in USD, from the contracts seed. */
export function loadModelCosts(): CostLookup {
  const path = require.resolve('@openart-signal/contracts/fixtures/seeds/model_costs.csv');
  const rows = parseModelCostsCsv(readFileSync(path, 'utf8'));
  const table = new Map<string, number>();
  for (const r of rows) {
    if (r.list_cost_usd === null) continue;
    const key = `${r.business_type}|${r.credits}`;
    if (!table.has(key)) table.set(key, r.list_cost_usd);
  }
  return (businessType, unitCredits) => {
    const cost = table.get(`${businessType}|${unitCredits}`);
    if (cost === undefined) throw new Error(`no model_costs row for ${businessType} at ${unitCredits} credits`);
    return cost;
  };
}

type FixtureCohort = Omit<CohortOutput, 'manifest'> & { manifest: CohortOutput['manifest'] };

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

/** The committed 2,000-user cohort (packages/contracts/fixtures/cohort/*.jsonl). */
export function loadFixtureCohort(): FixtureCohort {
  const dir = dirname(require.resolve('@openart-signal/contracts/fixtures/cohort/manifest.json'));
  return {
    manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as CohortOutput['manifest'],
    appUsers: readJsonl(join(dir, 'app_users.jsonl')),
    stripeEvents: readJsonl(join(dir, 'stripe_events.jsonl')),
    ledgerEntries: readJsonl(join(dir, 'credit_ledger.jsonl')),
    amplitudeEvents: readJsonl(join(dir, 'amplitude_events.jsonl')),
    amplitudeExposures: readJsonl(join(dir, 'amplitude_exposures.jsonl')),
    truth: readJsonl(join(dir, 'cohort_truth.jsonl')),
  };
}

export interface UserOutcome {
  user_id: string;
  signup_at: string;
  arms: Record<string, string>;
  segment: Segment;
  /** Subscribed (purchase_first) at any time in the data. */
  converted: boolean;
  // --- realized over `horizonDays` (90): the objective the simulation scores policies on ---
  revenue_usd: number;
  refund_loss_usd: number;
  generation_cost_usd: number;
  fees_usd: number;
  profit_usd: number;
  charges: number;
  generations: number;
  credits_consumed: number;
  // --- first 24h ---
  generations_24h: number;
  video_generations_24h: number;
  credits_consumed_24h: number;
  generation_cost_24h_usd: number;
  paid_within_24h: boolean;
  activated_24h: boolean;
  /** Generations started in the first 24h, failed ones included. */
  generations_started_24h: number;
  failed_generations_24h: number;
  // --- the fixed outcome horizon (`outcomeHorizonDays`) ---
  outcome_horizon_days: number;
  converted_h: boolean;
  /** Net value within the horizon: revenue - fees - refund/chargeback loss (0 for non-converters). */
  value_h_usd: number;
  cost_h_usd: number;
  /** A converter refunded or charged back within the horizon. */
  refunded_h: boolean;
}

/** Earliest Amplitude row per user -> segment (country, device, first-touch channel). */
export function segmentsFromAmplitude(rows: readonly AmplitudeRow[]): Map<string, Segment> {
  const first = new Map<string, AmplitudeRow>();
  for (const r of rows) {
    if (!r.user_id) continue;
    const prev = first.get(r.user_id);
    if (!prev || r.event_time < prev.event_time) first.set(r.user_id, r);
  }
  const out = new Map<string, Segment>();
  for (const [uid, r] of first) {
    out.set(uid, {
      country_bucket: countryBucket(r.country),
      device: deviceFromAmplitude(r),
      acquisition_channel: channelFromUserProperties(r.user_properties),
    });
  }
  return out;
}

type Obj = Record<string, unknown>;
const obj = (e: StripeEvent) => e.data.object as Obj;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function outcomesFromCohort(
  cohort: Pick<CohortOutput, 'stripeEvents' | 'ledgerEntries' | 'amplitudeEvents' | 'truth'>,
  assumptions: ProfitAssumptions = PROFIT_ASSUMPTIONS,
  costOf: CostLookup = loadModelCosts(),
): UserOutcome[] {
  const segments = segmentsFromAmplitude(cohort.amplitudeEvents);

  // Stripe: cash in per charge, refunds and disputes per customer.
  const invoiceCustomer = new Map<string, string>();
  const piInvoice = new Map<string, string>();
  for (const e of cohort.stripeEvents) {
    if (e.type === 'invoice.paid') invoiceCustomer.set(String(obj(e).id), String(obj(e).customer));
    if (e.type === 'invoice_payment.paid') {
      const o = obj(e);
      piInvoice.set(String((o.payment as Obj).payment_intent), String(o.invoice));
    }
  }
  const cash = new Map<string, Array<{ atMs: number; minor: number; kind: 'charge' | 'refund' | 'dispute' }>>();
  const push = (uid: string, atMs: number, minor: number, kind: 'charge' | 'refund' | 'dispute') => {
    const list = cash.get(uid) ?? [];
    list.push({ atMs, minor, kind });
    cash.set(uid, list);
  };
  for (const e of cohort.stripeEvents) {
    const o = obj(e);
    const at = e.created * 1000;
    if (e.type === 'invoice.paid') push(String(o.customer), at, Number(o.amount_paid), 'charge');
    else if (e.type === 'checkout.session.completed' && o.mode === 'payment') push(String(o.customer), at, Number(o.amount_total), 'charge');
    else if (e.type === 'charge.refunded') {
      const before = Number((e.data.previous_attributes as Obj | undefined)?.amount_refunded ?? 0);
      push(String(o.customer), at, Number(o.amount_refunded) - before, 'refund');
    } else if (e.type === 'charge.dispute.created') {
      const invoice = piInvoice.get(String(o.payment_intent));
      const customer = invoice ? invoiceCustomer.get(invoice) : undefined;
      if (!customer) throw new Error(`dispute ${String(o.id)} cannot be joined to a customer`);
      push(customer, at, Number(o.amount), 'dispute');
    }
  }

  // Ledger: every generation started (CONSUME); failed = a later REFUND of the same history id.
  const refunded = new Set<string>();
  for (const l of cohort.ledgerEntries) if (l.type === 'REFUND') refunded.add(`${l.userId}|${l.reference.businessId}`);
  const gens = new Map<string, Array<{ entry: LedgerEntry; failed: boolean }>>();
  for (const l of cohort.ledgerEntries) {
    if (l.type !== 'CONSUME') continue;
    const list = gens.get(l.userId) ?? [];
    list.push({ entry: l, failed: refunded.has(`${l.userId}|${l.reference.businessId}`) });
    gens.set(l.userId, list);
  }

  const fees = (revenueUsd: number, charges: number, disputes: number, netUsd: number, affiliate: boolean) =>
    revenueUsd * assumptions.stripePercentFee + charges * assumptions.stripeFixedFeeUsd + disputes * assumptions.disputeFeeUsd + (affiliate ? assumptions.affiliateCommission * Math.max(0, netUsd) : 0);

  return cohort.truth.map((t) => {
    const signupMs = Date.parse(t.signup_at);
    const horizonEnd = signupMs + assumptions.horizonDays * DAY_MS;
    const outcomeEnd = signupMs + assumptions.outcomeHorizonDays * DAY_MS;
    const dayEnd = signupMs + DAY_MS;
    const segment = segments.get(t.user_id);
    if (!segment) throw new Error(`no Amplitude rows for ${t.user_id}`);
    const affiliate = segment.acquisition_channel === 'affiliate';

    const money = (end: number) => {
      let revenueMinor = 0;
      let refundMinor = 0;
      let charges = 0;
      let disputes = 0;
      let refundEvents = 0;
      for (const c of cash.get(t.user_id) ?? []) {
        if (c.atMs > end) continue;
        if (c.kind === 'charge') {
          revenueMinor += c.minor;
          if (c.minor > 0) charges += 1;
        } else {
          refundMinor += c.minor;
          refundEvents += 1;
          if (c.kind === 'dispute') disputes += 1;
        }
      }
      const revenue = revenueMinor / 100;
      const refund = refundMinor / 100;
      return { revenue, refund, charges, refundEvents, fees: fees(revenue, charges, disputes, revenue - refund, affiliate) };
    };
    const full = money(horizonEnd);
    const atHorizon = money(outcomeEnd);
    let paid24 = false;
    for (const c of cash.get(t.user_id) ?? []) if (c.kind === 'charge' && c.atMs <= dayEnd) paid24 = true;

    let cost = 0;
    let costH = 0;
    let cost24 = 0;
    let credits = 0;
    let credits24 = 0;
    let generations = 0;
    let gens24 = 0;
    let videos24 = 0;
    let started24 = 0;
    let failed24 = 0;
    for (const { entry: l, failed } of gens.get(t.user_id) ?? []) {
      const at = Date.parse(l.createdAt);
      if (at <= dayEnd) {
        started24 += 1;
        if (failed) failed24 += 1;
      }
      if (failed || at > horizonEnd) continue;
      const detail = l.businessDetails?.[0];
      const unitCredits = detail?.unitCredits ?? -l.amount;
      const quantity = detail?.quantity ?? 1;
      const c = costOf(l.reference.businessType, unitCredits) * quantity;
      cost += c;
      credits += -l.amount;
      generations += 1;
      if (at <= outcomeEnd) costH += c;
      if (at <= dayEnd) {
        cost24 += c;
        credits24 += -l.amount;
        gens24 += 1;
        if (l.reference.businessType.endsWith(':text2video')) videos24 += 1;
      }
    }
    const convertedH = t.first_purchase_at !== null && Date.parse(t.first_purchase_at) <= outcomeEnd;
    return {
      user_id: t.user_id,
      signup_at: t.signup_at,
      arms: { [DEFAULT_MODEL_FLAGS.createImage]: t.arm_create_image, [DEFAULT_MODEL_FLAGS.createVideo]: t.arm_create_video },
      segment,
      converted: t.converted,
      revenue_usd: round6(full.revenue),
      refund_loss_usd: round6(full.refund),
      generation_cost_usd: round6(cost),
      fees_usd: round6(full.fees),
      profit_usd: round6(full.revenue - cost - full.fees - full.refund),
      charges: full.charges,
      generations,
      credits_consumed: credits,
      generations_24h: gens24,
      video_generations_24h: videos24,
      credits_consumed_24h: credits24,
      generation_cost_24h_usd: round6(cost24),
      paid_within_24h: paid24,
      activated_24h: gens24 > 0,
      generations_started_24h: started24,
      failed_generations_24h: failed24,
      outcome_horizon_days: assumptions.outcomeHorizonDays,
      converted_h: convertedH,
      value_h_usd: convertedH ? round6(atHorizon.revenue - atHorizon.fees - atHorizon.refund) : 0,
      cost_h_usd: round6(costH),
      refunded_h: convertedH && atHorizon.refundEvents > 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 24h predicted-profit score (signals only)
// ---------------------------------------------------------------------------

export interface ScoreComponents {
  revenue: number;
  cost: number;
  fees: number;
  refund: number;
}

export interface ScoreModel {
  version: string;
  predict(o: UserOutcome): ScoreComponents & { profit: number };
}

/** 24h features the score may use: no arm, nothing observed after the first 24h. */
export function scoreCell(o: UserOutcome): { cell: string; parent: string } {
  const paid = o.paid_within_24h ? 'paid' : 'free';
  const activation = !o.activated_24h ? 'inactive' : o.credits_consumed_24h >= COHORT_PARAMS.trialCredits ? 'trial_spent' : 'active';
  const channel = o.segment.acquisition_channel === 'affiliate' ? 'affiliate' : 'direct';
  return { cell: `${paid}|${activation}|${channel}`, parent: `${paid}|${activation}` };
}

/**
 * Fit the signals-only 24h score on REFERENCE users (history before the experiment): cell means of
 * each 90-day profit component, shrunk toward the parent cell and the global mean with `shrinkage`
 * pseudo-users. The components keep the PredictedProfit identity by construction.
 */
export function fitScoreModel(reference: readonly UserOutcome[], o: { version: string; shrinkage?: number } = { version: 'illustrative-24h-signals-v1' }): ScoreModel {
  const k = o.shrinkage ?? 50;
  type Acc = { n: number } & ScoreComponents;
  const empty = (): Acc => ({ n: 0, revenue: 0, cost: 0, fees: 0, refund: 0 });
  const add = (a: Acc, u: UserOutcome) => {
    a.n += 1;
    a.revenue += u.revenue_usd;
    a.cost += u.generation_cost_usd;
    a.fees += u.fees_usd;
    a.refund += u.refund_loss_usd;
  };
  const global = empty();
  const parents = new Map<string, Acc>();
  const cells = new Map<string, Acc>();
  for (const u of reference) {
    const { cell, parent } = scoreCell(u);
    add(global, u);
    if (!parents.has(parent)) parents.set(parent, empty());
    if (!cells.has(cell)) cells.set(cell, empty());
    add(parents.get(parent)!, u);
    add(cells.get(cell)!, u);
  }
  if (global.n === 0) throw new Error('fitScoreModel needs reference users');
  const keys = ['revenue', 'cost', 'fees', 'refund'] as const;
  const mean = (a: Acc): ScoreComponents => Object.fromEntries(keys.map((key) => [key, a[key] / a.n])) as unknown as ScoreComponents;
  const shrink = (a: Acc | undefined, toward: ScoreComponents): ScoreComponents =>
    a ? (Object.fromEntries(keys.map((key) => [key, (a[key] + k * toward[key]) / (a.n + k)])) as unknown as ScoreComponents) : toward;
  const g = mean(global);
  return {
    version: o.version,
    predict(u) {
      const { cell, parent } = scoreCell(u);
      const c = shrink(cells.get(cell), shrink(parents.get(parent), g));
      const r = { revenue: round6(c.revenue), cost: round6(c.cost), fees: round6(c.fees), refund: round6(c.refund) };
      return { ...r, profit: round6(r.revenue - r.cost - r.fees - r.refund) };
    },
  };
}

/** Contract rows for fct_predicted_profit_24h, scored by `score`. */
export function predictedProfitRows(outcomes: readonly UserOutcome[], score: ScoreModel): PredictedProfit[] {
  return outcomes.map((o) => {
    const p = score.predict(o);
    return {
      user_id: o.user_id,
      computed_at: new Date(Date.parse(o.signup_at) + DAY_MS).toISOString(),
      horizon_days: 90,
      feature_window_hours: 24,
      currency: 'USD',
      predicted_revenue: p.revenue,
      predicted_generation_cost: p.cost,
      predicted_fees: p.fees,
      predicted_refund_risk: p.refund,
      refund_probability: null,
      predicted_profit: p.profit,
      model_version: score.version,
      features: {
        arm_create_image: o.arms[DEFAULT_MODEL_FLAGS.createImage] ?? null,
        arm_create_video: o.arms[DEFAULT_MODEL_FLAGS.createVideo] ?? null,
        acquisition_channel: o.segment.acquisition_channel,
        country_bucket: o.segment.country_bucket,
        device: o.segment.device,
        generations_24h: o.generations_24h,
        video_generations_24h: o.video_generations_24h,
        credits_consumed_24h: o.credits_consumed_24h,
        generation_cost_24h_usd: o.generation_cost_24h_usd,
        paid_within_24h: o.paid_within_24h,
      },
    };
  });
}

/** First `$exposure` per (user, flag) -> contracts ExperimentExposure. */
export function exposuresFromCohort(cohort: Pick<CohortOutput, 'amplitudeExposures'>): ExperimentExposure[] {
  const first = new Map<string, ExperimentExposure>();
  for (const r of cohort.amplitudeExposures) {
    if (r.event_type !== '$exposure' || !r.user_id) continue;
    const flag = String(r.event_properties.flag_key);
    const key = `${r.user_id}|${flag}`;
    const prev = first.get(key);
    if (prev && prev.first_exposed_at <= r.event_time) continue;
    first.set(key, {
      user_id: r.user_id,
      flag_key: flag,
      arm: String(r.event_properties.variant),
      first_exposed_at: r.event_time,
      source: 'amplitude_exposure_event',
      device_id: r.device_id,
    });
  }
  return [...first.values()].sort((a, b) => (a.first_exposed_at < b.first_exposed_at ? -1 : a.first_exposed_at > b.first_exposed_at ? 1 : a.user_id < b.user_id ? -1 : 1));
}

export interface MartRowOptions {
  sliceOf: (userId: string) => AllocationSlice;
  /** The 24h score written to sum_predicted_profit and its components. */
  score: ScoreModel;
  /** As-of date of the mart (YYYY-MM-DD): only users whose outcome horizon has elapsed count as matured. Omit to treat everyone as matured. */
  asOf?: string;
  /** Per-user winsorization cap of the matured value. */
  valueCapUsd?: number;
  /** A PRE-exposure covariate per user (CUPED); omit to leave the covariate columns NULL. */
  covariateOf?: (o: UserOutcome) => number;
}

/**
 * Aggregate exposures x outcomes to fct_experiment_profit_by_arm rows, exactly as the warehouse
 * mart would build them at `asOf`: the 24h score for every exposed user, matured outcomes only for
 * users whose fixed horizon has elapsed.
 */
export function martRowsFromCohort(outcomes: readonly UserOutcome[], exposures: readonly ExperimentExposure[], opts: MartRowOptions): ExperimentProfitByArmRow[] {
  const byUser = new Map(outcomes.map((o) => [o.user_id, o]));
  const cap = opts.valueCapUsd ?? DEFAULT_VALUE_CAP_USD;
  const rows = new Map<string, ExperimentProfitByArmRow>();
  for (const e of exposures) {
    const o = byUser.get(e.user_id);
    if (!o) continue;
    const date = e.first_exposed_at.slice(0, 10);
    const slice = opts.sliceOf(e.user_id);
    const key = [date, e.flag_key, e.arm, o.segment.country_bucket, o.segment.device, o.segment.acquisition_channel, slice].join('|');
    let row = rows.get(key);
    if (!row) {
      row = {
        exposure_date: date,
        flag_key: e.flag_key,
        arm: e.arm,
        country_bucket: o.segment.country_bucket,
        device: o.segment.device,
        acquisition_channel: o.segment.acquisition_channel,
        allocation_slice: slice,
        exposed_users: 0,
        scored_users: 0,
        converted_users: 0,
        sum_predicted_profit: 0,
        sum_sq_predicted_profit: 0,
        sum_predicted_revenue: 0,
        sum_predicted_generation_cost: 0,
        sum_predicted_fees: 0,
        sum_predicted_refund_risk: 0,
        model_version: opts.score.version,
        matured_users: 0,
        matured_converted_users: 0,
        sum_matured_value: 0,
        sum_sq_matured_value: 0,
        sum_matured_cost: 0,
        sum_sq_matured_cost: 0,
        matured_refunded_users: 0,
        activated_users: 0,
        generations_24h: 0,
        failed_generations_24h: 0,
        sum_covariate: opts.covariateOf ? 0 : null,
        sum_sq_covariate: opts.covariateOf ? 0 : null,
        sum_predicted_profit_x_covariate: opts.covariateOf ? 0 : null,
      };
      rows.set(key, row);
    }
    const p = opts.score.predict(o);
    row.exposed_users += 1;
    row.scored_users += 1;
    row.sum_predicted_profit += p.profit;
    row.sum_sq_predicted_profit += p.profit * p.profit;
    row.sum_predicted_revenue += p.revenue;
    row.sum_predicted_generation_cost += p.cost;
    row.sum_predicted_fees += p.fees;
    row.sum_predicted_refund_risk += p.refund;
    row.activated_users! += o.activated_24h ? 1 : 0;
    row.generations_24h! += o.generations_started_24h;
    row.failed_generations_24h! += o.failed_generations_24h;
    const matured = opts.asOf === undefined || daysBetween(date, opts.asOf) >= o.outcome_horizon_days;
    if (matured) {
      const value = Math.min(cap, o.value_h_usd);
      row.matured_users! += 1;
      row.matured_converted_users! += o.converted_h ? 1 : 0;
      row.converted_users += o.converted_h ? 1 : 0;
      row.sum_matured_value! += value;
      row.sum_sq_matured_value! += value * value;
      row.sum_matured_cost! += o.cost_h_usd;
      row.sum_sq_matured_cost! += o.cost_h_usd * o.cost_h_usd;
      row.matured_refunded_users! += o.refunded_h ? 1 : 0;
    }
    if (opts.covariateOf) {
      const x = opts.covariateOf(o);
      row.sum_covariate! += x;
      row.sum_sq_covariate! += x * x;
      row.sum_predicted_profit_x_covariate! += x * p.profit;
    }
  }
  return [...rows.values()].sort((a, b) => {
    const ka = [a.exposure_date, a.flag_key, a.arm, a.country_bucket, a.device, a.acquisition_channel, a.allocation_slice].join('|');
    const kb = [b.exposure_date, b.flag_key, b.arm, b.country_bucket, b.device, b.acquisition_channel, b.allocation_slice].join('|');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
