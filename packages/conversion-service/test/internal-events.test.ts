import { describe, expect, it } from 'vitest';
import { ConversionLedgerEventSchema } from '@openart-signal/contracts';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { HUBSPOT_CONTACTS, InternalEventMapper, parseInternalEventsBody } from '../src/ingest/internal-events.js';
import { sanitizeEventSourceUrl } from '../src/url.js';
import type { InternalEventEnvelope } from '../src/ingest/internal-events.js';
import { goldenLedgerRows, readJsonFixture, readJsonlFixture } from './helpers/fixtures.js';

const ledgerU05 = readJsonFixture<{ entries: unknown[] }>('credit_ledger/u05_observed_shape_trial_and_sdxl.json');
const amplitudeCheckout = readJsonlFixture<Record<string, unknown>>('amplitude/checkout_and_conversion_reported.jsonl');
const hubspotForms = readJsonFixture<unknown[]>('hubspot/enterprise_form_submissions.json');
const hubspotLifecycle = readJsonFixture<unknown[]>('hubspot/contact_lifecycle_changes.json');

/** The HubSpot contact the ad-click submission created (contracts scenarios: HUBSPOT_LEADS.adClick.contactId). */
const AD_CLICK_CONTACT_ID = '90000000001';

const CORE = [
  'event_id', 'event_name', 'occurred_at', 'source_system', 'source_event_id', 'user_id', 'order_id', 'cash_value_minor',
  'plan_tier', 'plan_tier_code', 'billing_interval', 'generation', 'lead',
] as const satisfies ReadonlyArray<keyof ConversionLedgerEvent>;
const core = (r: ConversionLedgerEvent) => Object.fromEntries(CORE.map((k) => [k, r[k]]));
const golden = (id: string) => goldenLedgerRows().find((g) => g.event_id === id)!;

async function mapAll(envelopes: InternalEventEnvelope[]) {
  const mapper = new InternalEventMapper(new InMemoryDocumentStore());
  const out = [];
  for (const env of envelopes) out.push(await mapper.map(env));
  return out;
}

describe('parseInternalEventsBody', () => {
  it('accepts one envelope or a batch, and rejects unknown kinds and extra keys', () => {
    const one = { kind: 'credit_ledger_entry', entry: ledgerU05.entries[1] };
    expect(parseInternalEventsBody(one).ok).toBe(true);
    expect(parseInternalEventsBody([one, one]).ok).toBe(true);
    expect(parseInternalEventsBody({ kind: 'nope' }).ok).toBe(false);
    expect(parseInternalEventsBody({ ...one, surprise: 1 }).ok).toBe(false);
    expect(parseInternalEventsBody(Array.from({ length: 101 }, () => one)).ok).toBe(false);
  });

  it('validates inner records against the contracts source schemas', () => {
    const bad = { kind: 'credit_ledger_entry', entry: { ...(ledgerU05.entries[1] as object), createdAt: 'yesterday' } };
    const parsed = parseInternalEventsBody(bad);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toMatch(/credit_ledger_entry/);
  });
});

