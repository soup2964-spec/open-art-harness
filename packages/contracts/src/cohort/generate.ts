/**
 * Deterministic synthetic cohort in OpenArt's SOURCE shapes: Stripe webhook events,
 * credit-ledger entries, Amplitude export rows ($exposure separately), plus app users
 * and a ground-truth file for tests. Same seed + params => byte-identical output.
 *
 * Behaviour comes from src/cohort/params.ts, which is ILLUSTRATIVE (assumptions, not
 * OpenArt data). Users are assigned default-model arms; the arm decides the model and
 * credits of every default generation, so credit burn and generation mix depend on it.
 *
 *   import { generateCohort } from '@openart-signal/contracts/cohort';
 *   const cohort = generateCohort({ users: 500 });
 */

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
  type InvoiceLineInput,
  type PriceInput,
  type StripeEvent,
  type SubscriptionItemInput,
} from '../builders/stripe.js';
import { DEFAULT_MODEL_FLAGS } from '../constants.js';
import { modelIdFromBusinessType } from '../model-catalog.js';
import { sha256Hex } from '../sha256.js';
import {
  ADD_ON_ELIGIBLE_TIERS,
  CREDIT_PACK,
  ONE_TIME_PACK,
  PLAN_MONTHLY_CREDITS,
  PLAN_PRICES,
  TIER_CODE,
  type PaidSelfServeTier,
} from '../stripe-catalog.js';
import { ARM_DEFAULT_GENERATION, COHORT_PARAMS, OTHER_MODELS, type CohortParams, type GenerationOption } from './params.js';
import { Prng } from './prng.js';

const DAY = 86_400_000;
const IMAGE_FLAG = DEFAULT_MODEL_FLAGS.createImage;
const VIDEO_FLAG = DEFAULT_MODEL_FLAGS.createVideo;
const UPGRADE_PATH: Partial<Record<PaidSelfServeTier, PaidSelfServeTier>> = {
  essential: 'advanced',
  advanced: 'infinite',
  infinite: 'wonder',
};

export interface AppUserRow {
  /** Subset of POST /suite/api/user/my-info field names (id, email, account_created_at, provider). */
  id: string;
  email: string;
  account_created_at: string;
  provider: 'google' | 'email';
}

export interface CohortTruthRow {
  user_id: string;
  signup_at: string;
  country: string;
  channel: string;
  arm_create_image: string;
  arm_create_video: string;
  activated: boolean;
  trial_exhausted: boolean;
  converted: boolean;
  plan_tier: PaidSelfServeTier | null;
  billing_interval: 'month' | 'year' | null;
  first_purchase_at: string | null;
  ended_at: string | null;
  end_reason: 'churn' | 'refund' | 'chargeback' | null;
  one_time_pack: boolean;
  net_cash_minor: number;
  credits_consumed: number;
  generations: number;
}

export interface CohortManifest {
  generator: string;
  illustrative: true;
  seed: string;
  users: number;
  params_sha256: string;
  counts: Record<string, number>;
}

export interface CohortOutput {
  manifest: CohortManifest;
  appUsers: AppUserRow[];
  stripeEvents: StripeEvent[];
  ledgerEntries: LedgerEntry[];
  amplitudeEvents: AmplitudeRow[];
  amplitudeExposures: AmplitudeRow[];
  truth: CohortTruthRow[];
}

export interface CohortOptions {
  seed?: string;
  users?: number;
  params?: CohortParams;
}

// ---------------------------------------------------------------------------

function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

const s = (ms: number) => Math.floor(ms / 1000);
const isoSec = (ms: number) => new Date(s(ms) * 1000).toISOString().replace('.000Z', 'Z');
const pad = (n: number, w: number) => String(n).padStart(w, '0');

function priceInput(tier: PaidSelfServeTier, interval: 'month' | 'year'): PriceInput {
  const p = PLAN_PRICES[tier][interval];
  return { priceId: p.priceId, productId: p.productId, unitAmountMinor: p.unitAmountMinor, interval };
}
const PACK: PriceInput = {
  priceId: CREDIT_PACK.priceId,
  productId: CREDIT_PACK.productId,
  unitAmountMinor: CREDIT_PACK.unitAmountMinor,
  interval: 'month',
};

interface Ctx {
  params: CohortParams;
  end: number;
  ledger: LedgerWriter;
  stripe: StripeEvent[];
  amp: AmplitudeRow[];
  exposures: AmplitudeRow[];
}

