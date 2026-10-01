/**
 * END-TO-END: the contracts fixtures (5 Stripe scenarios, the credit ledger, Amplitude, HubSpot)
 * plus a few synthetic consent/web-fix users go through the real HTTP server in "real time"
 * (each event arrives 30 s after it happened; U02's whole Stripe history arrives 9 days late).
 * Between deliveries the Cloud Scheduler drain runs whenever something is due (harness advanceTo):
 * acquisition purchases wait for their purchase-time value score, gate holds expire at their
 * deadline. Every platform request is written by the dry-run transport and snapshotted per platform.
 *
 *   Phase A  today's gates (web fixes not live, Reddit dedup unverified); Google multi-source and
 *            adjustments flags ON, as an operator would set them after confirming with Google.
 *   Phase B  the web fixes go live (effective 2026-09-25T00:00Z); a new signup arrives.
 *   Phase C  Reddit's dedup log confirms the conversion_id encoding.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversionLedgerEventSchema, getPlatformMapping, parseBrowserDedupId, renderDedupKey } from '@openart-signal/contracts';
import type { ConversionLedgerEvent, Platform } from '@openart-signal/contracts';
import { INTERNAL_SIGNATURE_HEADER, signInternalBody } from '../../src/http/internal-auth.js';
import type { WrittenRequest } from '../../src/outbox/transport.js';
import { PLATFORM_MODULES, validateRequest } from '../../src/platforms/registry.js';
import type { OutboxRecord } from '../../src/types.js';
import { allStripeEvents, goldenLedgerRows } from '../helpers/fixtures.js';
import { blockedNetworkAttempts } from '../setup/no-network.js';
import { EXTRA_USERS, HMAC_SECRET, SCENARIO_USERS, SYNTH_UA, signupLedgerEntry, startHarness, timeline } from './harness.js';
import type { Delivery, Harness } from './harness.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const SNAP = (name: string) => `../__snapshots__/e2e/${name}`;
const WEB_FIX_LIVE_AT = Date.parse('2026-09-25T00:00:00Z');

let h: Harness;
const phases: Record<'A' | 'B' | 'C', WrittenRequest[]> = { A: [], B: [], C: [] };
const responses: Array<{ label: string; status: number; json: any }> = [];

async function deliver(d: Delivery): Promise<void> {
  await h.advanceTo(d.at);
  h.clock.set(d.at);
  const res = d.kind === 'stripe' ? await h.postStripe(JSON.stringify(d.event)) : await h.postEvents(d.body);
  responses.push({ label: d.label, status: res.status, json: res.json });
}

async function outboxRecords(): Promise<OutboxRecord[]> {
  return h.app.outbox.all();
}

async function record(key: string): Promise<OutboxRecord | undefined> {
  return (await h.app.outbox.get(key))?.data;
}

function items(platform: Platform, phase?: 'A' | 'B' | 'C'): Array<Record<string, any>> {
  const pick = (w: WrittenRequest[]) => w.filter((x) => x.request.platform === platform);
  const reqs = phase ? pick(phases[phase]) : [...pick(phases.A), ...pick(phases.B), ...pick(phases.C)];
  return reqs.flatMap((w) => {
    const b = w.request.body as Record<string, any>;
    return (b.events ?? b.data?.events ?? b.data ?? b.elements ?? b.conversions ?? b.OnlineConversionAdjustments ?? []) as Array<Record<string, any>>;
  });
}

beforeAll(async () => {
  h = await startHarness({}, '2026-06-01T00:00:00Z');
  h.config.google.multiSourceConfirmed = true;
  h.config.google.adjustments = 'data_manager_restatement';
  h.config.microsoft.adjustments = 'online_conversion_adjustments';

  // Phase A: real-time replay.
  for (const d of timeline()) await deliver(d);
  // Maintenance drain the Cloud Scheduler job would run.
  await h.advanceTo(Date.parse('2026-09-25T00:05:00Z'));
  h.clock.set(Date.parse('2026-09-25T00:05:00Z'));
  const raw = '{}';
  const drain = await h.postRaw('/tasks/drain', raw, { 'Content-Type': 'application/json', [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, raw, Math.floor(h.clock.now() / 1000)) });
  responses.push({ label: 'tasks/drain', status: drain.status, json: drain.json });
  phases.A = [...h.transport.written];

  // Phase B: web fixes go live; a new signup arrives.
  for (const key of ['signup:tiktok', 'signup:reddit', 'signup:linkedin', 'signup:x', 'purchase_first:linkedin', 'purchase_first:microsoft']) {
    (h.config.webFixesLive as Map<string, number>).set(key, WEB_FIX_LIVE_AT);
  }
  await deliver({ kind: 'events', at: Date.parse('2026-09-25T12:00:30Z'), label: 'signup U06 (after web fix)', body: { kind: 'credit_ledger_entry', entry: signupLedgerEntry(EXTRA_USERS.u06.uid, '2026-09-25T12:00:00.000Z', '6') } });
  phases.B = h.transport.written.slice(phases.A.length);

  // Phase C: Reddit dedup verified.
  h.config.reddit.dedupVerified = true;
  await h.advanceTo(Date.parse('2026-09-25T12:10:00Z'));
  h.clock.set(Date.parse('2026-09-25T12:10:00Z'));
  const raw2 = '{}';
  const drain2 = await h.postRaw('/tasks/drain', raw2, { 'Content-Type': 'application/json', [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, raw2, Math.floor(h.clock.now() / 1000)) });
  responses.push({ label: 'tasks/drain (reddit verified)', status: drain2.status, json: drain2.json });
  phases.C = h.transport.written.slice(phases.A.length + phases.B.length);
});

afterAll(async () => {
  await h?.close();
});

describe('e2e: every delivery is accepted', () => {
  it('all webhook and internal calls return 200', () => {
    expect(responses.filter((r) => r.status !== 200)).toEqual([]);
    expect(responses.length).toBe(40); // 27 Stripe events + 10 internal events + 2 scheduler drains + the phase-B signup
  });
});

describe('e2e: exact payload snapshots per platform', () => {
  const platforms: Platform[] = ['google_ads', 'meta', 'tiktok', 'reddit', 'linkedin', 'x', 'microsoft'];
  for (const platform of platforms) {
    it(`${platform}: every request validates against its documented schema and matches the snapshot`, async () => {
      const mine = (['A', 'B', 'C'] as const).flatMap((phase) =>
        phases[phase]
          .filter((w) => w.request.platform === platform)
          .map((w) => ({ phase, action: w.request.action, method: w.request.method, url: w.request.url, headers: w.request.headers, auth: w.request.auth, body: w.request.body })),
      );
      for (const req of mine) expect(validateRequest({ platform, action: req.action, body: req.body }).errors).toEqual([]);
      // Dry-run file names are unique per instance and request (ULID), so the snapshot records the action instead.
      for (const w of [...phases.A, ...phases.B, ...phases.C].filter((x) => x.request.platform === platform)) {
        expect(basename(w.file)).toMatch(new RegExp(`^[0-9A-HJKMNP-TV-Z]{26}-[A-Za-z0-9_.-]+-${w.request.action}\\.json$`));
      }
      await expect(`${JSON.stringify(mine, null, 2)}\n`).toMatchFileSnapshot(SNAP(`requests.${platform}.json`));
    });
  }

  it('the outbox decision table (every platform x canonical event) matches the snapshot', async () => {
    const lines = (await outboxRecords())
      .map((r) => `${r.key} -> ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
      .sort();
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(SNAP('outbox-decisions.txt'));
  });

  it('the conversion ledger matches the snapshot and every row passes the contracts validator', async () => {
    const rows = h.ledger.all();
    for (const row of rows) expect(ConversionLedgerEventSchema.safeParse(row).success, row.event_id).toBe(true);
    await expect(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`).toMatchFileSnapshot(SNAP('ledger.jsonl'));
  });
});

describe('e2e: canonical rows', () => {
  const CORE = ['event_id', 'event_name', 'occurred_at', 'source_system', 'source_event_id', 'user_id', 'order_id', 'adjusts_event_id', 'adjusts_order_id', 'cash_value_minor', 'currency', 'invoice_id', 'subscription_id', 'charge_id', 'plan_tier', 'plan_tier_code', 'billing_interval', 'previous_plan_tier', 'credit_pack_quantity', 'generation', 'lead'] as const;

  it('one canonical row per conversion, equal to every contracts golden row on its source-determined fields', () => {
    const rows = h.ledger.all();
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(rows.length);
    for (const golden of goldenLedgerRows()) {
      const mine = rows.find((r) => r.event_id === golden.event_id);
      expect(mine, golden.event_id).toBeDefined();
      for (const k of CORE) expect(mine![k], `${golden.event_id}.${k}`).toEqual(golden[k]);
    }
  });

  it('enrichment: device id, click ids (+gbraid), UTMs, experiment arms and consent come from the stores', () => {
    const row = h.ledger.all().find((r) => r.event_id === 'purchase_in_1SynthU01Inv0001First')!;
    expect(row).toMatchObject({
      device_id: SCENARIO_USERS.u01.deviceId,
      checkout_session_id: 'cs_live_a1SynthU01Checkout0001',
      is_first_purchase: true,
      click_ids: { gclid: { value: 'Cj0KCQjwSYNTHgclidU01' }, gbraid: { value: '0AAAAASYNTHgbraidU01' } },
      utm: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'synth_search_brand' },
      experiment_arms: { 'suite-default-model-create-image': 'nano-banana-pro' },
      consent: { region: 'US', source: 'none' },
    });
  });
});

describe('e2e: dedup ids equal the browser formats', () => {
  const dedupField: Record<Platform, (item: Record<string, any>) => string> = {
    google_ads: (i) => i.transactionId,
    meta: (i) => i.event_id,
    tiktok: (i) => i.event_id,
    reddit: (i) => i.metadata.conversion_id,
    linkedin: (i) => i.eventId,
    x: (i) => i.conversion_id,
    microsoft: (i) => i.eventId,
  };

  it('every sent twin carries exactly the id the browser tag sends (contracts browser_twin.id_template, hashed where the pixel hashes)', async () => {
    const rows = new Map(h.ledger.all().map((r) => [r.event_id, r] as const));
    let checked = 0;
    for (const rec of await outboxRecords()) {
      if (rec.action !== 'SEND' || (rec.status !== 'dry_run' && rec.status !== 'sent')) continue;
      const row = rows.get(rec.event_id) as ConversionLedgerEvent;
      const twin = getPlatformMapping(row.event_name, rec.platform).browser_twin;
      // After the web fix, the twin sends the id in the contracts dedup template.
      const template = twin?.id_template ?? (twin ? getPlatformMapping(row.event_name, rec.platform).dedup_key_template : null);
      if (!twin || !template) continue;
      const browserId = renderDedupKey(template, { user_id: row.user_id, invoice_id: row.invoice_id, event_id: row.event_id, order_id: row.order_id, adjusts_order_id: null });
      const expected = twin.id_hashed || rec.platform === 'reddit' ? sha(browserId) : browserId;
      // A terminal record keeps its dedup key (its payload is blanked); the request the platform got carries it.
      expect(rec.item, rec.key).toBeNull();
      expect(rec.meta.dedup_key, rec.key).toBe(browserId);
      expect(items(rec.platform).map((i) => dedupField[rec.platform](i)), rec.key).toContain(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('ids classify as the Suite formats: reg_<uid>, purchase_<invoiceId>, sub_<invoiceId>', () => {
    for (const i of items('meta')) {
      if (i.event_name === 'Purchase') expect(parseBrowserDedupId(i.event_id).kind).toBe('purchase_event');
      if (i.event_name === 'CompleteRegistration') expect(parseBrowserDedupId(i.event_id).kind).toBe('signup');
    }
    const googlePurchases = items('google_ads').filter((i) => String(i.transactionId).startsWith('sub_'));
    expect(googlePurchases.length).toBeGreaterThan(0);
    for (const i of googlePurchases) expect(parseBrowserDedupId(i.transactionId).kind).toBe('purchase_order');
    for (const i of items('tiktok').filter((x) => x.event === 'Purchase')) expect(parseBrowserDedupId(i.event_id).kind).toBe('purchase_order');
    for (const i of items('x')) expect(['purchase_order', 'signup']).toContain(parseBrowserDedupId(i.conversion_id).kind);
  });
});

describe('e2e: hashing is correct per platform', () => {
  const U01 = SCENARIO_USERS.u01;
  const U01_LOWER_UID = U01.uid.toLowerCase();

  it('U01 (synth.u01@example.test): dots kept for Google/Meta/TikTok/X, stripped for Reddit/Microsoft; external_id = SHA-256(lower(uid))', () => {
    const plain = sha(U01.email);
    const dotless = sha('synthu01@example.test');
    const g = items('google_ads').find((i) => i.transactionId === 'sub_in_1SynthU01Inv0001First')!;
    expect(g.userData.userIdentifiers).toEqual([{ emailAddress: plain }]);
    const m = items('meta').find((i) => i.event_id === 'purchase_in_1SynthU01Inv0001First')!;
    expect(m.user_data.em).toEqual([plain]);
    expect(m.user_data.external_id).toEqual([sha(U01_LOWER_UID)]);
    expect(items('tiktok').find((i) => i.event_id === 'sub_in_1SynthU01Inv0001First')!.user).toMatchObject({ email: plain, external_id: sha(U01_LOWER_UID) });
    expect(items('x').find((i) => i.conversion_id === 'sub_in_1SynthU01Inv0001First')!.identifiers[0]).toEqual({ hashed_email: plain });
    expect(items('reddit').find((i) => i.metadata.order_id === 'sub_in_1SynthU01Inv0002Cycle')!.user.email).toBe(dotless);
    expect(items('microsoft').find((i) => i.eventId === 'sub_in_1SynthU01Inv0002Cycle')!.userData.em).toBe(dotless);
  });

  it('U06 ("  Synth.U06+Promo@GoogleMail.com "): Google strips dots and +suffix only for gmail/googlemail', () => {
    expect(items('google_ads', 'B').find((i) => i.transactionId === `reg_${EXTRA_USERS.u06.uid}`)!.userData.userIdentifiers).toEqual([{ emailAddress: sha('synthu06@googlemail.com') }]);
    expect(items('meta', 'B')[0]!.user_data.em).toEqual([sha('synth.u06+promo@googlemail.com')]);
    expect(items('linkedin', 'B')[0]!.user.userIds[0]).toEqual({ idType: 'SHA256_EMAIL', idValue: sha('synth.u06+promo@googlemail.com') });
    expect(items('reddit', 'C')[0]!.user.email).toBe(sha('synthu06@googlemail.com'));
  });

  it('no raw email, raw uid-as-external-id, or unhashed phone ever appears in a request body', () => {
    const all = JSON.stringify([...phases.A, ...phases.B, ...phases.C].map((w) => w.request.body));
    for (const email of [SCENARIO_USERS.u01.email, SCENARIO_USERS.u05.email, 'lead.one@synthetic-brand.example.test', 'synth.u06']) expect(all).not.toContain(email);
    expect(all).not.toMatch(/"external_?[iI]d":\s*\[?"Synth/);
  });
});

describe('e2e: Meta specifics', () => {
  it('renewals are action_source system_generated; purchases and checkout are website events with UA and URL', () => {
    const meta = items('meta');
    const renewals = meta.filter((i) => i.event_name === 'purchase_renewal');
    expect(renewals.length).toBe(2);
    for (const r of renewals) expect(r.action_source).toBe('system_generated');
    for (const p of meta.filter((i) => i.event_name === 'Purchase' || i.event_name === 'InitiateCheckout')) {
      expect(p).toMatchObject({ action_source: 'website', event_source_url: expect.stringMatching(/^https:\/\/openart\.ai\//) });
      expect(p.user_data.client_user_agent).toBe(SYNTH_UA);
    }
  });

  it('value = the purchase-time score E[gross_profit_90d | purchase] (+predicted_ltv); no score within the SLA -> cash tagged cash_fallback', async () => {
    const u01 = items('meta').find((i) => i.event_id === 'purchase_in_1SynthU01Inv0001First')!;
    expect(u01.custom_data).toEqual({ value: 22.11, currency: 'USD', order_id: 'sub_in_1SynthU01Inv0001First', predicted_ltv: 22.11, value_basis: 'predicted_profit_90d' });
    const u03 = items('meta').find((i) => i.event_id === 'purchase_in_1SynthU03Inv0001First')!;
    expect(u03.custom_data).toEqual({ value: 34, currency: 'USD', order_id: 'sub_in_1SynthU03Inv0001First', value_basis: 'cash_fallback' });
    // Every platform got the same value for the same purchase, and the record says how it was made.
    for (const p of ['google_ads', 'tiktok', 'x'] as const) {
      expect(await record(`${p}:SEND:purchase_in_1SynthU01Inv0001First`), p).toMatchObject({ meta: { value: 22.11, value_basis: 'predicted_profit_90d', value_floored: false } });
    }
  });

  it('a loss-making acquisition purchase sends the floor, recorded as floored with its raw estimate', async () => {
    const pack = await record('microsoft:SEND:purchase_cs_live_a1SynthU05Pack00000001');
    expect(pack).toMatchObject({ status: 'dry_run', meta: { value: 0.01, value_basis: 'predicted_profit_90d', value_floored: true, value_raw: -4.37 } });
    const sent = items('microsoft').find((i) => i.eventId === 'sub_cs_live_a1SynthU05Pack00000001');
    expect(sent?.customData).toMatchObject({ value: 0.01, currency: 'USD' });
  });

  it('fbc is built server-side from the stored fbclid when the request had no _fbc', () => {
    const u03 = items('meta').find((i) => i.event_id === 'purchase_in_1SynthU03Inv0001First')!;
    expect(u03.user_data.fbc).toBe('fb.1.1781427480000.IwAR3SYNTHfbclidU03xYz');
  });
});

describe('e2e: refunds and chargebacks', () => {
  it('a refund creates a Google adjustment (restated to the remaining value) and a Meta skip', async () => {
    const google = await record('google_ads:ADJUST:refund_ch_3SynthU01Chg0003_1400');
    expect(google).toMatchObject({ status: 'dry_run', action: 'ADJUST', batch_key: '1000000000:9000000005' });
    const adj = items('google_ads').find((i) => i.transactionId === 'sub_in_1SynthU01Inv0003Cycle' && i.conversionValue === 0);
    expect(adj).toMatchObject({ transactionId: 'sub_in_1SynthU01Inv0003Cycle', eventTimestamp: '2026-08-03T17:04:11Z', conversionValue: 0, currency: 'USD' });
    expect(await record('meta:SEND:refund_ch_3SynthU01Chg0003_1400')).toMatchObject({ status: 'skipped', reason: 'no_adjustment_api' });
    for (const p of ['tiktok', 'reddit', 'linkedin', 'x'] as const) {
      expect(await record(`${p}:SEND:refund_ch_3SynthU01Chg0003_1400`), p).toMatchObject({ status: 'skipped', reason: 'no_adjustment_api' });
    }
  });

  it('Microsoft retracts the refunded renewal it recorded; a chargeback retracts the first purchase (tag-recorded)', async () => {
    const ms = items('microsoft').filter((i) => i.AdjustmentType);
    expect(ms).toEqual([
      { AdjustmentType: 'Retract', AdjustmentTime: '2026-08-02T10:00:00.000Z', ConversionName: 'purchase', TransactionId: 'sub_in_1SynthU04Inv0001First' },
      { AdjustmentType: 'Retract', AdjustmentTime: '2026-08-05T09:12:40.000Z', ConversionName: 'purchase_renewal', TransactionId: 'sub_in_1SynthU01Inv0003Cycle' },
    ]);
  });

  it('a chargeback restates the Google first purchase outside the 7-day bidding window (reporting only)', async () => {
    const rec = await record('google_ads:ADJUST:chargeback_dp_1SynthU04Dispute0001');
    expect(rec).toMatchObject({ status: 'dry_run', meta: { within_bidding_window: false, remaining_cash_minor: 0 } });
  });
});

describe('e2e: platform time windows', () => {
  it('U02 arrives 9 days late: past every window, so it is ledgered but sent nowhere', async () => {
    const id = 'purchase_in_1SynthU02Inv0001First';
    expect(h.ledger.all().some((r) => r.event_id === id)).toBe(true);
    // Past max age (7 days): Meta, TikTok, Reddit, X, Microsoft.
    for (const p of ['meta', 'tiktok', 'reddit', 'x', 'microsoft'] as const) {
      expect(await record(`${p}:SEND:${id}`), p).toMatchObject({ status: 'skipped', reason: 'window_expired' });
    }
    // Inside Google's 90 days but past the 7-day window in which a tag-value override still reaches bidding.
    expect(await record(`google_ads:SEND:${id}`)).toMatchObject({ status: 'skipped', reason: 'twin_window_expired' });
    for (const p of ['google_ads', 'meta', 'tiktok', 'reddit', 'x', 'microsoft'] as const) {
      expect(JSON.stringify(items(p)).includes('in_1SynthU02Inv0001First'), p).toBe(false);
    }
  });
});

describe('e2e: consent', () => {
  it('EEA user without CMP consent: withheld from every platform', async () => {
    for (const p of ['google_ads', 'meta', 'tiktok', 'reddit', 'linkedin', 'x', 'microsoft'] as const) {
      expect(await record(`${p}:SEND:reg_${EXTRA_USERS.u07.uid}`), p).toMatchObject({ status: 'skipped', reason: 'consent_required_regulated_region' });
    }
  });

  it('US user who opted out in the CMP: dropped everywhere (default policy)', async () => {
    for (const p of ['google_ads', 'meta', 'microsoft'] as const) {
      expect(await record(`${p}:SEND:reg_${EXTRA_USERS.u08.uid}`), p).toMatchObject({ status: 'skipped', reason: 'consent_denied' });
    }
  });

  it('EEA user with CMP consent: sent, with Google consent propagated and Microsoft "G"', () => {
    const g = items('google_ads').find((i) => i.transactionId === `reg_${EXTRA_USERS.u09.uid}`)!;
    expect(g.consent).toEqual({ adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' });
    expect(items('meta').find((i) => i.event_id === `reg_${EXTRA_USERS.u09.uid}`)!.data_processing_options).toEqual([]);
    expect(items('microsoft').find((i) => i.eventId === `reg_${EXTRA_USERS.u09.uid}`)!.adStorageConsent).toBe('G');
  });
});

describe('e2e: requires_web_fix rows are held until the web fix is live', () => {
  it('before the flag: U05 signup twins were held, never sent, and expired with their dedup window', async () => {
    const id = `reg_${SCENARIO_USERS.u05.uid}`;
    for (const p of ['tiktok', 'reddit', 'x'] as const) {
      const r = await record(`${p}:SEND:${id}`);
      expect(r?.history.map((x) => x.status), p).toEqual(['held', 'skipped']);
      expect(r?.reason, p).toBe('window_expired_while_held');
    }
    expect(phases.A.some((w) => ['tiktok', 'reddit', 'linkedin', 'x'].includes(w.request.platform) && JSON.stringify(w.request.body).includes(id))).toBe(false);
  });

  it('after the flag: events before the effective time are dropped (their browser copy can never dedupe), later ones are sent', async () => {
    expect(await record(`linkedin:SEND:reg_${SCENARIO_USERS.u05.uid}`)).toMatchObject({ status: 'skipped', reason: 'predates_web_fix' });
    expect(await record('linkedin:SEND:purchase_in_1SynthU04Inv0001First')).toMatchObject({ status: 'skipped', reason: 'predates_web_fix' });
    const u06 = `reg_${EXTRA_USERS.u06.uid}`;
    for (const p of ['tiktok', 'linkedin', 'x'] as const) expect(await record(`${p}:SEND:${u06}`), p).toMatchObject({ status: 'dry_run' });
    expect(items('tiktok', 'B')).toEqual([expect.objectContaining({ event: 'CompleteRegistration', event_id: u06 })]);
    expect(items('x', 'B')).toEqual([expect.objectContaining({ event_id: 'tw-qwghh-13vj22', conversion_id: u06 })]);
  });

  it('Reddit twins also wait for dedup verification, then go with the pixel-format conversion_id', async () => {
    const r = await record(`reddit:SEND:reg_${EXTRA_USERS.u06.uid}`);
    expect(r?.history.map((x) => x.status)).toEqual(['held', 'pending', 'in_flight', 'dry_run']);
    expect(items('reddit', 'B')).toEqual([]);
    expect(items('reddit', 'C')).toEqual([expect.objectContaining({ type: { tracking_type: 'SIGN_UP' }, metadata: { conversion_id: sha(`reg_${EXTRA_USERS.u06.uid}`) } })]);
  });
});

describe('e2e: idempotency and zero network', () => {
  it('a Stripe redelivery and a double-generated event (same object, new event id) send nothing new', async () => {
    const before = h.transport.written.length;
    const inv = allStripeEvents().find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;
    h.clock.set(Date.parse('2026-09-25T13:00:00Z'));
    const again = await h.postStripe(JSON.stringify(inv));
    expect(again).toMatchObject({ status: 200, json: { status: 'duplicate' } });
    const twin = { ...structuredClone(inv), id: 'evt_1SynthU01InvPaidDOUBLE' };
    const double = await h.postStripe(JSON.stringify(twin));
    expect(double.status).toBe(200);
    expect(double.json.outbox.every((o: { status: string }) => o.status !== 'pending')).toBe(true);
    expect(h.transport.written.length).toBe(before);
    expect(h.ledger.all().filter((r) => r.event_id === 'purchase_in_1SynthU01Inv0001First')).toHaveLength(1);
  });

  it('no request left the process: the fetch/socket/DNS guard saw nothing, and every platform module is dry-run', () => {
    expect(blockedNetworkAttempts()).toEqual([]);
    expect(h.config.mode).toBe('dry_run');
    expect([...h.config.livePlatforms]).toEqual([]);
    expect([...phases.A, ...phases.B, ...phases.C].length).toBeGreaterThan(30);
    expect(Object.keys(PLATFORM_MODULES)).toHaveLength(7);
  });
});
