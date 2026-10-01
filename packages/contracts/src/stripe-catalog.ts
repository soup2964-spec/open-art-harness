/**
 * OpenArt's Stripe catalog as observed, plus clearly-labelled synthetic ids.
 *
 * Price/product ids: production map in the legacy `_app` bundle
 * (raw/bundles/js/openart.ai___next__static__chunks__pages___app-a1820d4f2194dce7.js);
 * Starter monthly (price_1QWx4UKVhG51tYSBfdRth4n8 / prod_RHumJXcmLdV3R9) was also seen in
 * a live Checkout Session (research/10 §5.3).
 * Amounts: monthly list prices are observed. Annual = monthly x 12 x (1 - discount) with the
 * shipped discount map {Essential:10, Advanced:20, Infinite:22, Wonder:27} (research/12 V1);
 * Starter $151.20 (research/10 §5.3) and Pro $524.16 (research/12 correction 9) are observed,
 * Plus $326.40 and Wonder $2,102.40 are computed.
 */

import type { BillingInterval, PlanTier } from './constants.js';

export type PaidSelfServeTier = Extract<PlanTier, 'essential' | 'advanced' | 'infinite' | 'wonder'>;

export interface CatalogPrice {
  priceId: string;
  productId: string;
  unitAmountMinor: number;
  interval: BillingInterval;
  amountEvidence: 'observed' | 'computed';
}

export const STRIPE_PRODUCTS = {
  essential: 'prod_RHumJXcmLdV3R9',
  advanced: 'prod_RHums1icx6Ol9x',
  infinite: 'prod_RHumZDdIzaVqJB',
  wonder: 'prod_TRDhpbWHKB2e4p',
  team: 'prod_SMUBCpDdh7ebmf',
  business: 'prod_UyxSOHTOZ6WPxX',
  creditPack: 'prod_RHum8ynRJZXQBr',
} as const;

export const PLAN_PRICES: Readonly<Record<PaidSelfServeTier, Record<BillingInterval, CatalogPrice>>> = {
  essential: {
    month: { priceId: 'price_1QWx4UKVhG51tYSBfdRth4n8', productId: STRIPE_PRODUCTS.essential, unitAmountMinor: 1400, interval: 'month', amountEvidence: 'observed' },
    year: { priceId: 'price_1QWx4eKVhG51tYSBpjHjWeCu', productId: STRIPE_PRODUCTS.essential, unitAmountMinor: 15120, interval: 'year', amountEvidence: 'observed' },
  },
  advanced: {
    month: { priceId: 'price_1TvuqQKVhG51tYSBesVOM0JO', productId: STRIPE_PRODUCTS.advanced, unitAmountMinor: 3400, interval: 'month', amountEvidence: 'observed' },
    year: { priceId: 'price_1TvuqeKVhG51tYSBOLvVdqSS', productId: STRIPE_PRODUCTS.advanced, unitAmountMinor: 32640, interval: 'year', amountEvidence: 'computed' },
  },
  infinite: {
    month: { priceId: 'price_1QPKxIKVhG51tYSBcgKOHs5y', productId: STRIPE_PRODUCTS.infinite, unitAmountMinor: 5600, interval: 'month', amountEvidence: 'observed' },
    year: { priceId: 'price_1QPKxIKVhG51tYSBtzq6ijS3', productId: STRIPE_PRODUCTS.infinite, unitAmountMinor: 52416, interval: 'year', amountEvidence: 'observed' },
  },
  wonder: {
    month: { priceId: 'price_1SULG9KVhG51tYSBA1dGTcTQ', productId: STRIPE_PRODUCTS.wonder, unitAmountMinor: 24000, interval: 'month', amountEvidence: 'observed' },
    year: { priceId: 'price_1SULGUKVhG51tYSBGd4Avkuj', productId: STRIPE_PRODUCTS.wonder, unitAmountMinor: 210240, interval: 'year', amountEvidence: 'computed' },
  },
};

/** Monthly credits per plan (pricing page + SubscriptionLevelConfig.creditsAmount). Annual plans refill monthly. */
export const PLAN_MONTHLY_CREDITS: Readonly<Record<PaidSelfServeTier, number>> = {
  essential: 4000,
  advanced: 12000,
  infinite: 24000,
  wonder: 106000,
};

export const TIER_CODE: Readonly<Record<PaidSelfServeTier, number>> = {
  essential: 1000,
  advanced: 2000,
  infinite: 3000,
  wonder: 3500,
};

/** Tiers that may buy the $15 / 5,000-credit monthly add-on (Plus and above). */
export const ADD_ON_ELIGIBLE_TIERS: readonly PaidSelfServeTier[] = ['advanced', 'infinite', 'wonder'];

/**
 * Add-on credit pack. Product id is real (production map); the PRICE ID IS SYNTHETIC
 * (not found in shipped code). $15 per 5,000 credits per month is observed.
 */
export const CREDIT_PACK = {
  productId: STRIPE_PRODUCTS.creditPack,
  priceId: 'price_SYNTHcreditPack5kMonth',
  unitAmountMinor: 1500,
  creditsPerPack: 5000,
  interval: 'month' as BillingInterval,
} as const;

/**
 * One-time pack (800 credits, 48 h offer). Product id, price id and price are SYNTHETIC /
 * ILLUSTRATIVE: the UI only says "Get access for $X" and the offer was not shown to the
 * research account (research/10 §6).
 */
export const ONE_TIME_PACK = {
  productId: 'prod_SYNTHoneTimePack800',
  priceId: 'price_SYNTHoneTimePack800',
  unitAmountMinor: 999,
  credits: 800,
} as const;

export function planFromPriceId(priceId: string): { tier: PaidSelfServeTier; interval: BillingInterval } | null {
  for (const tier of Object.keys(PLAN_PRICES) as PaidSelfServeTier[]) {
    for (const interval of ['month', 'year'] as const) {
      if (PLAN_PRICES[tier][interval].priceId === priceId) return { tier, interval };
    }
  }
  return null;
}

export function tierFromProductId(productId: string): PaidSelfServeTier | null {
  for (const tier of Object.keys(PLAN_PRICES) as PaidSelfServeTier[]) {
    if (STRIPE_PRODUCTS[tier] === productId) return tier;
  }
  return null;
}