/** One simulated user. Keeps all per-user id counters so ids are deterministic. */
class UserSim {
  readonly uid: string;
  readonly email: string;
  readonly deviceId: string;
  readonly signupMs: number;
  readonly country: string;
  readonly channel: string;
  readonly imageArm: string;
  readonly videoArm: string;
  private readonly clickProps: Record<string, string>;
  private eventId = 0;
  private seq = 0;
  private genSeq = 0;
  readonly truth: CohortTruthRow;
  private subscribed = false;
  private tier: PaidSelfServeTier | null = null;
  /** Last ledger timestamp for this user: ledger rows are written strictly in time order. */
  private lastLedgerMs = 0;

  /** Monotonic ledger clock so balance chains read correctly when sorted by createdAt. */
  private ledgerAt(ms: number): number {
    const at = Math.max(ms, this.lastLedgerMs + 1000);
    this.lastLedgerMs = at;
    return at;
  }

  constructor(
    private readonly rng: Prng,
    private readonly ctx: Ctx,
    readonly index: number,
    signupStart: number,
  ) {
    const p = ctx.params;
    this.uid = `SynthC${pad(index, 5)}${rng.base62(9)}`;
    this.email = `cohort.u${pad(index, 5)}@example.test`;
    this.deviceId = rng.uuidv4();
    this.signupMs = s(signupStart + rng.next() * p.signupWindowDays * DAY) * 1000;
    this.country = rng.weighted(p.country);
    this.channel = rng.weighted(p.channelWeights);
    this.imageArm = rng.weighted(p.armWeights[IMAGE_FLAG]);
    this.videoArm = rng.weighted(p.armWeights[VIDEO_FLAG]);
    this.clickProps = this.buildClickProps();
    this.truth = {
      user_id: this.uid,
      signup_at: isoSec(this.signupMs),
      country: this.country,
      channel: this.channel,
      arm_create_image: this.imageArm,
      arm_create_video: this.videoArm,
      activated: false,
      trial_exhausted: false,
      converted: false,
      plan_tier: null,
      billing_interval: null,
      first_purchase_at: null,
      ended_at: null,
      end_reason: null,
      one_time_pack: false,
      net_cash_minor: 0,
      credits_consumed: 0,
      generations: 0,
    };
  }

  private buildClickProps(): Record<string, string> {
    const r = this.rng;
    switch (this.channel) {
      case 'google_cpc': {
        const gclid = `Cj0KCQjw${r.base62(24)}`;
        return { initial_utm_source: 'google', initial_utm_medium: 'cpc', initial_utm_campaign: 'synth_search', initial_gclid: gclid, gclid };
      }
      case 'meta_paid_social': {
        const fbclid = `IwAR${r.base62(28)}`;
        return { initial_utm_source: 'facebook', initial_utm_medium: 'paid_social', initial_utm_campaign: 'synth_prospecting', initial_fbclid: fbclid, fbclid };
      }
      case 'tiktok_paid_social': {
        const ttclid = `E.C.P.${r.base62(30)}`;
        return { initial_utm_source: 'tiktok', initial_utm_medium: 'paid_social', initial_utm_campaign: 'synth_spark', initial_ttclid: ttclid, ttclid };
      }
      case 'affiliate':
        return { initial_utm_source: 'tolt', initial_utm_medium: 'affiliate', initial_utm_campaign: 'affiliate-tolt--acq-web' };
      default:
        return {};
    }
  }

  private nextId(prefix: string, randomLength = 8): string {
    this.seq += 1;
    return `${prefix}${pad(this.index, 5)}${pad(this.seq, 3)}${this.rng.base62(randomLength)}`;
  }

  private userProps(): Record<string, unknown> {
    return {
      signed_in: true,
      subscription_active: this.subscribed,
      ...(this.subscribed && this.tier ? { subscription_tier: this.tier } : {}),
      subscription_source: 'v2',
      creation_panel_version: 'v2',
      signup_date: isoSec(this.signupMs).slice(0, 10),
      signup_at: isoSec(this.signupMs),
      [`ab_${IMAGE_FLAG}`]: this.imageArm,
      [`ab_${VIDEO_FLAG}`]: this.videoArm,
      ...this.clickProps,
    };
  }

  private amplitude(eventType: string, atMs: number, props: Record<string, unknown>, target: AmplitudeRow[] = this.ctx.amp): void {
    this.eventId += 1;
    target.push(
      amplitudeRow(this.rng, {
        eventType,
        atMs,
        userId: this.uid,
        deviceId: this.deviceId,
        sessionId: Math.floor(atMs / (30 * 60_000)) * 30 * 60_000,
        eventId: this.eventId,
        eventProperties: props,
        userProperties: this.userProps(),
        country: this.country,
      }),
    );
  }

