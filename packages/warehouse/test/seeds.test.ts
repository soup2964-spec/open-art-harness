/**
 * The warehouse's own seeds restate a few contracts constants in CSV form for SQL. These tests
 * pin them to the TypeScript source of truth so the two cannot drift.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_REQUIRED_REGIONS,
  CLICK_ID_KEYS_EXTENDED,
  CREDIT_PACK,
  ONE_TIME_PACK,
  OBSERVED_ARMS,
  OPENART,
  PLAN_MONTHLY_CREDITS,
  PLAN_PRICES,
  PLAN_TIERS,
  PLATFORMS,
  TIER_CODE,
  parseModelCostsCsv,
} from '@openart-signal/contracts';
import { ARM_DEFAULT_GENERATION } from '@openart-signal/contracts/cohort/params';
import { SCENARIO_USERS } from '../../contracts/src/fixtures/scenarios.js';
import { countryBucket } from '@openart-signal/bandit-allocator';
import { readFileSync } from 'node:fs';
import { CONTRACTS_FIXTURES, WAREHOUSE, readCsv } from './helpers.js';

const seed = (name: string) => readCsv(join(WAREHOUSE, 'seeds', name));

describe('warehouse seeds match the contracts and the bandit-allocator', () => {
  it('consent_required_regions.csv = contracts CONSENT_REQUIRED_REGIONS, and country_codes.is_eea_uk_ch agrees', () => {
    const seeded = seed('consent_required_regions.csv').map((r) => r.iso2).sort();
    expect(seeded).toEqual([...CONSENT_REQUIRED_REGIONS].sort());
    for (const r of seed('country_codes.csv')) {
      expect(r.is_eea_uk_ch === 'true', `${r.country_name} (${r.iso2})`).toBe(CONSENT_REQUIRED_REGIONS.has(r.iso2!));
    }
  });

  it('segment_country_buckets.csv = bandit-allocator countryBucket() for every key, names and ISO codes', () => {
    for (const r of seed('segment_country_buckets.csv')) {
      expect(countryBucket(r.country_key), r.country_key).toBe(r.country_bucket);
    }
    // a known tier-1 country missing from the seed would silently fall to "rest"
    for (const name of ['Canada', 'United Kingdom', 'Germany', 'Japan', 'France', 'CA', 'gb']) {
      const key = /^[A-Za-z]{2}$/.test(name) ? name.toUpperCase() : name.toLowerCase();
      expect(seed('segment_country_buckets.csv').some((r) => r.country_key === key), name).toBe(true);
    }
  });

  it('fx_rates.csv: every currency has a minor-unit exponent and USD is 1', () => {
    const digits = new Map(seed('currency_minor_units.csv').map((r) => [r.currency, Number(r.minor_unit_digits)]));
    for (const r of seed('fx_rates.csv')) {
      expect(digits.has(r.currency!), r.currency).toBe(true);
      expect(Number(r.usd_per_unit)).toBeGreaterThan(0);
    }
    expect(seed('fx_rates.csv').find((r) => r.currency === 'USD')?.usd_per_unit).toBe('1.0');
    expect(digits.get('JPY')).toBe(0);
    expect(digits.get('KRW')).toBe(0);
  });
});

describe('warehouse seeds match the contracts', () => {
  it('plan_catalog.csv = PLAN_PRICES, TIER_CODE, PLAN_MONTHLY_CREDITS, CREDIT_PACK, ONE_TIME_PACK', () => {
    const rows = new Map(seed('plan_catalog.csv').map((r) => [r.price_id, r]));
    let plans = 0;
    for (const [tier, byInterval] of Object.entries(PLAN_PRICES)) {
      for (const [interval, price] of Object.entries(byInterval)) {
        const row = rows.get(price.priceId);
        expect(row, price.priceId).toBeDefined();
        expect(row).toMatchObject({
          product_id: price.productId,
          item_type: 'plan',
          plan_tier: tier,
          billing_interval: interval,
          unit_amount_minor: String(price.unitAmountMinor),
          plan_tier_code: String(TIER_CODE[tier as keyof typeof TIER_CODE]),
          monthly_credits: String(PLAN_MONTHLY_CREDITS[tier as keyof typeof PLAN_MONTHLY_CREDITS]),
        });
        plans += 1;
      }
    }
    expect(rows.get(CREDIT_PACK.priceId)).toMatchObject({
      product_id: CREDIT_PACK.productId,
      item_type: 'credit_pack',
      unit_amount_minor: String(CREDIT_PACK.unitAmountMinor),
      credits_per_unit: String(CREDIT_PACK.creditsPerPack),
    });
    expect(rows.get(ONE_TIME_PACK.priceId)).toMatchObject({
      product_id: ONE_TIME_PACK.productId,
      item_type: 'one_time_pack',
      unit_amount_minor: String(ONE_TIME_PACK.unitAmountMinor),
      credits_per_unit: String(ONE_TIME_PACK.credits),
    });
    expect(rows.size).toBe(plans + 2);
  });

  it('default_model_arms.csv = ARM_DEFAULT_GENERATION for every observed arm, and each setting exists in model_costs.csv', () => {
    const costs = parseModelCostsCsv(readFileSync(join(CONTRACTS_FIXTURES, 'seeds', 'model_costs.csv'), 'utf8'));
    const rows = seed('default_model_arms.csv');
    const observed = Object.entries(OBSERVED_ARMS).flatMap(([flag, arms]) => arms.map((arm) => `${flag}|${arm}`));
    expect(rows.map((r) => `${r.flag_key}|${r.arm}`).sort()).toEqual(observed.sort());
    for (const r of rows) {
      const g = ARM_DEFAULT_GENERATION[r.arm!]!;
      expect(r).toMatchObject({ business_type: g.businessType, default_setting: g.setting, credits_per_generation: String(g.credits), media_type: g.mode });
      const cost = costs.find((c) => c.business_type === g.businessType && c.setting === g.setting);
      expect(cost?.credits, `${g.businessType} @ ${g.setting}`).toBe(g.credits);
    }
  });

  it('click_id_platforms.csv covers exactly CLICK_ID_KEYS_EXTENDED', () => {
    expect(seed('click_id_platforms.csv').map((r) => r.click_id_key).sort()).toEqual([...CLICK_ID_KEYS_EXTENDED].sort());
  });

  it('platform_reporting_rules.csv covers every Platform, with OpenArt\'s real account ids and click keys from click_id_platforms.csv', () => {
    const rules = seed('platform_reporting_rules.csv');
    expect(rules.map((r) => r.platform).sort()).toEqual([...PLATFORMS].sort());
    const accounts: Record<string, string> = {
      google_ads: `${OPENART.googleAds.primaryAccount}|${OPENART.googleAds.secondaryAccount}`,
      meta: OPENART.meta.pixelId,
      tiktok: OPENART.tiktok.pixelCode,
      reddit: OPENART.reddit.pixelId,
      linkedin: OPENART.linkedin.partnerId,
      x: OPENART.x.pixelId,
      microsoft: OPENART.microsoft.uetTagId,
    };
    const keysByPlatform = new Map<string, string[]>();
    for (const r of seed('click_id_platforms.csv')) keysByPlatform.set(r.platform!, [...(keysByPlatform.get(r.platform!) ?? []), r.click_id_key!]);
    for (const r of rules) {
      expect(r.account_ids, r.platform).toBe(accounts[r.platform!]);
      expect(r.click_id_keys!.split('|').sort(), r.platform).toEqual((keysByPlatform.get(r.platform!) ?? []).sort());
      expect(['every_subscription_checkout', 'first_valid_purchase']).toContain(r.scope);
      expect(['invoice_amount', 'ltv_else_amount', 'none']).toContain(r.value_rule);
      expect(['click', 'conversion']).toContain(r.date_basis);
    }
  });

  it('fallback_price_table.csv uses canonical tiers; qa_accounts.csv lists the contracts scenario users', () => {
    for (const r of seed('fallback_price_table.csv')) expect(PLAN_TIERS).toContain(r.plan_tier);
    expect(seed('qa_accounts.csv').map((r) => r.user_id).sort()).toEqual(Object.values(SCENARIO_USERS).map((u) => u.uid).sort());
  });
});
