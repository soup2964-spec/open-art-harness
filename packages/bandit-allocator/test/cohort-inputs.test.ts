import { ExperimentExposureSchema, PredictedProfitSchema } from '@openart-signal/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  exposuresFromCohort,
  fitScoreModel,
  loadFixtureCohort,
  loadModelCosts,
  martRowsFromCohort,
  outcomesFromCohort,
  predictedProfitRows,
  PROFIT_ASSUMPTIONS,
  segmentsFromAmplitude,
  type UserOutcome,
} from '../src/cohort-inputs.js';
import { countryBucket } from '../src/segments.js';
import { parseExperimentProfitRows } from '../src/warehouse.js';

const IMG = 'suite-default-model-create-image';
const VID = 'suite-default-model-create-video';

let cohort: ReturnType<typeof loadFixtureCohort>;
let outcomes: UserOutcome[];

beforeAll(() => {
  cohort = loadFixtureCohort();
  // A long horizon so realized cash reconciles exactly with the generator's ground truth.
  outcomes = outcomesFromCohort(cohort, { ...PROFIT_ASSUMPTIONS, horizonDays: 400 });
});

describe('model cost lookup (contracts fixtures/seeds/model_costs.csv)', () => {
  it('prices every default arm at its observed default setting', () => {
    const cost = loadModelCosts();
    expect(cost('nano-banana-pro:text2image', 40)).toBeCloseTo(0.134, 9);
    expect(cost('gpt-image-2-5-flare:text2image', 5)).toBeCloseTo(0.00588, 9);
    expect(cost('nano-banana-2:text2image', 20)).toBeCloseTo(0.067, 9);
    expect(cost('byte-plus-seedance-2-5:text2video', 650)).toBeCloseTo(1.156, 9);
    expect(() => cost('no-such-model:text2image', 5)).toThrow(/no model_costs row/);
  });
});

describe('outcomes from the 2,000-user fixture cohort', () => {
  it('covers every user once', () => {
    expect(outcomes.length).toBe(2000);
    expect(new Set(outcomes.map((o) => o.user_id)).size).toBe(2000);
  });

  it('reconciles realized cash with the generator ground truth (net_cash_minor)', () => {
    const truth = new Map(cohort.truth.map((t) => [t.user_id, t]));
    for (const o of outcomes) {
      const t = truth.get(o.user_id)!;
      expect(Math.round((o.revenue_usd - o.refund_loss_usd) * 100), o.user_id).toBe(t.net_cash_minor);
      expect(o.converted).toBe(t.converted);
      expect(o.arms[IMG]).toBe(t.arm_create_image);
      expect(o.arms[VID]).toBe(t.arm_create_video);
    }
  });

  it('prices generations from the ledger: successful CONSUME rows x list cost, refunded ones excluded', () => {
    const truth = new Map(cohort.truth.map((t) => [t.user_id, t]));
    for (const o of outcomes) expect(o.credits_consumed, o.user_id).toBe(truth.get(o.user_id)!.credits_consumed);
    // A user whose only generation was one default Nano Banana Pro image costs exactly $0.134.
    const nbProSingle = outcomes.find((o) => o.generations === 1 && o.credits_consumed === 40 && o.arms[IMG] === 'nano-banana-pro');
    if (nbProSingle) expect(nbProSingle.generation_cost_usd).toBeCloseTo(0.134, 9);
    expect(outcomes.every((o) => o.generation_cost_usd >= 0)).toBe(true);
  });

  it('applies the ILLUSTRATIVE fee assumptions (Stripe % + fixed per charge, Tolt 20% for affiliates)', () => {
    const payer = outcomes.find((o) => o.revenue_usd > 0 && o.segment.acquisition_channel !== 'affiliate' && o.refund_loss_usd === 0)!;
    expect(payer.fees_usd).toBeCloseTo(payer.revenue_usd * PROFIT_ASSUMPTIONS.stripePercentFee + payer.charges * PROFIT_ASSUMPTIONS.stripeFixedFeeUsd, 6);
    const affiliate = outcomes.find((o) => o.revenue_usd > 0 && o.segment.acquisition_channel === 'affiliate' && o.refund_loss_usd === 0);
    if (affiliate) {
      expect(affiliate.fees_usd).toBeCloseTo(
        affiliate.revenue_usd * (PROFIT_ASSUMPTIONS.stripePercentFee + PROFIT_ASSUMPTIONS.affiliateCommission) + affiliate.charges * PROFIT_ASSUMPTIONS.stripeFixedFeeUsd,
        6,
      );
    }
  });

  it('derives segments from Amplitude rows exactly as the warehouse would, matching ground truth', () => {
    const segs = segmentsFromAmplitude(cohort.amplitudeEvents);
    for (const t of cohort.truth) {
      const s = segs.get(t.user_id)!;
      expect(s.acquisition_channel).toBe(t.channel);
      expect(s.country_bucket).toBe(countryBucket(t.country));
      expect(s.device).toBe('desktop'); // the generator writes device_type "Mac" for every row
    }
  });
});