  private pickGeneration(videoShare: number): GenerationOption & { quantity: number } {
    const r = this.rng;
    const video = r.bool(videoShare);
    let option: GenerationOption;
    if (r.bool(this.ctx.params.defaultModelStickiness)) {
      option = ARM_DEFAULT_GENERATION[video ? this.videoArm : this.imageArm]!;
    } else {
      const pool = video ? OTHER_MODELS.video : OTHER_MODELS.image;
      const weights = Object.fromEntries(pool.map((o, i) => [String(i), o.weight])) as Record<string, number>;
      option = pool[Number(r.weighted(weights))]!;
    }
    const quantity = option.mode === 'image' ? r.pick(this.ctx.params.imageBatchSizes) : 1;
    return { ...option, quantity };
  }

  /** Try one generation from a bucket; returns false when the bucket cannot pay for it. */
  private generate(
    atMs: number,
    field: 'trial_credit_balance' | 'subscription_monthly_credit' | 'one_time_pack_credit',
    videoShare: number,
  ): boolean {
    let g = this.pickGeneration(videoShare);
    const balance = this.ctx.ledger.balance(this.uid, field);
    // ILLUSTRATIVE: a user who cannot afford a video (every video arm costs more than the
    // 40 trial credits) falls back to an image once before giving up.
    if (balance < g.credits * g.quantity && g.mode === 'video') g = this.pickGeneration(0);
    const total = g.credits * g.quantity;
    if (balance < total) return false;
    atMs = this.ledgerAt(atMs);
    this.genSeq += 1;
    const historyId = `SynthH${pad(this.index, 5)}${pad(this.genSeq, 5)}${this.rng.base62(4)}`;
    const entry = this.ctx.ledger.consume({
      userId: this.uid,
      field,
      businessType: g.businessType,
      historyId,
      projectId: `SynthP${pad(this.index, 5)}main`,
      unitCredits: g.credits,
      quantity: g.quantity,
      atMs,
    });
    if (this.rng.bool(this.ctx.params.failedGenerationRate)) {
      this.ctx.ledger.refundGeneration({
        userId: this.uid,
        field,
        businessType: g.businessType,
        historyId: entry.reference.businessId,
        credits: total,
        atMs: this.ledgerAt(atMs + this.rng.int(30, 180) * 1000),
      });
      return true;
    }
    this.truth.generations += 1;
    this.truth.credits_consumed += total;
    if (!this.truth.activated) this.truth.activated = true;
    this.amplitude(
      'asset_created',
      atMs,
      assetCreatedProperties({
        model: modelIdFromBusinessType(g.businessType),
        creationMode: g.mode,
        featureName: g.mode === 'image' ? 'text_to_image' : 'text_to_video',
        assetNum: g.quantity,
        creditsNum: total,
      }),
    );
    return true;
  }

  run(): void {
    const p = this.ctx.params;
    const r = this.rng;
    const t0 = this.signupMs;
    // Flags are bootstrapped on the first page view; exposures follow.
    this.amplitude('experiment_flags_ready', t0 + 2000, { [`ab_${IMAGE_FLAG}`]: this.imageArm, [`ab_${VIDEO_FLAG}`]: this.videoArm });
    this.amplitude('$exposure', t0 + 3000, { flag_key: IMAGE_FLAG, variant: this.imageArm }, this.ctx.exposures);
    this.amplitude('$exposure', t0 + 3000, { flag_key: VIDEO_FLAG, variant: this.videoArm }, this.ctx.exposures);
    this.ctx.ledger.signupTrial(this.uid, this.ledgerAt(t0), p.trialCredits);

    // Free phase: generate from trial credits until they run out or expire.
    const trialEnd = t0 + p.trialDays * DAY;
    if (r.bool(p.activationProbability)) {
      let at = t0 + 30_000 + Math.floor(-Math.log(1 - r.next()) * p.activationMeanDelayHours * 3_600_000);
      const attempts = 1 + r.poisson(p.freeGenerationsMean - 1);
      for (let k = 0; k < attempts && at < trialEnd && at < this.ctx.end; k += 1) {
        if (!this.generate(at, 'trial_credit_balance', p.videoShareFree)) {
          this.truth.trial_exhausted = true;
          break;
        }
        at += r.int(2, 180) * 60_000;
      }
    }

    // Conversion (ILLUSTRATIVE): arm quality x trial exhaustion.
    const pConvert =
      p.conversionBase *
      (p.armConversionMultiplier[this.imageArm] ?? 1) *
      (p.armConversionMultiplier[this.videoArm] ?? 1) *
      (this.truth.trial_exhausted ? p.exhaustedTrialMultiplier : 1);
    const purchaseMs = s(t0 + (0.5 + r.next() * 13.5) * DAY) * 1000;
    if (this.truth.activated && r.bool(pConvert) && purchaseMs < this.ctx.end) {
      const tier = r.weighted(p.planMix);
      const interval = r.bool(p.annualShare[tier]) ? 'year' : 'month';
      this.subscribe(tier, interval, purchaseMs);
    } else if (this.truth.activated && r.bool(p.oneTimePackProbabilityFree)) {
      // OBSERVED constant: the one-time pack is offered 3 days after signup.
      const at = s(t0 + (3 + r.next() * 7) * DAY) * 1000;
      if (at < this.ctx.end) this.buyOneTimePack(at);
    }
  }

