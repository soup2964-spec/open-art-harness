import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARM_BUSINESS_TYPE,
  CAPABILITY_IDS_IN_CODE,
  modelIdFromBusinessType,
  parseModelCostsCsv,
} from '../src/model-catalog.js';
import { PLATFORM_EVENT_MAPPING, getPlatformMapping, platformMappingCsv, renderDedupKey } from '../src/platform-event-mapping.js';
import { CANONICAL_SCHEMA_IDS, validateWithSchema } from '../src/schema-registry.js';
import { CANONICAL_EVENT_NAMES, OPENART, PLATFORMS, PlatformEventMappingRowSchema } from '../src/index.js';
import { FIXTURES } from './helpers.js';

const seeds = parseModelCostsCsv(readFileSync(join(FIXTURES, 'seeds', 'model_costs.csv'), 'utf8'));
const find = (bt: string, setting: string) => seeds.find((r) => r.business_type === bt && r.setting === setting);

describe('fixtures/seeds/model_costs.csv', () => {
  it('has unique (business_type, setting) keys, code-backed business types and consistent maths', () => {
    expect(seeds.length).toBeGreaterThan(100);
    const keys = new Set<string>();
    for (const r of seeds) {
      const key = `${r.business_type}|${r.setting}`;
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
      expect(CAPABILITY_IDS_IN_CODE).toContain(r.business_type);
      expect(r.model_id).toBe(modelIdFromBusinessType(r.business_type));
      expect(Number.isInteger(r.credits) && r.credits > 0).toBe(true);
      expect(r.notes).toMatch(/^\[bt:(observed|code)\]/);
      if (r.notes.startsWith('[bt:observed]')) expect(r.business_type).toBe('openart-sdxl:text2image');
      if (r.list_cost_usd !== null) {
        expect(r.cost_per_credit_usd).not.toBeNull();
        expect(Math.abs(r.cost_per_credit_usd! - r.list_cost_usd / r.credits)).toBeLessThan(1e-6);
      }
    }
  });

  it('matches the verified credits and list costs (research/12 V2-V3 and corrections)', () => {
    expect(find('gpt-image-2-5-flare:text2image', '1024x1024 low')).toMatchObject({ credits: 5, list_cost_usd: 0.00588 });
    expect(find('nano-banana-2:text2image', '1K')).toMatchObject({ credits: 20, list_cost_usd: 0.067 });
    expect(find('nano-banana-pro:text2image', '1K/2K')).toMatchObject({ credits: 40, list_cost_usd: 0.134 });
    expect(find('byte-plus-seedance-2:text2video', '720p 5s')).toMatchObject({ credits: 400, list_cost_usd: 0.76 });
    expect(find('byte-plus-seedance-2-5:text2video', '720p 5s')).toMatchObject({ credits: 650, list_cost_usd: 1.156 });
    // Defaults are A/B arms, so no row may still claim to be "the default model".
    for (const r of seeds) expect(r.notes).not.toMatch(/^\[bt:\w+\]; default create/);
  });

  it('covers every default-model arm', () => {
    for (const bt of Object.values(ARM_BUSINESS_TYPE)) expect(seeds.some((r) => r.business_type === bt), bt).toBe(true);
  });
});

describe('PlatformEventMapping', () => {
  it('has exactly one row per canonical event x platform and every row validates', () => {
    expect(PLATFORM_EVENT_MAPPING).toHaveLength(CANONICAL_EVENT_NAMES.length * PLATFORMS.length);
    const r = validateWithSchema(CANONICAL_SCHEMA_IDS.platformEventMapping, PLATFORM_EVENT_MAPPING);
    expect(r.errors).toEqual([]);
    for (const row of PLATFORM_EVENT_MAPPING) expect(PlatformEventMappingRowSchema.safeParse(row).success).toBe(true);
    for (const e of CANONICAL_EVENT_NAMES) for (const p of PLATFORMS) expect(getPlatformMapping(e, p).platform).toBe(p);
  });

  it('server purchase events reuse the exact ids the browser pixels send (dedup)', () => {
    expect(getPlatformMapping('purchase_first', 'meta')).toMatchObject({
      platform_event_name: 'Purchase',
      dedup_key_field: 'event_id',
      dedup_key_template: 'purchase_{invoice_id}',
      status: 'twin_observed',
    });
    expect(getPlatformMapping('purchase_first', 'google_ads')).toMatchObject({
      dedup_key_field: 'transactionId',
      dedup_key_template: 'sub_{invoice_id}',
      platform_event_name: `${OPENART.googleAds.primaryAccount}/${OPENART.googleAds.purchaseLabels['AW-11252321380']}`,
    });
    expect(getPlatformMapping('purchase_first', 'tiktok')).toMatchObject({ platform_event_name: 'Purchase', dedup_key_template: 'sub_{invoice_id}' });
    expect(getPlatformMapping('purchase_first', 'reddit').browser_twin).toMatchObject({ id_template: 'sub_{invoice_id}', id_hashed: true });
    expect(getPlatformMapping('purchase_first', 'x')).toMatchObject({ platform_event_name: OPENART.x.eventIds.purchase, dedup_key_field: 'conversion_id' });
    expect(getPlatformMapping('signup', 'meta')).toMatchObject({ platform_event_name: 'CompleteRegistration', dedup_key_template: 'reg_{user_id}' });
  });

  it('flags every twin the browser sends without a usable dedup id as needing a web fix', () => {
    for (const [event, platform] of [
      ['signup', 'tiktok'],
      ['signup', 'reddit'],
      ['signup', 'linkedin'],
      ['signup', 'x'],
      ['purchase_first', 'linkedin'],
      ['purchase_first', 'microsoft'],
    ] as const) {
      expect(getPlatformMapping(event, platform).requires_web_fix, `${event}/${platform}`).toBe(true);
    }
    // The dead Google signup trigger means no browser twin traffic exists today.
    expect(getPlatformMapping('signup', 'google_ads')).toMatchObject({ status: 'server_only', requires_web_fix: false });
  });

  it('adjustments only go where a documented adjustment API exists', () => {
    for (const p of PLATFORMS) {
      const row = getPlatformMapping('refund', p);
      expect(row.delivery).toBe(p === 'google_ads' || p === 'microsoft' ? 'server_adjustment' : 'none');
    }
  });

  it('renders dedup keys from ledger values and refuses missing ones', () => {
    const values = { invoice_id: 'in_1SynthX', user_id: 'SynthU', event_id: 'purchase_in_1SynthX', order_id: 'sub_in_1SynthX' };
    expect(renderDedupKey(getPlatformMapping('purchase_first', 'meta').dedup_key_template!, values)).toBe('purchase_in_1SynthX');
    expect(renderDedupKey(getPlatformMapping('purchase_first', 'reddit').dedup_key_template!, values)).toBe('sub_in_1SynthX');
    expect(renderDedupKey(getPlatformMapping('purchase_renewal', 'google_ads').dedup_key_template!, values)).toBe('sub_in_1SynthX');
    expect(() => renderDedupKey(getPlatformMapping('refund', 'google_ads').dedup_key_template!, values)).toThrow(/adjusts_order_id/);
  });

  it('exports a CSV seed that matches the table', () => {
    const csv = readFileSync(join(FIXTURES, 'seeds', 'platform_event_mapping.csv'), 'utf8');
    expect(csv).toBe(platformMappingCsv());
  });
});
