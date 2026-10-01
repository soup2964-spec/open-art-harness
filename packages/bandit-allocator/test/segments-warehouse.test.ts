import { describe, expect, it } from 'vitest';
import {
  channelFromUserProperties,
  countryBucket,
  deviceFromAmplitude,
  parseSegmentKey,
  segmentKey,
} from '../src/segments.js';
import {
  aggregateRows,
  EXPERIMENT_PROFIT_BY_ARM_COLUMNS,
  parseExperimentProfitRows,
  type ExperimentProfitByArmRow,
} from '../src/warehouse.js';

const IMG = 'suite-default-model-create-image';

/** A valid row; revenue is derived so the PredictedProfit identity holds unless overridden. */
function row(over: Partial<ExperimentProfitByArmRow> & Record<string, unknown> = {}): ExperimentProfitByArmRow {
  const base = {
    exposure_date: '2026-09-20',
    flag_key: IMG,
    arm: 'gpt-image-2-5',
    country_bucket: 'us',
    device: 'desktop',
    acquisition_channel: 'google_cpc',
    allocation_slice: 'bandit',
    exposed_users: 100,
    scored_users: 100,
    converted_users: 5,
    sum_predicted_profit: 250,
    sum_sq_predicted_profit: 250 * 250,
    sum_predicted_generation_cost: 20,
    sum_predicted_fees: 30,
    sum_predicted_refund_risk: 100,
    model_version: 'test',
    ...over,
  } as ExperimentProfitByArmRow;
  const revenue =
    over.sum_predicted_revenue ??
    base.sum_predicted_profit + base.sum_predicted_generation_cost + base.sum_predicted_fees + base.sum_predicted_refund_risk;
  return { ...base, sum_predicted_revenue: revenue };
}

describe('segments', () => {
  it('buckets countries from ISO-2 codes and Amplitude country names', () => {
    expect(countryBucket('United States')).toBe('us');
    expect(countryBucket('US')).toBe('us');
    expect(countryBucket('us')).toBe('us');
    expect(countryBucket('Germany')).toBe('tier1');
    expect(countryBucket('GB')).toBe('tier1');
    expect(countryBucket('United Kingdom')).toBe('tier1');
    expect(countryBucket('Brazil')).toBe('rest');
    expect(countryBucket('IN')).toBe('rest');
    expect(countryBucket(null)).toBe('unknown');
    expect(countryBucket('')).toBe('unknown');
  });

  it('derives device from Amplitude platform / os / device_type', () => {
    expect(deviceFromAmplitude({ platform: 'Web', os_name: 'Chrome', device_type: 'Mac' })).toBe('desktop');
    expect(deviceFromAmplitude({ platform: 'Web', os_name: 'Mobile Safari', device_type: 'Apple iPhone' })).toBe('mobile');
    expect(deviceFromAmplitude({ platform: 'Web', os_name: 'Chrome Mobile', device_type: 'Android' })).toBe('mobile');
    expect(deviceFromAmplitude({ platform: 'iOS', os_name: 'ios', device_type: 'iPhone 15' })).toBe('mobile');
    expect(deviceFromAmplitude({ platform: 'Web', os_name: 'Mobile Safari', device_type: 'Apple iPad' })).toBe('tablet');
    expect(deviceFromAmplitude({ platform: 'Web', os_name: 'Firefox', device_type: 'Windows' })).toBe('desktop');
    expect(deviceFromAmplitude({})).toBe('unknown');
  });

  it('derives the acquisition channel from Amplitude initial_* attribution properties', () => {
    expect(channelFromUserProperties({ initial_gclid: 'Cj0K', initial_utm_source: 'google' })).toBe('google_cpc');
    expect(channelFromUserProperties({ initial_fbclid: 'IwAR' })).toBe('meta_paid_social');
    expect(channelFromUserProperties({ initial_ttclid: 'E.C.P.x' })).toBe('tiktok_paid_social');
    expect(channelFromUserProperties({ initial_utm_source: 'tolt', initial_utm_medium: 'affiliate' })).toBe('affiliate');
    expect(channelFromUserProperties({ initial_utm_source: 'bing', initial_utm_medium: 'cpc' })).toBe('other_paid');
    expect(channelFromUserProperties({})).toBe('organic');
  });

  it('round-trips segment keys', () => {
    const s = { country_bucket: 'tier1', device: 'mobile', acquisition_channel: 'affiliate' } as const;
    expect(parseSegmentKey(segmentKey(s))).toEqual(s);
    expect(() => parseSegmentKey('us|desktop')).toThrow();
  });
});