  private buyOneTimePack(atMs: number): void {
    const cs = this.nextId('cs_live_a1SynthC', 10);
    const pi = this.nextId('pi_3SynthC');
    this.ctx.stripe.push(
      stripeEvent(
        this.nextId('evt_1SynthC'),
        'checkout.session.completed',
        s(atMs),
        checkoutSessionObject({
          id: cs,
          customer: this.uid,
          mode: 'payment',
          subscription: null,
          invoice: null,
          paymentIntent: pi,
          amountTotalMinor: ONE_TIME_PACK.unitAmountMinor,
          created: s(atMs) - 1,
          successQuery: `offer=one_time_pack_800&uid=${this.uid}`,
          customerEmail: this.email,
        }),
      ),
    );
    this.truth.one_time_pack = true;
    this.truth.net_cash_minor += ONE_TIME_PACK.unitAmountMinor;
    this.ctx.ledger.oneTimePack(this.uid, cs, ONE_TIME_PACK.credits, this.ledgerAt(atMs + 4000));
    let at = atMs + 10 * 60_000;
    for (let k = 0; k < 6 && at < this.ctx.end; k += 1) {
      if (!this.generate(at, 'one_time_pack_credit', this.ctx.params.videoShareFree)) break;
      at += this.rng.int(5, 600) * 60_000;
    }
  }

  private paidInvoice(args: {
    at: number;
    reason: 'subscription_create' | 'subscription_cycle' | 'subscription_update';
    sub: string;
    periodStart: number;
    periodEnd: number;
    lines: Array<Omit<InvoiceLineInput, 'id' | 'periodStart' | 'periodEnd'>>;
  }): { invoice: string; pi: string; charge: string; total: number } {
    const invoice = this.nextId('in_1SynthC');
    const pi = this.nextId('pi_3SynthC');
    const charge = this.nextId('ch_3SynthC');
    const inv = invoiceObject({
      id: invoice,
      customer: this.uid,
      subscription: args.sub,
      billingReason: args.reason,
      created: s(args.at),
      periodStart: s(args.periodStart),
      periodEnd: s(args.periodEnd),
      number: `SYNTHC${pad(this.index, 5)}-${pad(this.seq, 4)}`,
      lines: args.lines.map((l) => ({ ...l, id: this.nextId('il_1SynthC'), periodStart: s(args.periodStart), periodEnd: s(args.periodEnd) })),
    });
    const total = args.lines.reduce((sum, l) => sum + l.amountMinor, 0);
    this.ctx.stripe.push(
      stripeEvent(this.nextId('evt_1SynthC'), 'invoice.paid', s(args.at) + 2, inv),
      stripeEvent(
        this.nextId('evt_1SynthC'),
        'invoice_payment.paid',
        s(args.at) + 2,
        invoicePaymentObject({ id: this.nextId('inpay_1SynthC'), invoice, paymentIntent: pi, amountMinor: total, created: s(args.at) }),
      ),
    );
    this.truth.net_cash_minor += total;
    return { invoice, pi, charge, total };
  }

  private subscriptionEvent(
    type: 'customer.subscription.updated' | 'customer.subscription.deleted',
    at: number,
    sub: { id: string; created: number; items: SubscriptionItemInput[]; latestInvoice: string },
    state: { status: 'active' | 'canceled'; cancelAtPeriodEnd: boolean; cancelAt: number | null; canceledAt: number | null; endedAt: number | null },
    previous?: Record<string, unknown>,
  ): void {
    this.ctx.stripe.push(
      stripeEvent(
        this.nextId('evt_1SynthC'),
        type,
        s(at),
        subscriptionObject({ id: sub.id, customer: this.uid, created: s(sub.created), items: sub.items, latestInvoice: sub.latestInvoice, ...state }),
        previous,
      ),
    );
  }