describe('contract rows', () => {
  it('emits PredictedProfit rows (the 24h score) that validate against the contracts schema and identity', () => {
    const rows = predictedProfitRows(outcomes, fitScoreModel(outcomes, { version: 'test-24h' }));
    expect(rows.length).toBe(2000);
    for (const r of rows) {
      const parsed = PredictedProfitSchema.safeParse(r);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    }
    expect(rows[0]!.model_version).toBe('test-24h');
  });

  it('emits one ExperimentExposure per user and flag, validated by the contracts schema', () => {
    const exposures = exposuresFromCohort(cohort);
    expect(exposures.length).toBe(4000);
    for (const e of exposures) expect(ExperimentExposureSchema.safeParse(e).success).toBe(true);
  });

  it('aggregates into valid fct_experiment_profit_by_arm rows that preserve totals', () => {
    const exposures = exposuresFromCohort(cohort);
    const score = fitScoreModel(outcomes, { version: 'test' });
    const rows = parseExperimentProfitRows(martRowsFromCohort(outcomes, exposures, { sliceOf: (uid) => (/[0-5]$/.test(uid) ? 'holdout' : 'bandit'), score }));
    for (const flag of [IMG, VID]) {
      const mine = rows.filter((r) => r.flag_key === flag);
      expect(mine.reduce((s, r) => s + r.exposed_users, 0)).toBe(2000);
      const total = outcomes.reduce((s, o) => s + score.predict(o).profit, 0);
      expect(mine.reduce((s, r) => s + r.sum_predicted_profit, 0)).toBeCloseTo(total, 4);
      const holdout = mine.filter((r) => r.allocation_slice === 'holdout').reduce((s, r) => s + r.exposed_users, 0);
      // 6 of 62 base62 characters: ~9.7% of users.
      expect(holdout / 2000).toBeGreaterThan(0.07);
      expect(holdout / 2000).toBeLessThan(0.125);
    }
  });
});

describe('finding 5: rows carry what the warehouse would know, when it would know it', () => {
  const exposures = () => exposuresFromCohort(cohort);
  const score = () => fitScoreModel(outcomes, { version: 'test' });

  it('the reward column is a 24h SIGNALS-ONLY score, never the realized 90-day profit', () => {
    const s = score();
    // Users with identical 24h behaviour get the identical score whatever they did later...
    const later = outcomes.filter((o) => !o.paid_within_24h && o.activated_24h && o.credits_consumed_24h < 40 && o.segment.acquisition_channel !== 'affiliate');
    const scores = new Set(later.map((o) => s.predict(o).profit));
    expect(scores.size).toBe(1);
    expect(new Set(later.map((o) => o.profit_usd)).size).toBeGreaterThan(10);
    // ...and whatever their default-model arm: the score has no arm feature.
    const arms = new Set(later.map((o) => o.arms[IMG]));
    expect(arms.size).toBeGreaterThan(1);
  });

  it('matured outcomes appear only once the fixed horizon has elapsed at the as-of date', () => {
    const asOf = '2026-07-15';
    const rows = parseExperimentProfitRows(martRowsFromCohort(outcomes, exposures(), { sliceOf: () => 'bandit', score: score(), asOf }));
    for (const r of rows) {
      const age = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${r.exposure_date}T00:00:00Z`)) / 86_400_000;
      if (age < PROFIT_ASSUMPTIONS.outcomeHorizonDays) {
        expect(r.matured_users, r.exposure_date).toBe(0);
        expect(r.converted_users).toBe(0);
      } else expect(r.matured_users).toBe(r.exposed_users);
    }
  });

  it('winsorizes the matured value per user at the cap, and keeps guardrail counts consistent', () => {
    const cap = 20;
    const rows = parseExperimentProfitRows(martRowsFromCohort(outcomes, exposures(), { sliceOf: () => 'bandit', score: score(), valueCapUsd: cap }));
    for (const r of rows) {
      expect(r.sum_matured_value!).toBeLessThanOrEqual(cap * r.matured_converted_users! + 1e-9);
      expect(r.activated_users!).toBeLessThanOrEqual(r.scored_users);
      expect(r.failed_generations_24h!).toBeLessThanOrEqual(r.generations_24h!);
    }
    const converters = outcomes.filter((o) => o.converted_h);
    expect(converters.length).toBeGreaterThan(0);
    expect(converters.every((o) => o.value_h_usd !== 0 || o.refunded_h)).toBe(true);
    expect(outcomes.filter((o) => !o.converted_h).every((o) => o.value_h_usd === 0)).toBe(true);
  });
});
