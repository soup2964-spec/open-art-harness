import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadFixtureCohort } from '../src/cohort-candidates.js';
import { parseAudienceSyncConfig, planAudienceSync } from '../src/plan.js';
import { candidatesFromWarehouseRows } from '../src/warehouse-candidates.js';

/**
 * Rows copied from packages/warehouse `fct_audience_candidates` as materialised on 2026-09-30
 * from the contracts fixture cohort (one row per user and warehouse list; no contact columns).
 */
const ROWS = readFileSync(new URL('./fixtures/warehouse-fct_audience_candidates.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const CONTACTS = loadFixtureCohort().appUsers.map((u) => ({ user_id: u.id, email: u.email, phone_e164: null }));
const CONFIG = parseAudienceSyncConfig(JSON.parse(readFileSync(new URL('../fixtures/audience.config.json', import.meta.url), 'utf8')));
const USERS = new Set(ROWS.map((r) => r.user_id)).size;
const ALLOWED_USERS = new Set(ROWS.filter((r) => r.upload_allowed === true).map((r) => r.user_id)).size;

describe('adapter for the warehouse fct_audience_candidates mart (one row per user x list)', () => {
  it('collapses list rows to one user-grain candidate with flags, consent and contact data', () => {
    const { candidates } = candidatesFromWarehouseRows(ROWS, CONTACTS, { respectUploadAllowed: false });
    expect(candidates.length).toBe(USERS);
    // By default the warehouse's own gate (EEA/UK/CH without CMP consent, unknown region) applies too.
    expect(candidatesFromWarehouseRows(ROWS, CONTACTS).candidates.length).toBe(ALLOWED_USERS);
    expect(ALLOWED_USERS).toBeLessThan(USERS);
    const fraud = ROWS.find((r) => r.has_fraud_dispute === true);
    if (fraud) expect(candidates.find((c) => c.user_id === fraud.user_id)!.is_fraud).toBe(true);
    const payer = ROWS.find((r) => r.list_name === 'oa_paying_customers_suppress')!;
    expect(candidates.find((c) => c.user_id === payer.user_id)!.is_active_subscriber).toBe(true);
    for (const c of candidates) {
      expect(c.email).toMatch(/@example\.test$/);
      expect(c.computed_at).toBe('2026-09-28T00:00:00Z');
      expect(c.consent.source).toBe('none');
    }
  });

  it("cross-checks the warehouse's external_id_sha256 against audience-sync's own EXTERN_ID hashing", () => {
    expect(() => candidatesFromWarehouseRows(ROWS, CONTACTS)).not.toThrow();
    const tampered = ROWS.map((r, i) => (i === 0 ? { ...r, external_id_sha256: 'f'.repeat(64) } : r));
    expect(() => candidatesFromWarehouseRows(tampered, CONTACTS)).toThrow(/external_id_sha256/);
  });

  it('says what the list-grain mart cannot provide', () => {
    const { warnings } = candidatesFromWarehouseRows(ROWS, CONTACTS.slice(0, 5));
    expect(warnings.join(' ')).toMatch(/only users on at least one warehouse list/);
    expect(warnings.join(' ')).toMatch(/no email or phone/);
  });

  it('with the consent the mart carries today (unknown everywhere): the upload_allowed users are default-eligible, with the missing opt-out signal flagged', () => {
    const { candidates } = candidatesFromWarehouseRows(ROWS, CONTACTS);
    const plan = planAudienceSync({ candidates, previous: new Map(), config: CONFIG, computedAt: '2026-09-28T00:00:00Z' });
    expect(plan.selection.consentEligible).toBe(ALLOWED_USERS);
    expect(plan.selection.consentIneligibleByReason).toEqual({});
    expect(plan.selection.defaultEligibleWithoutOptOutSignal).toBe(ALLOWED_USERS);
    // 30 fixture users: every list is below the platform minimums, so nothing is sent yet.
    expect(plan.requests).toEqual([]);
  });

  it('passes GPC and the sale/sharing opt-out through to the consent gate', () => {
    const optedOut = ROWS.map((r) => (r.upload_allowed === true ? { ...r, gpc: true } : r));
    const { candidates } = candidatesFromWarehouseRows(optedOut, CONTACTS);
    expect(candidates.every((c) => c.consent.gpc === true)).toBe(true);
    const plan = planAudienceSync({ candidates, previous: new Map(), config: CONFIG, computedAt: '2026-09-28T00:00:00Z' });
    expect(plan.selection.consentEligible).toBe(0);
    expect(plan.selection.consentIneligibleByReason).toEqual({ opted_out_gpc_or_sale_sharing: ALLOWED_USERS });
  });

  it("applies the warehouse's upload_allowed gate on top of audience-sync's consent gate", () => {
    const granted: Array<Record<string, unknown>> = ROWS.map((r) => ({ ...r, ad_user_data: 'granted', ad_personalization: 'granted', consent_source: 'regional_default' }));
    const blockedByWarehouse = new Set(granted.filter((r) => r.upload_allowed === false).map((r) => r.user_id));
    const { candidates, excludedByUploadAllowed } = candidatesFromWarehouseRows(granted, CONTACTS);
    expect(excludedByUploadAllowed).toBe(blockedByWarehouse.size);
    expect(blockedByWarehouse.size).toBeGreaterThan(0); // EEA/UK/CH users without CMP consent
    const plan = planAudienceSync({ candidates, previous: new Map(), config: { ...CONFIG, google_ads: { ...CONFIG.google_ads!, minListSize: 1 }, meta: { ...CONFIG.meta!, minListSize: 1 } }, computedAt: '2026-09-28T00:00:00Z' });
    expect(plan.requests.length).toBeGreaterThan(0);
    for (const m of plan.changes) expect(blockedByWarehouse.has(m.user_id)).toBe(false);
  });

  it('rejects rows that disagree about the same user', () => {
    const first = ROWS[0]!;
    const twin = { ...first, list_name: 'oa_paying_customers_suppress', candidate_role: 'exclusion', reason: 'paying_customer_suppression', seed_value_usd: null };
    expect(() => candidatesFromWarehouseRows([...ROWS, twin], CONTACTS)).not.toThrow();
    expect(() => candidatesFromWarehouseRows([...ROWS, { ...twin, predicted_profit: 999 }], CONTACTS)).toThrow(/disagree/);
  });
});
