/**
 * Cohort generator parameters.
 *
 * !!! ILLUSTRATIVE !!! Every behavioural number in this file (activation, conversion,
 * plan mix, churn, refunds, chargebacks, add-ons, upgrades, utilisation, stickiness,
 * arm effects, channel mix) is an ASSUMPTION chosen to produce plausible synthetic data
 * for testing the warehouse, bandit and audience packages. None is an OpenArt
 * measurement. Only the items tagged OBSERVED come from research (prices, credits,
 * trial size, arms, credit costs per generation).
 */

import type { PaidSelfServeTier } from '../stripe-catalog.js';

export interface GenerationOption {
  /** Ledger businessType = capability id. */
  businessType: string;
  /** Setting row in fixtures/seeds/model_costs.csv. */
  setting: string;
  /** Credits per asset at this setting (must equal the seed row). */
  credits: number;
  mode: 'image' | 'video';
}

/** OBSERVED credits at the default settings (research/12 V2, research/09 UI table). */
export const ARM_DEFAULT_GENERATION: Readonly<Record<string, GenerationOption>> = {
  'nano-banana-pro': { businessType: 'nano-banana-pro:text2image', setting: '1K/2K', credits: 40, mode: 'image' },
  'gpt-image-2-5': { businessType: 'gpt-image-2-5-flare:text2image', setting: '1024x1024 low', credits: 5, mode: 'image' },
  'nano-banana-2': { businessType: 'nano-banana-2:text2image', setting: '1K', credits: 20, mode: 'image' },
  'gpt-image-2': { businessType: 'gpt-image-2:text2image', setting: '1024x1024 low', credits: 5, mode: 'image' },
  'byte-plus-seedance-2': { businessType: 'byte-plus-seedance-2:text2video', setting: '720p 5s', credits: 400, mode: 'video' },
  'byte-plus-seedance-2-5': { businessType: 'byte-plus-seedance-2-5:text2video', setting: '720p 5s', credits: 650, mode: 'video' },
  'wan3-0': { businessType: 'wan3-0:text2video', setting: '720p 5s', credits: 200, mode: 'video' },
};

/** Models users pick when they leave the default (OBSERVED credits; the pick weights are ILLUSTRATIVE). */
export const OTHER_MODELS: Readonly<{ image: Array<GenerationOption & { weight: number }>; video: Array<GenerationOption & { weight: number }> }> = {
  image: [
    { businessType: 'nano-banana-2:text2image', setting: '1K', credits: 20, mode: 'image', weight: 3 },
    { businessType: 'gpt-image-2-5-flare:text2image', setting: '1024x1024 medium', credits: 30, mode: 'image', weight: 2 },
    { businessType: 'byte-plus-seedream-4-5:text2image', setting: '2K', credits: 15, mode: 'image', weight: 1 },
    { businessType: 'flux-kontext-pro:text2image', setting: '1 image', credits: 5, mode: 'image', weight: 1 },
    { businessType: 'openart-sdxl:text2image', setting: '1 image', credits: 1, mode: 'image', weight: 1 },
  ],
  video: [
    { businessType: 'kling-v3:text2video', setting: 'std 5s with audio', credits: 175, mode: 'video', weight: 2 },
    { businessType: 'veo3-1:text2video', setting: 'lite 720p 8s audio', credits: 160, mode: 'video', weight: 2 },
    { businessType: 'byte-plus-seedance-2-5:text2video', setting: '480p 5s', credits: 300, mode: 'video', weight: 1 },
    { businessType: 'fal-h3-max:text2video', setting: '768p 5s', credits: 200, mode: 'video', weight: 1 },
  ],
};

export const COHORT_PARAMS = {
  seed: 'openart-signal/cohort/v1',
  users: 2000,
  /** Signups are spread uniformly over this window. */
  signupStart: '2026-06-01T00:00:00Z',
  signupWindowDays: 60,
  /** Nothing is generated at or after this instant. */
  simulationEnd: '2026-09-28T00:00:00Z',

  /** OBSERVED: 40 trial credits for 7 days. */
  trialCredits: 40,
  trialDays: 7,

  /** OBSERVED arms; ILLUSTRATIVE equal allocation. */
  armWeights: {
    'suite-default-model-create-image': { 'nano-banana-pro': 1, 'gpt-image-2-5': 1, 'nano-banana-2': 1, 'gpt-image-2': 1 },
    'suite-default-model-create-video': { 'byte-plus-seedance-2': 1, 'byte-plus-seedance-2-5': 1, 'wan3-0': 1 },
  },

  // ---------------- ILLUSTRATIVE behaviour ----------------
  activationProbability: 0.62,
  activationMeanDelayHours: 3,
  /** P(a generation uses the arm's default model). */
  defaultModelStickiness: 0.7,
  videoShareFree: 0.3,
  videoSharePaid: 0.45,
  /** Image generations request 1-4 assets. */
  imageBatchSizes: [1, 1, 2, 4] as readonly number[],
  failedGenerationRate: 0.03,
  freeGenerationsMean: 4,

  /** Probability a free user subscribes within 14 days, before arm and exhaustion effects. */
  conversionBase: 0.07,
  /** Users who run out of trial credits convert more often. */
  exhaustedTrialMultiplier: 1.6,
  /** ILLUSTRATIVE quality effects per arm (what the bandit should discover). */
  armConversionMultiplier: {
    'nano-banana-pro': 1.2,
    'gpt-image-2-5': 1.0,
    'nano-banana-2': 1.1,
    'gpt-image-2': 0.9,
    'byte-plus-seedance-2': 1.0,
    'byte-plus-seedance-2-5': 1.1,
    'wan3-0': 0.85,
  } as Readonly<Record<string, number>>,

  planMix: { essential: 0.45, advanced: 0.25, infinite: 0.22, wonder: 0.08 } as Readonly<Record<PaidSelfServeTier, number>>,
  annualShare: { essential: 0.25, advanced: 0.3, infinite: 0.35, wonder: 0.45 } as Readonly<Record<PaidSelfServeTier, number>>,

  /** Share of monthly plan credits a paid user burns: Beta(a, b), mean a/(a+b). */
  utilizationBeta: { a: 2, b: 3 },
  /** Hard cap on generations per user-month (keeps fixture files small). */
  maxGenerationsPerMonth: 60,

  /** Monthly-plan churn at each renewal; annual plans churn at the annual renewal only. */
  monthlyChurn: { essential: 0.22, advanced: 0.16, infinite: 0.13, wonder: 0.1 } as Readonly<Record<PaidSelfServeTier, number>>,
  refundProbabilityPerInvoice: 0.015,
  chargebackProbabilityPerInvoice: 0.004,
  addOnProbabilityPerMonth: 0.06,
  upgradeProbabilityPerMonth: 0.04,
  oneTimePackProbabilityFree: 0.02,

  /** Acquisition channel -> weight; drives Amplitude initial_utm_* and click ids. */
  channelWeights: { google_cpc: 0.3, meta_paid_social: 0.2, tiktok_paid_social: 0.1, organic: 0.3, affiliate: 0.1 },
  country: { 'United States': 0.55, 'United Kingdom': 0.08, Germany: 0.07, Brazil: 0.06, India: 0.06, Japan: 0.05, France: 0.05, Canada: 0.08 },
} as const;

export type CohortParams = typeof COHORT_PARAMS;