  private subscribe(startTier: PaidSelfServeTier, interval: 'month' | 'year', purchaseMs: number): void {
    const p = this.ctx.params;
    const r = this.rng;
    this.amplitude('subscription_started', purchaseMs - 90_000, {
      device: 'pc',
      creation_panel_version: 'v2',
      subscription_tier: startTier,
      subscription_interval: interval,
      click_source: 'plan_card',
    });
    const subId = this.nextId('sub_1SynthC');
    const planItemId = this.nextId('si_SynthC');
    const packItemId = this.nextId('si_SynthC');
    const cs = this.nextId('cs_live_a1SynthC', 10);
    let tier = startTier;
    let packs = 0;
    const items = (periodStart: number, periodEnd: number): SubscriptionItemInput[] => [
      { id: planItemId, price: priceInput(tier, interval), quantity: 1, periodStart: s(periodStart), periodEnd: s(periodEnd) },
      ...(packs > 0 ? [{ id: packItemId, price: PACK, quantity: packs, periodStart: s(periodStart), periodEnd: s(periodEnd) }] : []),
    ];

    const firstPeriodEnd = addMonthsUtc(purchaseMs, interval === 'year' ? 12 : 1);
    const first = this.paidInvoice({
      at: purchaseMs,
      reason: 'subscription_create',
      sub: subId,
      periodStart: purchaseMs,
      periodEnd: firstPeriodEnd,
      lines: [{ amountMinor: PLAN_PRICES[tier][interval].unitAmountMinor, price: priceInput(tier, interval), quantity: 1, proration: false, subscriptionItem: planItemId, description: `1 × OpenArt ${tier}` }],
    });
    this.ctx.stripe.push(
      stripeEvent(
        this.nextId('evt_1SynthC'),
        'checkout.session.completed',
        s(purchaseMs) + 1,
        checkoutSessionObject({
          id: cs,
          customer: this.uid,
          mode: 'subscription',
          subscription: subId,
          invoice: first.invoice,
          paymentIntent: null,
          amountTotalMinor: first.total,
          created: s(purchaseMs) - 60,
          successQuery: `success=subscription_purchased&tier=${TIER_CODE[tier]}&interval=${interval}&uid=${this.uid}&quantity=undefined`,
          customerEmail: this.email,
        }),
      ),
    );
    this.subscribed = true;
    this.tier = tier;
    Object.assign(this.truth, { converted: true, plan_tier: tier, billing_interval: interval, first_purchase_at: isoSec(purchaseMs) });
    for (const channel of ['google_ads', 'bing_uet', 'openai_ads', 'meta_pixel']) {
      this.amplitude('conversion_reported', purchaseMs + 5000, {
        report_layer: 'client',
        channel,
        conversion_type: 'purchase',
        environment: 'production',
        fired: true,
        outcome: 'fired',
        ...(this.clickProps.gclid ? { gclid: this.clickProps.gclid } : {}),
        ...(this.clickProps.fbclid ? { fbclid: this.clickProps.fbclid } : {}),
        ...(this.clickProps.ttclid ? { ttclid: this.clickProps.ttclid } : {}),
      });
    }

    const sub = { id: subId, created: purchaseMs, items: items(purchaseMs, firstPeriodEnd), latestInvoice: first.invoice };
    let planRemaining = 0;
    const refill = (invoiceOrRef: string, at: number) => {
      const allowance = PLAN_MONTHLY_CREDITS[tier];
      const amount = allowance - planRemaining;
      if (amount > 0) this.ctx.ledger.refill(this.uid, invoiceOrRef, amount, this.ledgerAt(at));
      planRemaining = allowance;
    };
    const consumeTracked = (at: number): boolean => {
      const before = this.ctx.ledger.balance(this.uid, 'subscription_monthly_credit');
      const ok = this.generate(at, 'subscription_monthly_credit', p.videoSharePaid);
      const spent = before - this.ctx.ledger.balance(this.uid, 'subscription_monthly_credit');
      // Add-on credits are consumed first; plan credits only once add-on credits are gone.
      const addOnBalance = before - planRemaining;
      planRemaining -= Math.max(0, spent - Math.max(0, addOnBalance));
      return ok;
    };

    refill(first.invoice, purchaseMs + 4000);
    let lastInvoice = first;
    let newInvoice = true;
    let month = 0;
    let monthStart = purchaseMs;
    for (;;) {
      const monthEnd = addMonthsUtc(purchaseMs, month + 1);
      // Money-out on the invoice just paid (ILLUSTRATIVE rates). Ends the subscription.
      if (newInvoice && r.bool(p.refundProbabilityPerInvoice)) {
        const at = monthStart + r.int(1, 10) * DAY;
        if (at < this.ctx.end) {
          const amount = lastInvoice.total;
          this.ctx.stripe.push(
            stripeEvent(this.nextId('evt_1SynthC'), 'charge.refunded', s(at), chargeObject({ id: lastInvoice.charge, customer: this.uid, paymentIntent: lastInvoice.pi, amountMinor: amount, amountRefundedMinor: amount, created: s(monthStart), disputed: false }), { amount_refunded: 0, refunded: false }),
          );
          this.truth.net_cash_minor -= amount;
          this.endSubscription(sub, at, 'refund');
          return;
        }
      }
      if (newInvoice && r.bool(p.chargebackProbabilityPerInvoice)) {
        const at = monthStart + r.int(10, 45) * DAY;
        if (at < this.ctx.end) {
          this.ctx.stripe.push(
            stripeEvent(this.nextId('evt_1SynthC'), 'charge.dispute.created', s(at), disputeObject({ id: this.nextId('dp_1SynthC'), charge: lastInvoice.charge, paymentIntent: lastInvoice.pi, amountMinor: lastInvoice.total, created: s(at), reason: 'fraudulent' })),
          );
          this.truth.net_cash_minor -= lastInvoice.total;
          this.endSubscription(sub, at, 'chargeback');
          return;
        }
      }

      // Usage, plus at most one add-on or upgrade, in time order within the month.
      const monthLength = Math.min(monthEnd, this.ctx.end) - monthStart;
      const target = PLAN_MONTHLY_CREDITS[tier] * r.beta(p.utilizationBeta.a, p.utilizationBeta.b);
      const changeAt = monthStart + Math.floor((0.2 + 0.6 * r.next()) * (monthEnd - monthStart));
      const wantsAddOn = ADD_ON_ELIGIBLE_TIERS.includes(tier) && packs < 2 && r.bool(p.addOnProbabilityPerMonth);
      const upgradeTo = interval === 'month' ? UPGRADE_PATH[tier] : undefined;
      const wantsUpgrade = !wantsAddOn && upgradeTo !== undefined && r.bool(p.upgradeProbabilityPerMonth);
      let changeDone = !(wantsAddOn || wantsUpgrade) || changeAt >= Math.min(monthEnd, this.ctx.end);
      const applyChange = () => {
        changeDone = true;
        if (wantsAddOn) {
          this.buyAddOn(sub, changeAt, monthEnd, () => {
            packs += 1;
            sub.items = items(monthStart, monthEnd);
          });
        } else if (upgradeTo) {
          const from = tier;
          this.upgrade(sub, from, upgradeTo, changeAt, monthStart, monthEnd, () => {
            tier = upgradeTo;
            this.tier = tier;
            this.truth.plan_tier = tier;
            sub.items = items(monthStart, monthEnd);
          });
          const extra = PLAN_MONTHLY_CREDITS[upgradeTo] - PLAN_MONTHLY_CREDITS[from];
          // INFERRED: an upgrade grants the allowance difference immediately.
          this.ctx.ledger.refill(this.uid, sub.latestInvoice, extra, this.ledgerAt(changeAt + 4000));
          planRemaining += extra;
        }
      };
      let used = 0;
      let generating = true;
      const times: number[] = [];
      // Usage starts after the period's refill has landed.
      for (let k = 0; k < p.maxGenerationsPerMonth && monthLength > 10_000; k += 1) {
        times.push(monthStart + 10_000 + Math.floor(r.next() * (monthLength - 10_000)));
      }
      times.sort((a, b) => a - b);
      for (const at of times) {
        if (!changeDone && at >= changeAt) applyChange();
        if (!generating) continue;
        if (used >= target) {
          generating = false;
          continue;
        }
        const before = this.truth.credits_consumed;
        if (!consumeTracked(at)) {
          generating = false;
          continue;
        }
        used += this.truth.credits_consumed - before;
      }
      if (!changeDone) applyChange();

      // Month boundary: renewal (monthly), refill (annual), or churn.
      if (monthEnd >= this.ctx.end) return;
      month += 1;
      monthStart = monthEnd;
      const nextEnd = addMonthsUtc(purchaseMs, month + 1);
      if (interval === 'month') {
        if (r.bool(p.monthlyChurn[tier])) {
          this.cancelAtPeriodEnd(sub, monthEnd - r.int(1, 10) * DAY, monthEnd);
          return;
        }
        lastInvoice = this.paidInvoice({
          at: monthStart,
          reason: 'subscription_cycle',
          sub: subId,
          periodStart: monthStart,
          periodEnd: nextEnd,
          lines: [
            { amountMinor: PLAN_PRICES[tier].month.unitAmountMinor, price: priceInput(tier, 'month'), quantity: 1, proration: false, subscriptionItem: planItemId, description: `1 × OpenArt ${tier}` },
            ...(packs > 0 ? [{ amountMinor: CREDIT_PACK.unitAmountMinor * packs, price: PACK, quantity: packs, proration: false, subscriptionItem: packItemId, description: `${packs} × Extra Credit` }] : []),
          ],
        });
        sub.latestInvoice = lastInvoice.invoice;
        sub.items = items(monthStart, nextEnd);
        refill(lastInvoice.invoice, monthStart + 4000);
        newInvoice = true;
      } else {
        newInvoice = false;
        // Annual plans refill monthly on the anniversary without an invoice (reference is INFERRED).
        refill(`${first.invoice}:m${month}`, monthStart + 4000);
      }
    }
  }

