import { describe, expect, it } from 'vitest';
import { META_VALUE_THRESHOLDS, parseValueHealthArgs, valueHealth } from '../src/reports/value-health.js';
import type { OutboxRecord } from '../src/types.js';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const DAY = 86_400_000;

function send(i: number, over: Partial<OutboxRecord> & { value?: number; basis?: string; floored?: boolean; currency?: string; inReporting?: boolean } = {}): OutboxRecord {
  const { value = 10, basis = 'predicted_profit_90d', floored = false, currency = 'USD', inReporting = true, ...rest } = over;
  return {
    key: `meta:SEND:purchase_in_${i}`,
    platform: 'meta',
    action: 'SEND',
    event_id: `purchase_in_${i}`,
    canonical_event: 'purchase_first',
    user_id: `u${i}`,
    consent: null,
    occurred_at_ms: NOW - DAY,
    status: 'sent',
    reason: null,
    hold_gate: null,
    attempts: 1,
    next_attempt_at_ms: NOW - DAY,
    not_before_ms: null,
    deadline_ms: null,
    lease_until_ms: null,
    batch_key: 'px',
    item: null,
    meta: { value, value_currency: currency, value_basis: basis, value_floored: floored, value_in_reporting_currency: inReporting },
    created_at_ms: NOW - DAY,
    updated_at_ms: NOW - DAY,
    last_error: null,
    history: [],
    expire_at: '2026-12-31T00:00:00Z',
    ...rest,
  };
}

describe('value-health report (per platform, last 14 days)', () => {
  it('reports floor share, cash-fallback share, distinct values and the max/min spread, and checks Meta thresholds', () => {
    const records: OutboxRecord[] = [];
    for (let i = 0; i < 150; i += 1) {
      if (i < 15) records.push(send(i, { value: 0.01, floored: true }));
      else if (i < 45) records.push(send(i, { value: 14, basis: 'cash_fallback' }));
      else records.push(send(i, { value: 5 + (i % 10) * 3 }));
    }
    const report = valueHealth(records, { nowMs: NOW });
    expect(report).toMatchObject({ window_days: 14, reporting_currency: 'USD', thresholds: META_VALUE_THRESHOLDS });
    const meta = report.platforms.find((p) => p.platform === 'meta')!;
    expect(meta).toMatchObject({
      conversions: 150,
      floored: 15,
      floor_share: 0.1,
      cash_fallback: 30,
      cash_fallback_share: 0.2,
      distinct_values: 11,
      min_value: 0.01,
      max_value: 32,
      meta_thresholds: { min_conversions: true, min_distinct_values: true, max_at_least_3x_min: true, ok: true },
    });
  });

  it('flags a platform whose values cannot drive value optimisation (too few, all the same)', () => {
    const records = Array.from({ length: 40 }, (_, i) => send(i, { value: 14, basis: 'cash' }));
    const meta = valueHealth(records, { nowMs: NOW }).platforms.find((p) => p.platform === 'meta')!;
    expect(meta).toMatchObject({ conversions: 40, distinct_values: 1, max_min_ratio: 1, meta_thresholds: { min_conversions: false, min_distinct_values: false, max_at_least_3x_min: false, ok: false } });
  });

  it('counts only purchase sends that reached the platform inside the window, and never mixes currencies', () => {
    const records = [
      send(1, { value: 10 }),
      send(2, { value: 30, occurred_at_ms: NOW - 20 * DAY }),
      send(3, { value: 40, status: 'skipped' }),
      send(4, { value: 50, status: 'dead' }),
      send(5, { value: 900, currency: 'JPY', inReporting: false }),
      send(6, { value: 12, platform: 'google_ads', key: 'google_ads:SEND:purchase_in_6' }),
      send(7, { value: 11, status: 'dry_run' }),
      send(8, { value: 13, status: 'validated' }),
    ];
    const report = valueHealth(records, { nowMs: NOW });
    const meta = report.platforms.find((p) => p.platform === 'meta')!;
    expect(meta).toMatchObject({ conversions: 4, not_in_reporting_currency: 1, distinct_values: 3, min_value: 10, max_value: 13 });
    expect(report.platforms.find((p) => p.platform === 'google_ads')).toMatchObject({ conversions: 1 });
    const liveOnly = valueHealth(records, { nowMs: NOW, statuses: ['sent'] }).platforms.find((p) => p.platform === 'meta')!;
    expect(liveOnly.conversions).toBe(2);
  });

  it('CLI arguments', () => {
    expect(parseValueHealthArgs(['--from-json', 'outbox.jsonl', '--window-days', '28', '--now', '2026-09-30T00:00:00Z', '--statuses', 'sent,validated', '--fail-on-threshold'])).toEqual({
      fromJson: 'outbox.jsonl',
      windowDays: 28,
      nowMs: NOW,
      statuses: ['sent', 'validated'],
      failOnThreshold: true,
    });
    expect(() => parseValueHealthArgs(['--window-days', '0'])).toThrow(/window-days/);
    expect(() => parseValueHealthArgs(['--statuses', 'sent,bogus'])).toThrow(/bogus/);
  });
});
