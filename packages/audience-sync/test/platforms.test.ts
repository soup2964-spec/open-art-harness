import { createHash } from 'node:crypto';
import type { AudienceMember } from '@openart-signal/contracts';
import { describe, expect, it } from 'vitest';
import { googleRequests, GOOGLE_LIMITS, type GoogleConfig } from '../src/platforms/google.js';
import { metaRequests, metaSessionId, META_LIMITS, type MetaConfig } from '../src/platforms/meta.js';
import { tiktokRequests, TIKTOK_LIMITS, type TikTokConfig } from '../src/platforms/tiktok.js';

const hex = (i: number, salt = 'e') => createHash('sha256').update(`${salt}${i}`).digest('hex');

function members(platform: AudienceMember['platform'], list: string, n: number, opts: { phone?: boolean; extern?: boolean; value?: boolean; offset?: number } = {}): AudienceMember[] {
  return Array.from({ length: n }, (_, j) => {
    const i = j + (opts.offset ?? 0);
    return {
      platform,
      list_name: list,
      action: 'add',
      reason: 'positive_predicted_profit',
      identifiers: {
        email_sha256: hex(i),
        ...(opts.phone ? { phone_sha256: hex(i, 'p') } : {}),
        ...(opts.extern ? { external_id_sha256: hex(i, 'x') } : {}),
      },
      value: opts.value ? 10 + i : null,
      user_id: `SynthM${String(i).padStart(6, '0')}`,
      computed_at: '2026-09-29T07:00:00Z',
    };
  });
}
const asRemoves = (ms: AudienceMember[]) => ms.map((m) => ({ ...m, action: 'remove' as const, reason: 'left_list' }));

// ---------------------------------------------------------------------------
const GOOGLE: GoogleConfig = {
  operatingAccountId: '1234567890',
  loginAccountId: null,
  userListIds: { oa_seed_positive_predicted_profit: '9000000001' },
  validateOnly: true,
  minListSize: GOOGLE_LIMITS.minListSize,
  maxMembersPerRequest: GOOGLE_LIMITS.maxMembersPerRequest,
};