  private buyAddOn(
    sub: { id: string; created: number; items: SubscriptionItemInput[]; latestInvoice: string },
    at: number,
    periodEnd: number,
    apply: () => void,
  ): void {
    const previousItems = sub.items;
    apply();
    const remaining = (periodEnd - at) / (periodEnd - (sub.items[0]!.periodStart * 1000));
    const packItem = sub.items[1]!;
    this.subscriptionEvent('customer.subscription.updated', at, sub, { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, endedAt: null }, {
      items: { object: 'list', has_more: false, url: `/v1/subscription_items?subscription=${sub.id}`, data: previousItems.map((i) => ({ id: i.id, object: 'subscription_item', quantity: i.quantity })) },
    });
    const inv = this.paidInvoice({
      at,
      reason: 'subscription_update',
      sub: sub.id,
      periodStart: at,
      periodEnd,
      lines: [{ amountMinor: Math.round(CREDIT_PACK.unitAmountMinor * remaining), price: PACK, quantity: 1, proration: true, subscriptionItem: packItem.id, description: 'Remaining time on 1 × Extra Credit' }],
    });
    sub.latestInvoice = inv.invoice;
    this.ctx.ledger.creditPack(this.uid, inv.invoice, CREDIT_PACK.creditsPerPack, this.ledgerAt(at + 4000));
  }

