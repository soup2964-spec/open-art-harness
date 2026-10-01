import { AudienceMemberSchema } from '@openart-signal/contracts';
import { describe, expect, it } from 'vitest';
import { audienceMembers, LIST_DEFINITIONS, selectAudiences, topCount, type ListKind } from '../src/build.js';
import { diffMembers, valueBucket } from '../src/diff.js';
import { parseAudienceCandidates, type AudienceCandidateRow } from '../src/types.js';

const GRANTED = { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted', region: 'US', source: 'regional_default' } as const;

function user(i: number, over: Partial<AudienceCandidateRow> = {}): AudienceCandidateRow {
  return {
    user_id: `SynthA${String(i).padStart(4, '0')}`,
    email: `user${i}@example.test`,
    phone_e164: null,
    country: 'US',
    computed_at: '2026-09-29T06:00:00Z',
    predicted_profit: i - 20, // users 0..19 negative, 20 zero, 21+ positive
    model_version: 'test',
    is_active_subscriber: false,
    has_refund: false,
    has_chargeback: false,
    is_fraud: false,
    consent: { ...GRANTED },
    ...over,
  };
}

const OPTS = { topFraction: 0.1, lowPredictedProfitMaxUsd: 0 };
const ids = (rows: readonly AudienceCandidateRow[]) => rows.map((r) => r.user_id).sort();

describe('selectAudiences: seeds', () => {
  const users = Array.from({ length: 100 }, (_, i) => user(i));

  it('top decile = the 10% highest predicted profit (nearest rank, ties included), positive only', () => {
    const sel = selectAudiences(users, OPTS);
    // 100 scored users with profits -20..79: the 10th highest is 70.
    expect(sel.topDecileThreshold).toBe(70);
    expect(sel.members.seed_top_decile.length).toBe(10);
    expect(Math.min(...sel.members.seed_top_decile.map((u) => u.predicted_profit!))).toBe(70);
  });

  it('positive seed = predicted profit > 0', () => {
    const sel = selectAudiences(users, OPTS);
    expect(sel.members.seed_positive.length).toBe(79); // users 21..99
    expect(sel.members.seed_positive.every((u) => u.predicted_profit! > 0)).toBe(true);
  });

  it('never seeds fraud, chargeback or refunded users, even with top profit', () => {
    const tainted = [user(99, { is_fraud: true }), user(98, { has_chargeback: true }), user(97, { has_refund: true }), ...users.slice(0, 97)];
    const sel = selectAudiences(tainted, OPTS);
    const seeded = new Set([...sel.members.seed_top_decile, ...sel.members.seed_positive].map((u) => u.user_id));
    for (const id of ['SynthA0099', 'SynthA0098', 'SynthA0097']) expect(seeded.has(id)).toBe(false);
  });

  it('computes the decile over every scored user, before the consent filter (stable membership)', () => {
    const noConsent = users.map((u, i) => (i % 2 === 0 ? u : { ...u, consent: { ...u.consent, ad_personalization: 'denied' as const } }));
    const sel = selectAudiences(noConsent, OPTS);
    expect(sel.topDecileThreshold).toBe(selectAudiences(users, OPTS).topDecileThreshold);
    expect(sel.members.seed_top_decile.every((u) => Number(u.user_id.slice(-4)) % 2 === 0)).toBe(true);
  });

  it('never seeds a non-positive user even if the whole decile is <= 0', () => {
    const allNegative = Array.from({ length: 30 }, (_, i) => user(i, { predicted_profit: -1 - i }));
    const sel = selectAudiences(allNegative, OPTS);
    expect(sel.members.seed_top_decile).toEqual([]);
    expect(sel.members.seed_positive).toEqual([]);
  });

  it('ignores unscored users (predicted_profit null) for seeds and low-profit exclusions', () => {
    const sel = selectAudiences([user(50, { predicted_profit: null }), user(51, { predicted_profit: null, is_active_subscriber: true })], OPTS);
    expect(sel.scored).toBe(0);
    expect(sel.members.seed_positive).toEqual([]);
    expect(sel.members.excl_low_predicted_profit).toEqual([]);
    expect(ids(sel.members.excl_active_subscribers)).toEqual(['SynthA0051']);
  });
});

describe('selectAudiences: exclusions and consent', () => {
  const rows = [
    user(1, { is_active_subscriber: true, predicted_profit: 300 }),
    user(2, { is_fraud: true, predicted_profit: 10 }),
    user(3, { has_chargeback: true, predicted_profit: 10 }),
    user(4, { has_refund: true, predicted_profit: 10 }),
    user(5, { predicted_profit: -2.5 }),
    user(6, { predicted_profit: 0 }),
    user(7, { is_active_subscriber: true, consent: { ...GRANTED, ad_user_data: 'denied' } }),
    user(8, { country: 'DE', consent: { ...GRANTED, region: 'DE' } }), // regional default in the EEA: not enough
    user(9, { country: 'DE', has_refund: true, predicted_profit: 10, consent: { ...GRANTED, region: 'DE', source: 'cmp' } }),
  ];
  const sel = selectAudiences(rows, OPTS);

  it('builds the four suppression lists', () => {
    expect(ids(sel.members.excl_active_subscribers)).toEqual(['SynthA0001']);
    expect(ids(sel.members.excl_fraud_or_chargeback)).toEqual(['SynthA0002', 'SynthA0003']);
    expect(ids(sel.members.excl_refunded)).toEqual(['SynthA0004', 'SynthA0009']);
    expect(ids(sel.members.excl_low_predicted_profit)).toEqual(['SynthA0005']); // < 0; zero is not "low"
  });

  it('filters every list on consent and reports why users were dropped', () => {
    const everyone = Object.values(sel.members).flat().map((u) => u.user_id);
    expect(everyone).not.toContain('SynthA0007');
    expect(everyone).not.toContain('SynthA0008');
    expect(sel.consent.eligible).toBe(7);
    expect(sel.consent.ineligibleByReason).toEqual({ explicit_denial: 1, consent_required_needs_cmp_grant: 1 });
  });

  it('with no CMP (OpenArt today): EEA/UK/CH users are excluded, everyone else is eligible by default', () => {
    const today = rows.map((r) => ({ ...r, consent: { ad_storage: 'unknown', ad_user_data: 'unknown', ad_personalization: 'unknown', analytics_storage: 'unknown', region: null, source: 'none' } as const }));
    const s = selectAudiences(today, OPTS);
    const everyone = new Set(Object.values(s.members).flat().map((u) => u.user_id));
    expect(everyone.has('SynthA0008')).toBe(false); // DE
    expect(everyone.has('SynthA0009')).toBe(false); // DE
    expect(everyone.has('SynthA0001')).toBe(true); // US
    expect(s.consent.eligible).toBe(7);
    expect(s.consent.ineligibleByReason).toEqual({ consent_required_needs_cmp_grant: 2 });
    // Nobody's GPC / opt-out was recorded: the report must say opt-outs could not be honoured.
    expect(s.consent.defaultEligibleWithoutOptOutSignal).toBe(7);
  });

  it('a GPC signal or a sale/sharing opt-out removes the user from every list', () => {
    const optedOut = rows.map((r) => (r.user_id === 'SynthA0001' ? { ...r, consent: { ...r.consent, gpc: true } } : r));
    const s = selectAudiences(optedOut, OPTS);
    expect(Object.values(s.members).flat().some((u) => u.user_id === 'SynthA0001')).toBe(false);
    expect(s.consent.ineligibleByReason.opted_out_gpc_or_sale_sharing).toBe(1);
  });
});

describe('finding 9: the top-seed size uses exact decimal rounding (nearest rank)', () => {
  it('ceil(p x n) without float drift', () => {
    expect(Math.ceil(0.07 * 100)).toBe(8); // the drift this replaces
    expect(topCount(0.07, 100)).toBe(7);
    expect(topCount(0.07, 300)).toBe(21);
    expect(topCount(0.1, 100)).toBe(10);
    expect(topCount(0.1, 101)).toBe(11);
    expect(topCount(0.3, 10)).toBe(3);
    expect(topCount(0.29, 100)).toBe(29);
    expect(topCount(0.1, 5)).toBe(1);
    expect(topCount(1, 17)).toBe(17);
    expect(topCount(0.1, 0)).toBe(0);
    expect(topCount(0.123456789, 1_000_000_000)).toBe(123_456_789);
  });

  it('selects exactly 7 of 100 users for a 7% seed', () => {
    const users = Array.from({ length: 100 }, (_, i) => user(i + 21, { predicted_profit: 1000 - i }));
    const sel = selectAudiences(users, { topFraction: 0.07, lowPredictedProfitMaxUsd: 0 });
    expect(sel.members.seed_top_decile.length).toBe(7);
  });
});

describe('audienceMembers: canonical AudienceMember rows per platform', () => {
  const rows = [user(60, { phone_e164: '+14155550160' }), user(61, { email: null, phone_e164: null }), user(62, { email: 'bad-email' })];
  const sel = selectAudiences(rows, OPTS);

  it('emits contract-valid rows with per-platform identifiers, list names and reasons', () => {
    for (const platform of ['google_ads', 'meta', 'tiktok'] as const) {
      const out = audienceMembers(platform, sel, { computedAt: '2026-09-29T07:00:00Z' });
      for (const m of out.members) {
        const parsed = AudienceMemberSchema.safeParse(m);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(m.platform).toBe(platform);
        expect(m.action).toBe('add');
      }
    }
    const meta = audienceMembers('meta', sel, { computedAt: '2026-09-29T07:00:00Z' });
    // Meta still gets user 61 and 62 through EXTERN_ID (hashed uid) alone.
    expect(meta.members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit').length).toBe(3);
    const google = audienceMembers('google_ads', sel, { computedAt: '2026-09-29T07:00:00Z' });
    expect(google.members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit').length).toBe(1);
    expect(google.skippedNoIdentifier.seed_positive).toBe(2);
  });

  it('carries predicted profit as the (non-negative) seed value and null on suppression lists', () => {
    const meta = audienceMembers('meta', sel, { computedAt: '2026-09-29T07:00:00Z' }).members;
    const seed = meta.find((m) => m.list_name === 'oa_seed_positive_predicted_profit' && m.user_id === 'SynthA0060')!;
    expect(seed.value).toBe(40);
    const kinds = new Map<string, (typeof LIST_DEFINITIONS)[number]>(LIST_DEFINITIONS.map((d) => [d.list_name, d]));
    for (const m of meta) if (kinds.get(m.list_name)!.role === 'exclusion') expect(m.value).toBeNull();
  });

  it('restricts identifiers to what the destination list is keyed on', () => {
    const tiktok = audienceMembers('tiktok', sel, { computedAt: '2026-09-29T07:00:00Z', keys: ['email_sha256'] }).members;
    for (const m of tiktok) expect(Object.keys(m.identifiers)).toEqual(['email_sha256']);
  });
});

describe('diffMembers (removals come from the previous snapshot)', () => {
  const at = '2026-09-29T07:00:00Z';
  const rows = Array.from({ length: 5 }, (_, i) => user(40 + i));
  const before = audienceMembers('meta', selectAudiences(rows, OPTS), { computedAt: '2026-09-28T07:00:00Z' }).members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit');

  it('first sync: everything is an add', () => {
    const d = diffMembers([], before, at);
    expect(d.adds.length).toBe(5);
    expect(d.removes).toEqual([]);
  });

  it('identical membership: no operations', () => {
    const d = diffMembers(before, before, at);
    expect(d.adds).toEqual([]);
    expect(d.removes).toEqual([]);
    expect(d.unchanged).toBe(5);
  });

  it('a user who withdraws consent is removed with the identifiers that were uploaded', () => {
    const withdrawn = rows.map((r, i) => (i === 2 ? { ...r, consent: { ...r.consent, ad_personalization: 'denied' as const } } : r));
    const after = audienceMembers('meta', selectAudiences(withdrawn, OPTS), { computedAt: at }).members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit');
    const d = diffMembers(before, after, at, { reasonFor: () => 'consent_withdrawn' });
    expect(d.adds).toEqual([]);
    expect(d.removes.length).toBe(1);
    expect(d.removes[0]!.action).toBe('remove');
    expect(d.removes[0]!.reason).toBe('consent_withdrawn');
    expect(d.removes[0]!.identifiers).toEqual(before[2]!.identifiers);
    expect(d.removes[0]!.computed_at).toBe(at);
    expect(AudienceMemberSchema.safeParse(d.removes[0]).success).toBe(true);
  });

  it('a changed email removes the old hash and adds the new one', () => {
    const changed = rows.map((r, i) => (i === 0 ? { ...r, email: 'new.address@example.test' } : r));
    const after = audienceMembers('meta', selectAudiences(changed, OPTS), { computedAt: at }).members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit');
    const d = diffMembers(before, after, at);
    expect(d.adds.length).toBe(1);
    expect(d.removes.length).toBe(1);
    expect(d.adds[0]!.user_id).toBe(d.removes[0]!.user_id);
  });

  it('rejects snapshots that mix lists or platforms', () => {
    const google = audienceMembers('google_ads', selectAudiences(rows, OPTS), { computedAt: at }).members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit');
    expect(() => diffMembers(before, google, at)).toThrow(/one platform and list/);
  });
});

describe('finding 8: diff on (identifiers, value bucket) so a changed value is re-uploaded', () => {
  const at = '2026-09-29T07:00:00Z';
  const rows = Array.from({ length: 5 }, (_, i) => user(60 + i)); // profits 40..44
  const seed = (rs: AudienceCandidateRow[]) =>
    audienceMembers('meta', selectAudiences(rs, OPTS), { computedAt: at }).members.filter((m) => m.list_name === 'oa_seed_positive_predicted_profit');
  const before = seed(rows);

  it('buckets values on a relative (20%) scale', () => {
    expect(valueBucket(40)).toBe(valueBucket(41));
    expect(valueBucket(40)).not.toBe(valueBucket(80));
    expect(valueBucket(null)).toBe('none');
    expect(valueBucket(0)).toBe('0');
  });

  it('a member whose value moved to another bucket is an update (re-uploaded with the new value); a small move is not', () => {
    const changed = rows.map((r) => (r.user_id === 'SynthA0060' ? { ...r, predicted_profit: 90 } : r.user_id === 'SynthA0061' ? { ...r, predicted_profit: 41.5 } : r));
    const d = diffMembers(before, seed(changed), at, { valueBucket });
    expect(d.adds).toEqual([]);
    expect(d.removes).toEqual([]);
    expect(d.updates.map((m) => m.user_id)).toEqual(['SynthA0060']);
    expect(d.updates[0]!.value).toBe(90);
    expect(d.updates[0]!.action).toBe('add');
    expect(d.updates[0]!.reason).toBe('value_changed');
    expect(AudienceMemberSchema.safeParse(d.updates[0]).success).toBe(true);
    expect(d.unchanged).toBe(4);
  });

  it('lists that carry no value ignore value changes (no bucket function)', () => {
    const changed = rows.map((r) => (r.user_id === 'SynthA0060' ? { ...r, predicted_profit: 90 } : r));
    expect(diffMembers(before, seed(changed), at).updates).toEqual([]);
  });
});

describe('input validation', () => {
  it('rejects malformed candidate rows and duplicate users', () => {
    expect(() => parseAudienceCandidates([{ ...user(1), country: 'Germany' }])).toThrow(/country/);
    expect(() => parseAudienceCandidates([{ ...user(1), consent: { ...GRANTED, ad_user_data: 'yes' } }])).toThrow(/consent/);
    expect(() => parseAudienceCandidates([user(1), user(1)])).toThrow(/duplicate/);
    expect(parseAudienceCandidates([user(1)]).length).toBe(1);
  });

  it('covers every list kind', () => {
    const kinds: ListKind[] = ['seed_top_decile', 'seed_positive', 'excl_active_subscribers', 'excl_fraud_or_chargeback', 'excl_refunded', 'excl_low_predicted_profit'];
    expect(LIST_DEFINITIONS.map((d) => d.kind)).toEqual(kinds);
  });
});