describe('Google Data Manager API (Customer Match)', () => {
  it('ingests in batches of at most 10,000 members with per-member consent, HEX encoding and accepted terms', () => {
    const adds = members('google_ads', 'oa_seed_positive_predicted_profit', 25_001, { phone: true });
    const { requests, held } = googleRequests({ listName: 'oa_seed_positive_predicted_profit', adds, removes: [], previousSize: 0, sizeAfter: 25_001, config: GOOGLE, runId: 'r1' });
    expect(held).toBeNull();
    expect(requests.map((r) => r.members)).toEqual([10_000, 10_000, 5_001]);
    const first = requests[0]!;
    expect(first.method).toBe('POST');
    expect(first.url).toBe('https://datamanager.googleapis.com/v1/audienceMembers:ingest');
    expect(first.headers.Authorization).toBe('Bearer <GOOGLE_OAUTH_ACCESS_TOKEN>');
    const body = first.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(body).sort()).toEqual(['audienceMembers', 'destinations', 'encoding', 'termsOfService', 'validateOnly']);
    expect(body.destinations).toEqual([{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' }, productDestinationId: '9000000001' }]);
    expect(body.encoding).toBe('HEX');
    expect(body.termsOfService).toEqual({ customerMatchTermsOfServiceStatus: 'ACCEPTED' });
    expect(body.validateOnly).toBe(true);
    expect(body.audienceMembers[0]).toEqual({
      userData: { userIdentifiers: [{ emailAddress: hex(0) }, { phoneNumber: hex(0, 'p') }] },
      consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
    });
  });

  it('removes with audienceMembers:remove (no consent, no terms), always, even below the minimum size', () => {
    const removes = asRemoves(members('google_ads', 'oa_seed_positive_predicted_profit', 3));
    const { requests } = googleRequests({ listName: 'oa_seed_positive_predicted_profit', adds: [], removes, previousSize: 50, sizeAfter: 47, config: GOOGLE, runId: 'r1' });
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe('https://datamanager.googleapis.com/v1/audienceMembers:remove');
    const body = requests[0]!.json as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['audienceMembers', 'destinations', 'encoding', 'validateOnly']);
  });

  it('holds the first upload of a list below 100 members (Customer Match targeting minimum)', () => {
    const adds = members('google_ads', 'oa_seed_positive_predicted_profit', 99);
    const { requests, held } = googleRequests({ listName: 'oa_seed_positive_predicted_profit', adds, removes: [], previousSize: 0, sizeAfter: 99, config: GOOGLE, runId: 'r1' });
    expect(requests).toEqual([]);
    expect(held).toMatch(/99 members < 100/);
  });

  it('rejects a non-numeric Google Ads account id (the API would fail the whole request)', () => {
    expect(() =>
      googleRequests({ listName: 'oa_seed_positive_predicted_profit', adds: members('google_ads', 'oa_seed_positive_predicted_profit', 200), removes: [], previousSize: 0, sizeAfter: 200, config: { ...GOOGLE, operatingAccountId: '123-456-7890' }, runId: 'r1' }),
    ).toThrow(/digits/);
  });
});

// ---------------------------------------------------------------------------
const META: MetaConfig = {
  apiVersion: 'v25.0',
  adAccountId: 'act_1234567890',
  audienceIds: { oa_seed_positive_predicted_profit: '23850000000000001', oa_excl_active_subscribers: '23850000000000002' },
  valueBasedLists: ['oa_seed_positive_predicted_profit'],
  schemaMode: 'multi_key',
  minListSize: META_LIMITS.minListSize,
  maxUsersPerRequest: META_LIMITS.maxUsersPerRequest,
};

describe('Meta Custom Audiences (customer list, /{audience_id}/users)', () => {
  it('POSTs multi-key payloads (EXTERN_ID, EMAIL, PHONE + LOOKALIKE_VALUE for value-based seeds) in 10,000-user sessions', () => {
    const adds = members('meta', 'oa_seed_positive_predicted_profit', 20_500, { extern: true, value: true });
    const { requests } = metaRequests({ listName: 'oa_seed_positive_predicted_profit', adds, removes: [], previousSize: 0, sizeAfter: 20_500, config: META, runId: 'r1' });
    expect(requests.map((r) => r.members)).toEqual([10_000, 10_000, 500]);
    const r0 = requests[0]!;
    expect(r0.method).toBe('POST');
    expect(r0.url).toBe('https://graph.facebook.com/v25.0/23850000000000001/users');
    expect(r0.form!.access_token).toBe('<META_ACCESS_TOKEN>');
    const payload = JSON.parse(r0.form!.payload!) as { schema: string[]; data: unknown[][] };
    expect(payload.schema).toEqual(['EXTERN_ID', 'EMAIL', 'PHONE', 'LOOKALIKE_VALUE']);
    // Unknown keys are left blank; hashes are lowercase hex; the value is non-negative.
    expect(payload.data[0]).toEqual([hex(0, 'x'), hex(0), '', 10]);
    const sessions = requests.map((r) => JSON.parse(r.form!.session!) as Record<string, unknown>);
    expect(sessions.map((s) => s.batch_seq)).toEqual([1, 2, 3]);
    expect(sessions.map((s) => s.last_batch_flag)).toEqual([false, false, true]);
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(1);
    expect(sessions[0]!.estimated_num_total).toBe(20_500);
    expect(Number.isSafeInteger(sessions[0]!.session_id) && (sessions[0]!.session_id as number) > 0).toBe(true);
  });

  it('removes with DELETE on the same endpoint and schema (no value column)', () => {
    const removes = asRemoves(members('meta', 'oa_seed_positive_predicted_profit', 2, { extern: true, value: true }));
    const { requests } = metaRequests({ listName: 'oa_seed_positive_predicted_profit', adds: [], removes, previousSize: 500, sizeAfter: 498, config: META, runId: 'r1' });
    expect(requests.length).toBe(1);
    expect(requests[0]!.method).toBe('DELETE');
    expect(JSON.parse(requests[0]!.form!.payload!).schema).toEqual(['EXTERN_ID', 'EMAIL', 'PHONE']);
  });

  it('supports the single-key EMAIL_SHA256 schema (members without email are skipped)', () => {
    const adds = [...members('meta', 'oa_excl_active_subscribers', 150), { ...members('meta', 'oa_excl_active_subscribers', 1, { extern: true, offset: 999 })[0]!, identifiers: { external_id_sha256: hex(1, 'x') } }];
    const { requests, skipped } = metaRequests({ listName: 'oa_excl_active_subscribers', adds, removes: [], previousSize: 0, sizeAfter: 151, config: { ...META, schemaMode: 'email_sha256' }, runId: 'r1' });
    const payload = JSON.parse(requests[0]!.form!.payload!) as { schema: string; data: string[] };
    expect(payload.schema).toBe('EMAIL_SHA256');
    expect(payload.data.length).toBe(150);
    expect(payload.data[0]).toBe(hex(0));
    expect(skipped).toBe(1);
  });

  it('holds a new list below 100 people and derives a stable positive session id', () => {
    const { requests, held } = metaRequests({ listName: 'oa_seed_positive_predicted_profit', adds: members('meta', 'oa_seed_positive_predicted_profit', 40, { extern: true }), removes: [], previousSize: 0, sizeAfter: 40, config: META, runId: 'r1' });
    expect(requests).toEqual([]);
    expect(held).toMatch(/40 people < 100/);
    expect(metaSessionId('act_1', 'aud', 'add', 'r1')).toBe(metaSessionId('act_1', 'aud', 'add', 'r1'));
    expect(metaSessionId('act_1', 'aud', 'add', 'r1')).not.toBe(metaSessionId('act_1', 'aud', 'remove', 'r1'));
  });
});

// ---------------------------------------------------------------------------
const TIKTOK: TikTokConfig = {
  advertiserId: '7670743239628161042',
  audienceIds: { oa_seed_positive_predicted_profit: '1790000000000000001', oa_seed_top_decile_predicted_profit: null },
  calculateType: 'EMAIL_SHA256',
  minAudienceSize: TIKTOK_LIMITS.minAudienceSize,
  maxLinesPerFile: 2_000_000,
  maxFilePathsPerCall: TIKTOK_LIMITS.maxFilePathsPerCall,
  retentionInDays: 180,
};

describe('TikTok customer-file audiences (file upload + create/update/delete)', () => {
  it('uploads one SHA-256 per line (no header) with an MD5 file signature, then APPENDs before REMOVing', () => {
    const adds = members('tiktok', 'oa_seed_positive_predicted_profit', 300);
    const removes = asRemoves(members('tiktok', 'oa_seed_positive_predicted_profit', 100, { offset: 5000 }));
    const { requests, held, deleted } = tiktokRequests({ listName: 'oa_seed_positive_predicted_profit', adds, removes, previousSize: 1500, sizeAfter: 1700, config: TIKTOK, runId: 'r1' });
    expect(held).toBeNull();
    expect(deleted).toBe(false);
    expect(requests.map((r) => r.operation)).toEqual(['upload_file', 'add', 'upload_file', 'remove']);
    const upload = requests[0]!;
    expect(upload.url).toBe('https://business-api.tiktok.com/open_api/v1.3/dmp/custom_audience/file/upload/');
    expect(upload.headers['Access-Token']).toBe('<TIKTOK_ACCESS_TOKEN>');
    expect(upload.form).toMatchObject({ advertiser_id: '7670743239628161042', calculate_type: 'EMAIL_SHA256' });
    const lines = upload.file!.content.trimEnd().split('\n');
    expect(lines.length).toBe(300);
    expect(lines[0]).toBe(hex(0));
    expect(upload.file!.md5).toBe(createHash('md5').update(upload.file!.content).digest('hex'));
    expect(upload.form!.file_signature).toBe(upload.file!.md5);
    expect(upload.file!.fileName).toMatch(/\.txt$/);
    const append = requests[1]!;
    expect(append.url).toBe('https://business-api.tiktok.com/open_api/v1.3/dmp/custom_audience/update/');
    // `action` defaults to REPLACE on TikTok's side, so it is always explicit.
    expect(append.json).toEqual({ advertiser_id: '7670743239628161042', custom_audience_id: '1790000000000000001', file_paths: [`{{${upload.id}.data.file_path}}`], action: 'APPEND' });
    expect(append.dependsOn).toEqual([upload.id]);
    expect((requests[3]!.json as { action: string }).action).toBe('REMOVE');
  });

  it('creates a new audience only from 1,000 entries, holding smaller lists', () => {
    const small = tiktokRequests({ listName: 'oa_seed_top_decile_predicted_profit', adds: members('tiktok', 'oa_seed_top_decile_predicted_profit', 999), removes: [], previousSize: 0, sizeAfter: 999, config: TIKTOK, runId: 'r1' });
    expect(small.requests).toEqual([]);
    expect(small.held).toMatch(/999 entries < 1000/);
    const big = tiktokRequests({ listName: 'oa_seed_top_decile_predicted_profit', adds: members('tiktok', 'oa_seed_top_decile_predicted_profit', 1000), removes: [], previousSize: 0, sizeAfter: 1000, config: TIKTOK, runId: 'r1' });
    expect(big.requests.map((r) => r.operation)).toEqual(['upload_file', 'create']);
    expect(big.requests[1]!.json).toEqual({
      advertiser_id: '7670743239628161042',
      custom_audience_name: 'oa_seed_top_decile_predicted_profit',
      file_paths: [`{{${big.requests[0]!.id}.data.file_path}}`],
      calculate_type: 'EMAIL_SHA256',
      retention_in_days: 180,
    });
  });

  it('honours removals that would leave fewer than 1,000 people by deleting the audience (REMOVE would fail)', () => {
    const removes = asRemoves(members('tiktok', 'oa_seed_positive_predicted_profit', 20));
    const r = tiktokRequests({ listName: 'oa_seed_positive_predicted_profit', adds: members('tiktok', 'oa_seed_positive_predicted_profit', 5, { offset: 7000 }), removes, previousSize: 1010, sizeAfter: 995, config: TIKTOK, runId: 'r1' });
    expect(r.deleted).toBe(true);
    expect(r.requests.map((x) => x.operation)).toEqual(['delete']);
    expect(r.requests[0]!.url).toBe('https://business-api.tiktok.com/open_api/v1.3/dmp/custom_audience/delete/');
    expect(r.requests[0]!.json).toEqual({ advertiser_id: '7670743239628161042', custom_audience_ids: ['1790000000000000001'] });
    expect(r.held).toMatch(/recreate/);
    // Finding 9: the deleted id must not linger, or the next sync would update a deleted audience.
    expect(r.audienceIdAfter).toBeNull();
  });

  it('reports the audience id each list has after the sync (unchanged, created, or none)', () => {
    const kept = tiktokRequests({ listName: 'oa_seed_positive_predicted_profit', adds: members('tiktok', 'oa_seed_positive_predicted_profit', 5), removes: [], previousSize: 2000, sizeAfter: 2005, config: TIKTOK, runId: 'r1' });
    expect(kept.audienceIdAfter).toBe('1790000000000000001');
    const created = tiktokRequests({ listName: 'oa_seed_top_decile_predicted_profit', adds: members('tiktok', 'oa_seed_top_decile_predicted_profit', 1000), removes: [], previousSize: 0, sizeAfter: 1000, config: TIKTOK, runId: 'r1' });
    expect(created.audienceIdAfter).toBe('{{tiktok/oa_seed_top_decile_predicted_profit/create.data.custom_audience_id}}');
    const held = tiktokRequests({ listName: 'oa_seed_top_decile_predicted_profit', adds: members('tiktok', 'oa_seed_top_decile_predicted_profit', 10), removes: [], previousSize: 0, sizeAfter: 10, config: TIKTOK, runId: 'r1' });
    expect(held.audienceIdAfter).toBeNull();
  });

  it('splits files by line count and update calls by 50 file paths', () => {
    const adds = members('tiktok', 'oa_seed_positive_predicted_profit', 520);
    const r = tiktokRequests({ listName: 'oa_seed_positive_predicted_profit', adds, removes: [], previousSize: 5000, sizeAfter: 5520, config: { ...TIKTOK, maxLinesPerFile: 10, maxFilePathsPerCall: 50 }, runId: 'r1' });
    const uploads = r.requests.filter((x) => x.operation === 'upload_file');
    const updates = r.requests.filter((x) => x.operation === 'add');
    expect(uploads.length).toBe(52);
    expect(updates.map((u) => (u.json as { file_paths: string[] }).file_paths.length)).toEqual([50, 2]);
    expect(uploads.reduce((s, u) => s + u.members, 0)).toBe(520);
  });
});