describe('fct_experiment_profit_by_arm rows', () => {
  it('exposes the documented column list', () => {
    expect(Object.keys(row()).sort()).toEqual([...EXPERIMENT_PROFIT_BY_ARM_COLUMNS].sort());
  });

  it('accepts valid rows and rejects impossible ones with a reason', () => {
    expect(parseExperimentProfitRows([row()]).length).toBe(1);
    const bad: Array<[Partial<ExperimentProfitByArmRow> & Record<string, unknown>, RegExp]> = [
      [{ scored_users: 101 }, /scored_users/],
      [{ converted_users: 101 }, /converted_users/],
      [{ exposed_users: -1 }, /exposed_users/],
      [{ sum_sq_predicted_profit: 1 }, /sum_sq_predicted_profit/],
      [{ sum_predicted_revenue: 1 }, /identity/],
      [{ exposure_date: '2026-9-20' }, /exposure_date/],
      [{ allocation_slice: 'control' as never }, /allocation_slice/],
      [{ surprise: 1 }, /surprise|unrecognized/i],
    ];
    for (const [over, why] of bad) {
      expect(() => parseExperimentProfitRows([row(over)]), JSON.stringify(over)).toThrow(why);
    }
  });

  it('rejects duplicate grain keys', () => {
    expect(() => parseExperimentProfitRows([row(), row()])).toThrow(/duplicate/);
  });
});

describe('aggregateRows', () => {
  const rows = [
    row({ exposure_date: '2026-09-28', scored_users: 10, exposed_users: 10, sum_predicted_profit: 10, sum_sq_predicted_profit: 10, converted_users: 1 }),
    row({ exposure_date: '2026-09-27', scored_users: 10, exposed_users: 10, sum_predicted_profit: 20, sum_sq_predicted_profit: 40, converted_users: 2 }),
    row({ exposure_date: '2026-09-27', allocation_slice: 'holdout', scored_users: 4, exposed_users: 4, sum_predicted_profit: 8, sum_sq_predicted_profit: 16, converted_users: 0 }),
    // On the run date itself (incomplete) and outside the lookback window: ignored.
    row({ exposure_date: '2026-09-29', scored_users: 99, exposed_users: 99, sum_predicted_profit: 999, sum_sq_predicted_profit: 999 * 999 }),
    row({ exposure_date: '2026-07-01', scored_users: 99, exposed_users: 99, sum_predicted_profit: 999, sum_sq_predicted_profit: 999 * 999 }),
  ];

  it('sums both slices, keeps the holdout separately and ignores out-of-window days', () => {
    const agg = aggregateRows(rows, { runDate: '2026-09-29', lookbackDays: 28, halfLifeDays: null, reward: 'predicted_profit' });
    const cell = agg.cell(IMG, 'gpt-image-2-5', 'us|desktop|google_cpc')!;
    expect(cell.all).toEqual({ n: 24, sum: 38, sumSq: 66 });
    expect(cell.holdout).toEqual({ n: 4, sum: 8, sumSq: 16 });
    expect(cell.scoredUsers).toBe(24);
    expect(cell.holdoutExposed).toBe(4);
  });

  it('applies exponential decay by age (half-life in days)', () => {
    const agg = aggregateRows(rows.slice(0, 2), { runDate: '2026-09-29', lookbackDays: 28, halfLifeDays: 1, reward: 'predicted_profit' });
    const cell = agg.cell(IMG, 'gpt-image-2-5', 'us|desktop|google_cpc')!;
    // Age 0 (yesterday) weight 1; age 1 weight 0.5.
    expect(cell.all.n).toBeCloseTo(15, 12);
    expect(cell.all.sum).toBeCloseTo(20, 12);
    expect(cell.scoredUsers).toBe(20); // the minimum-sample rule counts real users
  });

  it('switches to the conversion reward (0/1 per scored user)', () => {
    const agg = aggregateRows(rows, { runDate: '2026-09-29', lookbackDays: 28, halfLifeDays: null, reward: 'conversion' });
    expect(agg.cell(IMG, 'gpt-image-2-5', 'us|desktop|google_cpc')!.all).toEqual({ n: 24, sum: 3, sumSq: 3 });
  });
});
