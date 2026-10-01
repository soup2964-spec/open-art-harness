/**
 * value-health: is the value we send usable for value-based bidding? Per platform, over the last
 * 14 days of purchase sends that reached the platform (sent, validated, dry_run by default):
 *
 *   floor_share          sends that carried the floor instead of a lower (loss-making) estimate
 *   cash_fallback_share  acquisition purchases sent at cash because no purchase-time score came in time
 *   distinct_values, min_value, max_value, max_min_ratio   the spread value optimisation learns from
 *
 * checked against Meta's value-optimisation thresholds: at least 100 purchases, at least 5 distinct
 * values, and a max at least 3x the min. Only amounts in the reporting currency enter the spread
 * (currencies are never mixed); others are counted in not_in_reporting_currency.
 *
 *   npm run value-health -- [--from-json outbox.jsonl] [--window-days 14] [--statuses sent,validated] [--fail-on-threshold]
 */

import { PLATFORMS } from '@openart-signal/contracts';
import type { Platform } from '@openart-signal/contracts';
import { toUtc } from '../time.js';
import type { OutboxRecord, OutboxStatus } from '../types.js';

export const META_VALUE_THRESHOLDS = { min_conversions: 100, min_distinct_values: 5, min_max_to_min_ratio: 3 } as const;

export const DEFAULT_REPORT_STATUSES: readonly OutboxStatus[] = ['sent', 'validated', 'dry_run'];
const REPORTABLE: ReadonlySet<OutboxStatus> = new Set(['sent', 'validated', 'dry_run', 'skipped', 'dead', 'pending', 'held', 'in_flight']);

export interface PlatformValueHealth {
  platform: Platform;
  conversions: number;
  predicted: number;
  cash_fallback: number;
  cash: number;
  floored: number;
  /** floored / conversions (null without conversions). */
  floor_share: number | null;
  /** cash_fallback / (predicted + cash_fallback): acquisition purchases that missed their score. */
  cash_fallback_share: number | null;
  not_in_reporting_currency: number;
  distinct_values: number;
  min_value: number | null;
  max_value: number | null;
  max_min_ratio: number | null;
  meta_thresholds: { min_conversions: boolean; min_distinct_values: boolean; max_at_least_3x_min: boolean; ok: boolean };
}

export interface ValueHealthReport {
  generated_at: string;
  window_days: number;
  from: string;
  to: string;
  reporting_currency: string;
  statuses: OutboxStatus[];
  thresholds: typeof META_VALUE_THRESHOLDS;
  platforms: PlatformValueHealth[];
}

export interface ValueHealthOptions {
  nowMs: number;
  windowDays?: number;
  reportingCurrency?: string;
  statuses?: readonly OutboxStatus[];
}

const share = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

export function valueHealth(records: readonly OutboxRecord[], options: ValueHealthOptions): ValueHealthReport {
  const windowDays = options.windowDays ?? 14;
  const reporting = options.reportingCurrency ?? 'USD';
  const statuses = new Set(options.statuses ?? DEFAULT_REPORT_STATUSES);
  const from = options.nowMs - windowDays * 86_400_000;
  const platforms: PlatformValueHealth[] = PLATFORMS.map((platform) => {
    const sends = records.filter(
      (r) =>
        r.platform === platform &&
        r.action === 'SEND' &&
        statuses.has(r.status) &&
        r.occurred_at_ms >= from &&
        r.occurred_at_ms <= options.nowMs &&
        typeof r.meta.value === 'number' &&
        typeof r.meta.value_basis === 'string',
    );
    const count = (basis: string) => sends.filter((r) => r.meta.value_basis === basis).length;
    const inReporting = sends.filter((r) => r.meta.value_in_reporting_currency !== false && (r.meta.value_currency ?? reporting) === reporting);
    const values = inReporting.map((r) => r.meta.value as number);
    const min = values.length > 0 ? Math.min(...values) : null;
    const max = values.length > 0 ? Math.max(...values) : null;
    const ratio = min !== null && max !== null && min > 0 ? Math.round((max / min) * 100) / 100 : null;
    const distinct = new Set(values).size;
    const predicted = count('predicted_profit_90d');
    const cashFallback = count('cash_fallback');
    const floored = sends.filter((r) => r.meta.value_floored === true).length;
    const thresholds = {
      min_conversions: sends.length >= META_VALUE_THRESHOLDS.min_conversions,
      min_distinct_values: distinct >= META_VALUE_THRESHOLDS.min_distinct_values,
      max_at_least_3x_min: ratio !== null && ratio >= META_VALUE_THRESHOLDS.min_max_to_min_ratio,
      ok: false,
    };
    thresholds.ok = thresholds.min_conversions && thresholds.min_distinct_values && thresholds.max_at_least_3x_min;
    return {
      platform,
      conversions: sends.length,
      predicted,
      cash_fallback: cashFallback,
      cash: count('cash'),
      floored,
      floor_share: share(floored, sends.length),
      cash_fallback_share: share(cashFallback, predicted + cashFallback),
      not_in_reporting_currency: sends.length - inReporting.length,
      distinct_values: distinct,
      min_value: min,
      max_value: max,
      max_min_ratio: ratio,
      meta_thresholds: thresholds,
    };
  });
  return {
    generated_at: toUtc(options.nowMs),
    window_days: windowDays,
    from: toUtc(from),
    to: toUtc(options.nowMs),
    reporting_currency: reporting,
    statuses: [...statuses],
    thresholds: META_VALUE_THRESHOLDS,
    platforms,
  };
}

export interface ValueHealthArgs {
  fromJson?: string;
  windowDays?: number;
  nowMs?: number;
  statuses?: OutboxStatus[];
  failOnThreshold?: boolean;
}

export function parseValueHealthArgs(argv: readonly string[]): ValueHealthArgs {
  const out: ValueHealthArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--from-json':
        out.fromJson = next();
        break;
      case '--window-days': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('--window-days must be an integer 1..90');
        out.windowDays = n;
        break;
      }
      case '--now': {
        const ms = Date.parse(next());
        if (!Number.isFinite(ms)) throw new Error('--now must be an RFC 3339 time');
        out.nowMs = ms;
        break;
      }
      case '--statuses': {
        const list = next().split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of list) if (!REPORTABLE.has(s as OutboxStatus)) throw new Error(`--statuses: unknown status ${s}`);
        out.statuses = list as OutboxStatus[];
        break;
      }
      case '--fail-on-threshold':
        out.failOnThreshold = true;
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}