  private upgrade(
    sub: { id: string; created: number; items: SubscriptionItemInput[]; latestInvoice: string },
    from: PaidSelfServeTier,
    to: PaidSelfServeTier,
    at: number,
    periodStart: number,
    periodEnd: number,
    apply: () => void,
  ): void {
    const previousItems = sub.items;
    apply();
    const remaining = (periodEnd - at) / (periodEnd - periodStart);
    this.subscriptionEvent('customer.subscription.updated', at, sub, { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, endedAt: null }, {
      items: { object: 'list', has_more: false, url: `/v1/subscription_items?subscription=${sub.id}`, data: previousItems.map((i) => ({ id: i.id, object: 'subscription_item', quantity: i.quantity })) },
    });
    const planItem = sub.items[0]!.id;
    const inv = this.paidInvoice({
      at,
      reason: 'subscription_update',
      sub: sub.id,
      periodStart: at,
      periodEnd,
      lines: [
        { amountMinor: -Math.round(PLAN_PRICES[from].month.unitAmountMinor * remaining), price: priceInput(from, 'month'), quantity: 1, proration: true, subscriptionItem: planItem, description: `Unused time on OpenArt ${from}` },
        { amountMinor: Math.round(PLAN_PRICES[to].month.unitAmountMinor * remaining), price: priceInput(to, 'month'), quantity: 1, proration: true, subscriptionItem: planItem, description: `Remaining time on OpenArt ${to}` },
      ],
    });
    sub.latestInvoice = inv.invoice;
  }