describe('InternalEventMapper against the contracts fixtures', () => {
  it('trial ADD -> signup reg_<uid>; first CONSUME -> activation_<uid> (golden rows)', async () => {
    const [consume, add] = ledgerU05.entries;
    const results = await mapAll([
      { kind: 'credit_ledger_entry', entry: add as never },
      { kind: 'credit_ledger_entry', entry: consume as never },
    ]);
    const rows = results.flatMap((r) => (r.kind === 'rows' ? r.rows.map((n) => n.row) : []));
    expect(rows.map((r) => r.event_id)).toEqual(['reg_SynthU05FreeTrialE5x', 'activation_SynthU05FreeTrialE5x']);
    expect(core(rows[0]!)).toEqual(core(golden('reg_SynthU05FreeTrialE5x')));
    expect(core(rows[1]!)).toEqual(core(golden('activation_SynthU05FreeTrialE5x')));
  });

  it('Amplitude subscription_started -> checkout_started checkout_<uuid> (golden row)', async () => {
    const [r] = await mapAll([{ kind: 'amplitude_event', row: amplitudeCheckout[0] as never }]);
    expect(r!.kind).toBe('rows');
    const row = r!.kind === 'rows' ? r!.rows[0]!.row : null;
    expect(core(row!)).toEqual(core(golden('checkout_0d01ae90-ee71-409f-ab0f-9e1a642e0dce')));
    expect(row!.device_id).toBe('5b0c8f2e-1d4a-4c3b-9e7f-000000000001');
  });

  it('ignores Amplitude events that are not checkout intent', async () => {
    const [r] = await mapAll([{ kind: 'amplitude_event', row: amplitudeCheckout[1] as never }]);
    expect(r).toMatchObject({ kind: 'ignore', reason: 'amplitude_event_not_mapped:conversion_reported' });
  });

  it('backend checkout form -> checkout_started keyed on the Checkout Session id', async () => {
    const [r] = await mapAll([
      {
        kind: 'checkout_session_created',
        checkout: {
          user_id: 'SynthU01StarterMonA1',
          checkout_session_id: 'cs_live_a1SynthU01Checkout0001',
          tier: 1000,
          billing_interval: 'month',
          occurred_at: '2026-06-03T17:02:31Z',
          ga_client_id: 'GA1.1.111.222',
          ga_session_id: '1780505700',
          gclid: 'Cj0KCQjwSYNTHgclidU01',
          tolt_referral: null,
        },
      },
    ]);
    const row = r!.kind === 'rows' ? r!.rows[0]!.row : null;
    expect(row).toMatchObject({
      event_id: 'checkout_cs_live_a1SynthU01Checkout0001',
      event_name: 'checkout_started',
      source_system: 'app_backend',
      plan_tier: 'essential',
      plan_tier_code: 1000,
      billing_interval: 'month',
      ga_client_id: 'GA1.1.111.222',
      click_ids: { gclid: { value: 'Cj0KCQjwSYNTHgclidU01', created_at: null } },
    });
  });

  it('HubSpot form -> enterprise_lead; SQL change -> lead_stage_change with state from the form and the MQL change (golden rows)', async () => {
    const [mql, sql] = hubspotLifecycle;
    const results = await mapAll([
      { kind: 'hubspot_form_submission', submission: hubspotForms[0] as never, contact_id: AD_CLICK_CONTACT_ID },
      { kind: 'hubspot_contact_property_change', change: mql as never },
      { kind: 'hubspot_contact_property_change', change: sql as never },
    ]);
    expect(results.map((r) => r.kind)).toEqual(['rows', 'state', 'rows']);
    const lead = results[0]!.kind === 'rows' ? results[0]!.rows[0]! : null;
    const stage = results[2]!.kind === 'rows' ? results[2]!.rows[0]! : null;
    expect(core(lead!.row)).toEqual(core(golden('lead_6f1d2c3b-0000-4000-8000-00000000a001')));
    expect(lead!.row.click_ids).toEqual({ gclid: { value: 'Cj0KCQjwSYNTHgclidLEAD1', created_at: null } });
    expect(lead!.identity.email).toBe('lead.one@synthetic-brand.example.test');
    expect(core(stage!.row)).toEqual(core(golden('leadstage_90000000001_salesqualifiedlead')));
    // The SQL row reuses the form's identity (hashed at form time) and the lead's gclid.
    expect(stage!.hashedIdentity?.email.google_ads).toMatch(/^[0-9a-f]{64}$/);
    expect(stage!.row.click_ids.gclid?.value).toBe('Cj0KCQjwSYNTHgclidLEAD1');
  });

  it('an older lifecycle change arriving late does not rewind the contact stage', async () => {
    const [mql, sql] = hubspotLifecycle;
    const store = new InMemoryDocumentStore();
    const mapper = new InternalEventMapper(store);
    await mapper.map({ kind: 'hubspot_contact_property_change', change: sql as never });
    await mapper.map({ kind: 'hubspot_contact_property_change', change: mql as never });
    const state = await store.get<{ lifecycle_stage: string }>('hubspot_contacts', AD_CLICK_CONTACT_ID);
    expect(state?.data.lifecycle_stage).toBe('salesqualifiedlead');
  });

  it('every mapped row passes the contracts validator', async () => {
    const [consume, add] = ledgerU05.entries;
    const [mql, sql] = hubspotLifecycle;
    const results = await mapAll([
      { kind: 'credit_ledger_entry', entry: add as never },
      { kind: 'credit_ledger_entry', entry: consume as never },
      { kind: 'amplitude_event', row: amplitudeCheckout[0] as never },
      { kind: 'hubspot_form_submission', submission: hubspotForms[0] as never, contact_id: AD_CLICK_CONTACT_ID },
      { kind: 'hubspot_form_submission', submission: hubspotForms[1] as never },
      { kind: 'hubspot_contact_property_change', change: mql as never },
      { kind: 'hubspot_contact_property_change', change: sql as never },
    ]);
    for (const r of results) {
      if (r.kind !== 'rows') continue;
      for (const n of r.rows) {
        const parsed = ConversionLedgerEventSchema.safeParse(n.row);
        expect(parsed.success, `${n.row.event_id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }
  });

  it('carries backend request context (consent, device, UA/IP, cookies) without putting PII in the row', async () => {
    const [, add] = ledgerU05.entries;
    const [r] = await mapAll([
      {
        kind: 'credit_ledger_entry',
        entry: add as never,
        context: {
          email: 'synth.u05@example.test',
          device_id: '5b0c8f2e-1d4a-4c3b-9e7f-000000000005',
          client_ip_address: '203.0.113.5',
          client_user_agent: 'Mozilla/5.0 (Synthetic)',
          fbp: 'fb.1.1782900000000.1234567890',
          consent: { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied', analytics_storage: 'granted', region: 'DE', source: 'cmp' },
        },
      },
    ]);
    const n = r!.kind === 'rows' ? r!.rows[0]! : null;
    expect(n!.row.device_id).toBe('5b0c8f2e-1d4a-4c3b-9e7f-000000000005');
    expect(n!.row.consent).toMatchObject({ region: 'DE', source: 'cmp', ad_personalization: 'denied' });
    expect(n!.consentFromSource).toBe(true);
    expect(n!.context).toMatchObject({ client_ip_address: '203.0.113.5', fbp: 'fb.1.1782900000000.1234567890' });
    expect(JSON.stringify(n!.row)).not.toMatch(/synth\.u05|203\.0\.113\.5|Mozilla/);
  });

  it('event_source_url: https only; query string, fragment and credentials are stripped (the success URL carries uid=)', async () => {
    const [, add] = ledgerU05.entries;
    const map = async (url: string) => {
      const [r] = await mapAll([{ kind: 'credit_ledger_entry', entry: add as never, context: { event_source_url: url } }]);
      return r!.kind === 'rows' ? r!.rows[0]!.context.event_source_url : undefined;
    };
    expect(await map('https://openart.ai/suite/subscriptions?uid=SynthU05FreeTrialE5x&session_id=cs_live_x#done')).toBe('https://openart.ai/suite/subscriptions');
    expect(await map('http://openart.ai/suite/subscriptions')).toBeUndefined();
    expect(await map('https://user:pass@openart.ai/pricing')).toBe('https://openart.ai/pricing');
    expect(sanitizeEventSourceUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeEventSourceUrl('not a url')).toBeNull();
    expect(sanitizeEventSourceUrl(null)).toBeNull();
  });

  it('HubSpot contact state carries a TTL refreshed on every write', async () => {
    const store = new InMemoryDocumentStore();
    const now = Date.parse('2026-09-24T15:00:00Z');
    const mapper = new InternalEventMapper(store, {}, () => now);
    await mapper.map({ kind: 'hubspot_form_submission', submission: hubspotForms[0] as never, contact_id: AD_CLICK_CONTACT_ID });
    const doc = store.dump<{ expire_at: string }>(HUBSPOT_CONTACTS)[0]!;
    expect(Date.parse(doc.data.expire_at)).toBe(now + 400 * 86_400_000);
  });
});
