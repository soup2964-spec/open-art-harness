import { AudienceMemberSchema, CONSENT_REQUIRED_REGIONS } from '@openart-signal/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidatesFromCohort, loadFixtureCohort } from '../src/cohort-candidates.js';
import { parseAudienceSyncConfig, parseSnapshot, planAudienceSync, renderPlanReport, snapshotKey, snapshotRows, type AudienceSyncConfig } from '../src/plan.js';
import { parseAudienceCandidates, type AudienceCandidateRow } from '../src/types.js';

const CONFIG: AudienceSyncConfig = parseAudienceSyncConfig(JSON.parse(readFileSync(new URL('../fixtures/audience.config.json', import.meta.url), 'utf8')));
const GRANTED = { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted', region: 'US', source: 'regional_default' } as const;

function user(i: number, over: Partial<AudienceCandidateRow> = {}): AudienceCandidateRow {
  return {
    user_id: `SynthP${String(i).padStart(5, '0')}`,
    email: `p${i}@example.test`,
    phone_e164: null,
    country: 'US',
    computed_at: '2026-09-29T06:00:00Z',
    predicted_profit: (i % 10) - 3, // 60% positive
    model_version: 'test',
    is_active_subscriber: i % 7 === 0,
    has_refund: false,
    has_chargeback: false,
    is_fraud: false,
    consent: { ...GRANTED },
    ...over,
  };
}

const population = Array.from({ length: 2000 }, (_, i) => user(i));
const T1 = '2026-09-29T07:00:00Z';
const T2 = '2026-09-30T07:00:00Z';

describe('planAudienceSync: first sync', () => {
  const plan = planAudienceSync({ candidates: population, previous: new Map(), config: CONFIG, computedAt: T1 });
  const list = (p: string, l: string) => plan.lists.find((x) => x.platform === p && x.listName === l)!;

  it('adds every member of every list that clears the platform minimum', () => {
    const g = list('google_ads', 'oa_seed_positive_predicted_profit');
    expect(g.previous).toBe(0);
    expect(g.adds).toBe(g.current);
    expect(g.sentAdds).toBe(g.current);
    expect(g.current).toBe(1200); // 6 of every 10 users have positive predicted profit
    expect(plan.requests.some((r) => r.id === 'google_ads/oa_seed_positive_predicted_profit/ingest-1')).toBe(true);
  });

  it('holds lists below the minimum (TikTok needs 1,000) and keeps them out of the next snapshot', () => {
    const t = list('tiktok', 'oa_excl_active_subscribers'); // ~286 users
    expect(t.held).toMatch(/< 1000/);
    expect(t.sentAdds).toBe(0);
    expect(plan.nextSnapshot.get(snapshotKey('tiktok', 'oa_excl_active_subscribers'))).toEqual([]);
    const created = list('tiktok', 'oa_seed_positive_predicted_profit');
    expect(created.sentAdds).toBe(1200);
    expect(plan.requests.find((r) => r.id === 'tiktok/oa_seed_positive_predicted_profit/create')).toBeDefined();
  });

  it('emits only contract-valid change rows and a snapshot that round-trips', () => {
    for (const m of plan.changes) expect(AudienceMemberSchema.safeParse(m).success).toBe(true);
    const rows = snapshotRows(plan.nextSnapshot);
    expect(parseSnapshot(JSON.parse(JSON.stringify(rows)) as unknown[]).get(snapshotKey('meta', 'oa_seed_positive_predicted_profit'))!.length).toBe(1200);
  });

  it('renders a dry-run report', () => {
    const report = renderPlanReport(plan);
    expect(report).toMatch(/DRY RUN/);
    expect(report).toMatch(/oa_seed_top_decile_predicted_profit/);
  });
});

describe('planAudienceSync: incremental sync from the previous snapshot', () => {
  const first = planAudienceSync({ candidates: population, previous: new Map(), config: CONFIG, computedAt: T1 });
  const changed = population
    .filter((u) => u.user_id !== 'SynthP00005') // deleted account
    .map((u) => {
      if (u.user_id === 'SynthP00004') return { ...u, consent: { ...u.consent, ad_personalization: 'denied' as const } }; // withdrew consent
      if (u.user_id === 'SynthP00006') return { ...u, predicted_profit: -50 }; // no longer profitable
      if (u.user_id === 'SynthP00008') return { ...u, email: 'new.p8@example.test' }; // changed email
      return u;
    });
  const second = planAudienceSync({ candidates: changed, previous: first.nextSnapshot, config: CONFIG, computedAt: T2 });
  const list = (p: string, l: string) => second.lists.find((x) => x.platform === p && x.listName === l)!;

  it('labels every removal with why the member left', () => {
    expect(list('google_ads', 'oa_seed_positive_predicted_profit').removalReasons).toEqual({
      consent_withdrawn: 1,
      no_longer_a_candidate: 1,
      no_longer_qualifies: 1,
      identifier_changed: 1,
    });
    // Meta keeps the same EXTERN_ID for user 8 but the EMAIL hash changed, so the member key changed too.
    expect(list('meta', 'oa_seed_positive_predicted_profit').removalReasons.identifier_changed).toBe(1);
  });

  it('sends removals with the identifiers uploaded before', () => {
    const removed = second.changes.filter((m) => m.action === 'remove' && m.platform === 'google_ads' && m.list_name === 'oa_seed_positive_predicted_profit');
    const before = new Map(first.nextSnapshot.get(snapshotKey('google_ads', 'oa_seed_positive_predicted_profit'))!.map((m) => [m.user_id, m.identifiers]));
    for (const m of removed) expect(m.identifiers).toEqual(before.get(m.user_id));
    expect(second.requests.some((r) => r.id === 'google_ads/oa_seed_positive_predicted_profit/remove-1')).toBe(true);
  });

  it('moves a user whose profit turned negative into the low-profit suppression list', () => {
    const low = second.changes.filter((m) => m.list_name === 'oa_excl_low_predicted_profit' && m.action === 'add' && m.platform === 'meta').map((m) => m.user_id);
    expect(low).toEqual(['SynthP00006']);
  });

  it('retries adds that were held last time once the list clears the minimum', () => {
    const small = population.slice(0, 500); // 300 positive users: fine for Google, too small for TikTok
    const a = planAudienceSync({ candidates: small, previous: new Map(), config: CONFIG, computedAt: T1 });
    expect(a.lists.find((x) => x.platform === 'tiktok' && x.listName === 'oa_seed_positive_predicted_profit')!.held).toMatch(/< 1000/);
    const b = planAudienceSync({ candidates: population, previous: a.nextSnapshot, config: CONFIG, computedAt: T2 });
    const t = b.lists.find((x) => x.platform === 'tiktok' && x.listName === 'oa_seed_positive_predicted_profit')!;
    expect(t.previous).toBe(0);
    expect(t.sentAdds).toBe(1200);
  });

  it('skips disabled platforms entirely', () => {
    const plan = planAudienceSync({ candidates: population, previous: new Map(), config: { ...CONFIG, tiktok: { ...CONFIG.tiktok!, enabled: false } }, computedAt: T1 });
    expect(plan.requests.some((r) => r.platform === 'tiktok')).toBe(false);
    expect(plan.lists.some((l) => l.platform === 'tiktok')).toBe(false);
  });
});

describe('finding 8: a changed predicted-profit value is re-uploaded to value-based lists', () => {
  const first = planAudienceSync({ candidates: population, previous: new Map(), config: CONFIG, computedAt: T1 });
  // User 9 (profit 6 -> 60) moves several value buckets; user 19 (6 -> 6.1) stays in its bucket.
  const repriced = population.map((u) => (u.user_id === 'SynthP00009' ? { ...u, predicted_profit: 60 } : u.user_id === 'SynthP00019' ? { ...u, predicted_profit: 6.1 } : u));
  const second = planAudienceSync({ candidates: repriced, previous: first.nextSnapshot, config: CONFIG, computedAt: T2 });
  const list = (p: string, l: string) => second.lists.find((x) => x.platform === p && x.listName === l)!;

  it('Meta value-based seed: one update, sent as an add carrying the new LOOKALIKE_VALUE', () => {
    const meta = list('meta', 'oa_seed_positive_predicted_profit');
    expect(meta.updates).toBe(1);
    expect(meta.sentUpdates).toBe(1);
    expect(meta.adds).toBe(0);
    const req = second.requests.find((r) => r.id === 'meta/oa_seed_positive_predicted_profit/add-1')!;
    const payload = JSON.parse(req.form!.payload!) as { schema: string[]; data: unknown[][] };
    expect(payload.schema).toContain('LOOKALIKE_VALUE');
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]![3]).toBe(60);
    const change = second.changes.find((m) => m.platform === 'meta' && m.list_name === 'oa_seed_positive_predicted_profit')!;
    expect(change.reason).toBe('value_changed');
    // The next snapshot holds the new value, so the following run does not re-upload it again.
    const stored = second.nextSnapshot.get(snapshotKey('meta', 'oa_seed_positive_predicted_profit'))!.find((m) => m.user_id === 'SynthP00009')!;
    expect(stored.value).toBe(60);
  });

  it('platforms that do not store the value are not re-uploaded', () => {
    expect(list('google_ads', 'oa_seed_positive_predicted_profit').updates).toBe(0);
    expect(second.requests.some((r) => r.platform === 'google_ads' && r.listName === 'oa_seed_positive_predicted_profit')).toBe(false);
  });
});

