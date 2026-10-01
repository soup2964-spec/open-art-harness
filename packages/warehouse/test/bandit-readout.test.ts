/**
 * fct_experiment_profit_by_arm_daily is the bandit-allocator's native input (ML review 6). Checked
 * with the allocator's OWN code, so the two packages cannot drift:
 *   - every exported row passes parseExperimentProfitRows (its strict zod schema: exactly its 17
 *     columns and enums, the PredictedProfit identity, Cauchy-Schwarz, counts, unique grain);
 *   - every cohort user's segment and holdout slice equal what segments.ts / launchdarkly.ts compute
 *     from the raw Amplitude fixture (segmentsFromAmplitude, isHoldoutUser);
 *   - exposures are counted by first exposure (intention to treat): per (day, flag, arm, segment,
 *     slice) the warehouse's exposed counts equal what the allocator's own cohort functions give;
 *   - the allocator's optional column groups, which the mart provides under the same names, pass
 *     its schema's consistency checks.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPERIMENT_PROFIT_BY_ARM_COLUMNS,
  OPTIONAL_EXPERIMENT_COLUMNS,
  exposuresFromCohort,
  isHoldoutUser,
  loadFixtureCohort,
  parseExperimentProfitRows,
  segmentsFromAmplitude,
} from '@openart-signal/bandit-allocator';
import { EXPORT_DIR, WAREHOUSE, exportAvailable, readCsv, readJsonl } from './helpers.js';

type Row = Record<string, unknown>;

describe.skipIf(!exportAvailable())('fct_experiment_profit_by_arm_daily feeds the bandit-allocator unchanged', () => {
  const daily = () => readJsonl<Row>(join(EXPORT_DIR, 'experiment_profit_by_arm_daily.jsonl'));
  const users = () => readJsonl<Row>(join(EXPORT_DIR, 'bandit_user_segments.jsonl'));

  it('every row passes the allocator zod schema (exact columns, enums, identity, unique grain)', () => {
    const rows = daily();
    expect(rows.length).toBeGreaterThan(1000);
    expect(Object.keys(rows[0]!)).toEqual([...EXPERIMENT_PROFIT_BY_ARM_COLUMNS]);
    const parsed = parseExperimentProfitRows(rows);
    expect(parsed.length).toBe(rows.length);
    expect(parsed.some((r) => r.allocation_slice === 'holdout')).toBe(true);
    expect(parsed.some((r) => r.allocation_slice === 'bandit')).toBe(true);
  });

  it('segments and holdout slices equal segments.ts / launchdarkly.ts on every cohort user', () => {
    const cohort = loadFixtureCohort();
    const truthUsers = new Set(cohort.truth.map((t) => t.user_id));
    const expected = segmentsFromAmplitude(cohort.amplitudeEvents);
    const bad: string[] = [];
    let checked = 0;
    for (const u of users()) {
      const uid = String(u.user_id);
      if (!truthUsers.has(uid)) continue;
      const seg = expected.get(uid);
      checked += 1;
      const slice = isHoldoutUser(uid) ? 'holdout' : 'bandit';
      if (!seg || seg.country_bucket !== u.country_bucket || seg.device !== u.device || seg.acquisition_channel !== u.acquisition_channel || slice !== u.allocation_slice) {
        bad.push(`${uid}: warehouse ${JSON.stringify([u.country_bucket, u.device, u.acquisition_channel, u.allocation_slice])} allocator ${JSON.stringify(seg ? [seg.country_bucket, seg.device, seg.acquisition_channel, slice] : null)}`);
      }
      if (bad.length >= 10) break;
    }
    expect(bad).toEqual([]);
    expect(checked).toBe(2 * truthUsers.size);
  });

  it('first-exposure counts per day x flag x arm x segment x slice equal the allocator\'s own cohort functions', () => {
    const cohort = loadFixtureCohort();
    const segments = segmentsFromAmplitude(cohort.amplitudeEvents);
    const key = (r: Row) => [r.exposure_date, r.flag_key, r.arm, r.country_bucket, r.device, r.acquisition_channel, r.allocation_slice].join('|');
    const expectedCounts = new Map<string, number>();
    for (const e of exposuresFromCohort(cohort)) {
      const seg = segments.get(e.user_id);
      if (!seg) continue;
      const k = key({ exposure_date: e.first_exposed_at.slice(0, 10), flag_key: e.flag_key, arm: e.arm, ...seg, allocation_slice: isHoldoutUser(e.user_id) ? 'holdout' : 'bandit' });
      expectedCounts.set(k, (expectedCounts.get(k) ?? 0) + 1);
    }
    const truthUsers = new Set(cohort.truth.map((t) => t.user_id));
    const got = new Map<string, number>();
    for (const u of users()) {
      if (!truthUsers.has(String(u.user_id))) continue;
      got.set(key(u), (got.get(key(u)) ?? 0) + 1);
    }
    expect(got.size).toBe(expectedCounts.size);
    const diffs = [...expectedCounts].filter(([k, n]) => got.get(k) !== n).slice(0, 5);
    expect(diffs).toEqual([]);
  });

  it('the optional column groups the allocator knows (matured, guardrail, covariate) pass its schema too', () => {
    const full = readJsonl<Row>(join(EXPORT_DIR, 'experiment_profit_by_arm_daily_full.jsonl'));
    const optional = (OPTIONAL_EXPERIMENT_COLUMNS as readonly string[] | undefined) ?? [];
    const known = [...EXPERIMENT_PROFIT_BY_ARM_COLUMNS, ...optional.filter((c) => c in full[0]!)];
    expect(optional.filter((c) => c in full[0]!).length).toBe(optional.length);
    const parsed = parseExperimentProfitRows(full.map((r) => Object.fromEntries(known.map((c) => [c, r[c]]))));
    expect(parsed.length).toBe(full.length);
  });

  it('every non-QA exposure is a readout member in its first-exposed arm (no post-treatment filter)', () => {
    const rows = users();
    const qa = new Set(readCsv(join(WAREHOUSE, 'seeds', 'qa_accounts.csv')).map((r) => r.user_id));
    const exposures = readJsonl<Row>(join(EXPORT_DIR, 'experiment_exposures.jsonl'));
    const nonQa = exposures.filter((e) => !qa.has(String(e.user_id)));
    expect(rows.length).toBe(nonQa.length);
    const armOf = new Map(exposures.map((e) => [`${String(e.user_id)}|${String(e.flag_key)}`, e.arm]));
    for (const r of rows) expect(r.arm).toBe(armOf.get(`${String(r.user_id)}|${String(r.flag_key)}`));
  });
});
