/**
 * The contracts package ships hand-written golden ConversionLedgerEvent rows
 * (fixtures/canonical/conversion_ledger_events.jsonl) for the scenario users whose raw Stripe,
 * ledger, Amplitude and HubSpot fixtures the warehouse loads. The warehouse must derive the same
 * rows from those raw sources.
 *
 * Compared EXACTLY (database review 6): ids, event names, times, lineage, money, Stripe ids, plan
 * fields, flags, generation, experiment arms, device_id, click_ids and utm. The golden rows were
 * written by hand and record fewer click ids / UTMs than the raw fixtures they sit next to carry;
 * each such difference is listed in KNOWN_GOLDEN_GAPS with its evidence, and anything else (a
 * missing key, a different value, an unlisted extra key) fails. device_id for U03/U04 comes from
 * the warehouse's SYNTHETIC page views (fixtures/scenario_users), since no contracts raw fixture
 * carries those devices.
 * Not compared, with reasons:
 *   consent.region  the golden rows default it to 'US' for HubSpot leads, which have no user and no
 *                   country; the warehouse leaves it NULL (unknown fails closed downstream)
 *   lead            contact id / lifecycle / lead_source need a HubSpot contacts table the fixtures
 *                   do not include; the fields that ARE derivable are compared below
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACTS_FIXTURES, EXPORT_DIR, exportAvailable, readJsonl } from './helpers.js';

type Row = Record<string, unknown>;

/**
 * Keys the warehouse knows from the raw fixtures but the hand-written golden rows omit. Every
 * entry is known before the event (created_at <= occurred_at), so the warehouse is right to send it.
 */
const KNOWN_GOLDEN_GAPS: Record<string, { click_ids?: string[]; utm?: string[]; evidence: string }> = {
  'checkout_0d01ae90-ee71-409f-ab0f-9e1a642e0dce': {
    click_ids: ['gbraid'],
    utm: ['utm_source', 'utm_medium', 'utm_campaign'],
    evidence: 'click_ids/extended_payloads.json[0] (U01): gbraid and UTMs captured 2026-06-02T14:57:40Z, before the checkout; the golden checkout row leaves utm blank',
  },
  purchase_in_1SynthU01Inv0001First: { click_ids: ['gbraid'], evidence: 'extended_payloads.json[0]: gbraid 0AAAAASYNTHgbraidU01 captured with the gclid' },
  purchase_in_1SynthU01Inv0002Cycle: { click_ids: ['gbraid'], evidence: 'extended_payloads.json[0]: gbraid 0AAAAASYNTHgbraidU01 captured with the gclid' },
  purchase_in_1SynthU03Inv0003Upgrade: { click_ids: ['fbclid', 'ttclid'], evidence: 'click_ids/current_payloads.json[1] (U03): fbclid 2026-06-14, ttclid 2026-06-13, before the purchase' },
  purchase_in_1SynthU03Inv0002AddOn: { click_ids: ['fbclid', 'ttclid'], evidence: 'click_ids/current_payloads.json[1] (U03): fbclid 2026-06-14, ttclid 2026-06-13, before the purchase' },
};

const EXACT = [
  'schema_version',
  'event_name',
  'occurred_at',
  'source_system',
  'source_event_id',
  'user_id',
  'order_id',
  'adjusts_event_id',
  'adjusts_order_id',
  'cash_value_minor',
  'currency',
  'invoice_id',
  'subscription_id',
  'checkout_session_id',
  'charge_id',
  'plan_tier',
  'plan_tier_code',
  'billing_interval',
  'previous_plan_tier',
  'credit_pack_quantity',
  'is_first_purchase',
  'is_business',
  'generation',
  'ga_client_id',
  'ga_session_id',
  'tolt_referral',
  'experiment_arms',
  'device_id',
] as const;

function isSubset(small: Record<string, unknown>, big: Record<string, unknown>): boolean {
  return Object.entries(small).every(([k, v]) => JSON.stringify(big[k]) === JSON.stringify(v));
}

describe.skipIf(!exportAvailable())('golden canonical rows are reproduced from raw fixtures', () => {
  const golden = readJsonl<Row>(join(CONTRACTS_FIXTURES, 'canonical', 'conversion_ledger_events.jsonl'));
  const warehouse = new Map(
    readJsonl<Row>(join(EXPORT_DIR, 'conversion_ledger_events.jsonl')).map((r) => [String(r.event_id), r]),
  );

  it('covers every golden row', () => {
    expect(golden.length).toBe(12);
    const missing = golden.filter((g) => !warehouse.has(String(g.event_id))).map((g) => g.event_id);
    expect(missing).toEqual([]);
  });

  it.each(golden.map((g) => [String(g.event_id), g] as const))('%s matches field by field', (eventId, g) => {
    const w = warehouse.get(eventId)!;
    const diffs = EXACT.filter((k) => JSON.stringify(w[k]) !== JSON.stringify(g[k])).map(
      (k) => `${k}: golden ${JSON.stringify(g[k])} != warehouse ${JSON.stringify(w[k])}`,
    );
    const gap = KNOWN_GOLDEN_GAPS[eventId];
    for (const field of ['click_ids', 'utm'] as const) {
      const allowed = new Set(gap?.[field] ?? []);
      const expected = g[field] as Row;
      const actual = w[field] as Row;
      // exact: every golden key equal, and every extra warehouse key listed as a known gap
      if (!isSubset(expected, actual)) diffs.push(`${field} ${JSON.stringify(expected)} not within ${JSON.stringify(actual)}`);
      const extra = Object.keys(actual).filter((k) => !(k in expected));
      if (extra.some((k) => !allowed.has(k))) diffs.push(`${field}: unlisted extra keys ${JSON.stringify(extra.filter((k) => !allowed.has(k)))}`);
      if ([...allowed].some((k) => !(k in actual))) diffs.push(`${field}: known gap ${JSON.stringify([...allowed])} no longer present, update KNOWN_GOLDEN_GAPS`);
    }
    const gc = g.consent as Row;
    const wc = w.consent as Row;
    for (const k of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage', 'source']) {
      if (gc[k] !== wc[k]) diffs.push(`consent.${k}: ${String(gc[k])} != ${String(wc[k])}`);
    }
    // region is derivable for every event with a user (the Amplitude country); leads have none
    if (g.user_id !== null && gc.region !== wc.region) diffs.push(`consent.region: ${String(gc.region)} != ${String(wc.region)}`);
    if (g.lead !== null) {
      const gl = g.lead as Row;
      const wl = w.lead as Row;
      const derivable = g.event_name === 'enterprise_lead'
        ? ['hubspot_portal_id', 'form_id', 'lead_source', 'lead_source_detail', 'company_size']
        : ['hubspot_portal_id', 'form_id', 'contact_id', 'lifecycle_stage', 'previous_lifecycle_stage'];
      for (const k of derivable) if (JSON.stringify(gl[k]) !== JSON.stringify(wl[k])) diffs.push(`lead.${k}: ${JSON.stringify(gl[k])} != ${JSON.stringify(wl[k])}`);
    } else if (w.lead !== null) {
      diffs.push('lead: golden null, warehouse not null');
    }
    expect(diffs).toEqual([]);
  });
});