describe('finding 9: a TikTok audience deleted to honour removals', () => {
  const LIST = 'oa_seed_positive_predicted_profit';
  const withId = (id: string | null): AudienceSyncConfig => ({ ...CONFIG, tiktok: { ...CONFIG.tiktok!, audienceIds: { ...CONFIG.tiktok!.audienceIds, [LIST]: id } } });
  const created = planAudienceSync({ candidates: population, previous: new Map(), config: withId(null), computedAt: T1 });
  // 250 of the 1,200 members stop qualifying: 950 < 1,000, so REMOVE would fail and the audience is deleted.
  const shrunk = population.map((u, i) => (i < 420 && (u.predicted_profit ?? 0) > 0 ? { ...u, predicted_profit: -1 } : u));
  const deleted = planAudienceSync({ candidates: shrunk, previous: created.nextSnapshot, config: withId('1790000000000000001'), computedAt: T2 });

  it('records every member the delete took off the platform in the change log, survivors included', () => {
    const t = deleted.lists.find((l) => l.platform === 'tiktok' && l.listName === LIST)!;
    expect(t.deleted).toBe(true);
    const removed = deleted.changes.filter((m) => m.platform === 'tiktok' && m.list_name === LIST && m.action === 'remove');
    expect(removed.length).toBe(1200);
    expect(removed.filter((m) => m.reason === 'audience_deleted').length).toBe(t.current);
    expect(deleted.nextSnapshot.get(snapshotKey('tiktok', LIST))).toEqual([]);
    for (const m of removed) expect(AudienceMemberSchema.safeParse(m).success).toBe(true);
  });

  it('clears the deleted audience id, so the next sync recreates the audience instead of updating a deleted one', () => {
    expect(created.nextAudienceIds.tiktok[LIST]).toBe(`{{tiktok/${LIST}/create.data.custom_audience_id}}`);
    expect(deleted.nextAudienceIds.tiktok[LIST]).toBeNull();
    // Back above 1,000 with the stale id from the config file: the override wins.
    const regrown = planAudienceSync({ candidates: population, previous: deleted.nextSnapshot, config: withId('1790000000000000001'), audienceIds: deleted.nextAudienceIds, computedAt: '2026-10-01T07:00:00Z' });
    const ops = regrown.requests.filter((r) => r.platform === 'tiktok' && r.listName === LIST).map((r) => r.operation);
    expect(ops).toEqual(['upload_file', 'create']);
  });
});