  private cancelAtPeriodEnd(sub: { id: string; created: number; items: SubscriptionItemInput[]; latestInvoice: string }, requestedAt: number, periodEnd: number): void {
    const at = Math.min(requestedAt, periodEnd - 1000);
    this.subscriptionEvent('customer.subscription.updated', at, sub, { status: 'active', cancelAtPeriodEnd: true, cancelAt: s(periodEnd), canceledAt: s(at), endedAt: null }, { cancel_at_period_end: false, cancel_at: null, canceled_at: null });
    if (periodEnd < this.ctx.end) {
      this.subscriptionEvent('customer.subscription.deleted', periodEnd, sub, { status: 'canceled', cancelAtPeriodEnd: true, cancelAt: s(periodEnd), canceledAt: s(at), endedAt: s(periodEnd) });
      this.subscribed = false;
      this.truth.ended_at = isoSec(periodEnd);
      this.truth.end_reason = 'churn';
    }
  }

  private endSubscription(
    sub: { id: string; created: number; items: SubscriptionItemInput[]; latestInvoice: string },
    at: number,
    reason: 'refund' | 'chargeback',
  ): void {
    this.subscriptionEvent('customer.subscription.deleted', at + 60_000, sub, { status: 'canceled', cancelAtPeriodEnd: false, cancelAt: null, canceledAt: s(at + 60_000), endedAt: s(at + 60_000) });
    this.subscribed = false;
    this.truth.ended_at = isoSec(at + 60_000);
    this.truth.end_reason = reason;
  }
}

// ---------------------------------------------------------------------------

function stableCompare<T>(key: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** Generate the cohort in memory. Pure and deterministic for a given seed/users/params. */
export function generateCohort(options: CohortOptions = {}): CohortOutput {
  const params = options.params ?? COHORT_PARAMS;
  const seed = options.seed ?? params.seed;
  const users = options.users ?? params.users;
  const root = new Prng(seed);
  const ctx: Ctx = {
    params,
    end: Date.parse(params.simulationEnd),
    ledger: new LedgerWriter(root.fork('ledger')),
    stripe: [],
    amp: [],
    exposures: [],
  };
  const signupStart = Date.parse(params.signupStart);
  const appUsers: AppUserRow[] = [];
  const truth: CohortTruthRow[] = [];
  for (let i = 1; i <= users; i += 1) {
    const sim = new UserSim(root.fork(`user-${i}`), ctx, i, signupStart);
    sim.run();
    appUsers.push({ id: sim.uid, email: sim.email, account_created_at: isoSec(sim.signupMs), provider: i % 3 === 0 ? 'email' : 'google' });
    truth.push(sim.truth);
  }

  const stripeEvents = [...ctx.stripe].sort(stableCompare((e) => `${pad(e.created, 11)}|${e.id}`));
  const ledgerEntries = [...ctx.ledger.entries].sort(stableCompare((e) => `${e.createdAt}|${e.userId}|${e.id}`));
  const amplitudeEvents = [...ctx.amp].sort(stableCompare((e) => `${e.event_time}|${e.uuid}`));
  const amplitudeExposures = [...ctx.exposures].sort(stableCompare((e) => `${e.event_time}|${e.uuid}`));
  appUsers.sort(stableCompare((u) => `${u.account_created_at}|${u.id}`));

  const manifest: CohortManifest = {
    generator: '@openart-signal/contracts src/cohort/generate.ts',
    illustrative: true,
    seed,
    users,
    params_sha256: sha256Hex(JSON.stringify(params)),
    counts: {
      'app_users.jsonl': appUsers.length,
      'stripe_events.jsonl': stripeEvents.length,
      'credit_ledger.jsonl': ledgerEntries.length,
      'amplitude_events.jsonl': amplitudeEvents.length,
      'amplitude_exposures.jsonl': amplitudeExposures.length,
      'cohort_truth.jsonl': truth.length,
    },
  };
  return { manifest, appUsers, stripeEvents, ledgerEntries, amplitudeEvents, amplitudeExposures, truth };
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** File name -> content, as written to fixtures/cohort/. */
export function cohortFiles(out: CohortOutput): Record<string, string> {
  return {
    'manifest.json': `${JSON.stringify(out.manifest, null, 2)}\n`,
    'app_users.jsonl': jsonl(out.appUsers),
    'stripe_events.jsonl': jsonl(out.stripeEvents),
    'credit_ledger.jsonl': jsonl(out.ledgerEntries),
    'amplitude_events.jsonl': jsonl(out.amplitudeEvents),
    'amplitude_exposures.jsonl': jsonl(out.amplitudeExposures),
    'cohort_truth.jsonl': jsonl(out.truth),
  };
}