describe('candidates from the 2,000-user contracts cohort (ILLUSTRATIVE)', () => {
  const cohort = loadFixtureCohort();

  it('builds valid fct_audience_candidates rows whose flags agree with the ground truth', () => {
    const rows = parseAudienceCandidates(candidatesFromCohort(cohort, { consent: 'illustrative_cmp', computedAt: cohort.simulationEnd }));
    expect(rows.length).toBe(2000);
    const truth = new Map(cohort.truth.map((t) => [t.user_id, t]));
    for (const r of rows) {
      const t = truth.get(r.user_id)!;
      expect(r.is_active_subscriber).toBe(t.converted && t.ended_at === null);
      if (t.end_reason === 'refund') expect(r.has_refund).toBe(true);
      if (t.end_reason === 'chargeback') expect(r.has_chargeback && r.is_fraud).toBe(true);
      if (r.consent.region && CONSENT_REQUIRED_REGIONS.has(r.consent.region)) expect(r.consent.source).toBe('cmp');
    }
  });

  it('today (no CMP): EEA/UK/CH users are never uploadable; elsewhere users pass by default, with the missing opt-out signal reported', () => {
    const rows = candidatesFromCohort(cohort, { consent: 'today_no_cmp', computedAt: cohort.simulationEnd });
    const plan = planAudienceSync({ candidates: rows, previous: new Map(), config: CONFIG, computedAt: cohort.simulationEnd });
    const required = rows.filter((r) => CONSENT_REQUIRED_REGIONS.has(r.country!)).length;
    expect(required).toBeGreaterThan(0);
    expect(plan.selection.consentIneligibleByReason).toEqual({ consent_required_needs_cmp_grant: required });
    expect(plan.selection.consentEligible).toBe(2000 - required);
    expect(plan.selection.defaultEligibleWithoutOptOutSignal).toBe(2000 - required);
    for (const m of plan.changes) expect(CONSENT_REQUIRED_REGIONS.has(rows.find((r) => r.user_id === m.user_id)!.country!)).toBe(false);
    expect(renderPlanReport(plan)).toMatch(/no GPC or sale\/sharing opt-out recorded/);
  });

  it('with an (assumed) CMP the seeds and suppression lists fill, and small lists are held per platform', () => {
    const rows = candidatesFromCohort(cohort, { consent: 'illustrative_cmp', computedAt: cohort.simulationEnd });
    const plan = planAudienceSync({ candidates: rows, previous: new Map(), config: CONFIG, computedAt: cohort.simulationEnd });
    expect(plan.selection.consentEligible).toBeGreaterThan(1500);
    expect(plan.selection.usersPerList.seed_top_decile).toBeGreaterThan(0);
    expect(plan.selection.usersPerList.excl_active_subscribers).toBeGreaterThan(0);
    const tiktok = plan.lists.filter((l) => l.platform === 'tiktok');
    for (const l of tiktok) if (l.current < 1000) expect(l.sentAdds).toBe(0);
    for (const m of plan.changes) expect(AudienceMemberSchema.safeParse(m).success).toBe(true);
  });
});
