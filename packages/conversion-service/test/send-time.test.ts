/**
 * Send-time behaviour of the outbox (review findings): consent re-decided at send, sends held for
 * the purchase-time value, validated vs sent, credential retries, payload blanking and TTLs, the
 * held-record cursor, lease renewal during long sends, and concurrent evaluation.
 */

import { describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { adjustmentDependency } from '../src/dispatch/dispatcher.js';
import { Drainer } from '../src/outbox/drainer.js';
import type { Transport } from '../src/outbox/transport.js';
import type { OutboxRecord } from '../src/types.js';
import { CASH_14, enrichedFrom, testConfig } from './helpers/enriched.js';
import { goldenLedgerRows, purchaseValueRows } from './helpers/fixtures.js';
import { ScriptedTransport, outboxHarness } from './helpers/outbox-harness.js';

const golden = goldenLedgerRows();
const g = (id: string): ConversionLedgerEvent => structuredClone(golden.find((r) => r.event_id === id)!);
const U01 = 'SynthU01StarterMonA1';
const EMAIL = 'synth.u01@example.test';
const RENEWAL = 'purchase_in_1SynthU01Inv0002Cycle';
const FIRST = 'purchase_in_1SynthU01Inv0001First';
const DAY = 86_400_000;
const only = (...platforms: Array<'google_ads' | 'meta' | 'tiktok' | 'reddit' | 'linkedin' | 'x' | 'microsoft'>) => testConfig({ enabledPlatforms: new Set(platforms) });
const renewal = () => enrichedFrom(g(RENEWAL), { email: EMAIL, value: CASH_14 });

describe('consent is decided again right before sending', () => {
  it('a CMP withdrawal between enqueue and send stops the send', async () => {
    const h = outboxHarness({ config: only('meta'), users: [{ user_id: U01, region: 'US' }] });
    await h.dispatcher.dispatch(renewal());
    expect((await h.outbox.get(`meta:SEND:${RENEWAL}`))!.data.status).toBe('pending');
    h.userContext.set({ user_id: U01, region: 'US', consent: { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted', region: 'US', source: 'cmp' } });
    const report = await h.drainer.drain();
    expect(report).toMatchObject({ requests: 0, skipped: 1 });
    expect((await h.outbox.get(`meta:SEND:${RENEWAL}`))!.data).toMatchObject({ status: 'skipped', reason: 'consent_denied_at_send', item: null });
  });

  it('Global Privacy Control observed after enqueue blocks the send', async () => {
    const h = outboxHarness({ config: only('google_ads'), users: [{ user_id: U01, region: 'US' }] });
    await h.dispatcher.dispatch(renewal());
    h.userContext.set({ user_id: U01, consent: { ad_storage: 'unknown', ad_user_data: 'unknown', ad_personalization: 'unknown', analytics_storage: 'unknown', region: 'US', source: 'none', gpc: true } });
    await h.drainer.drain();
    expect((await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data).toMatchObject({ status: 'skipped', reason: 'gpc_or_sale_opt_out_at_send' });
  });

  it('an item built under a more permissive consent claim than now allowed is not sent (it would lack LDU)', async () => {
    const config = only('reddit');
    config.consent = { ...config.consent, optOutHandling: 'restrict' };
    const h = outboxHarness({ config, users: [{ user_id: U01, region: 'US' }] });
    await h.dispatcher.dispatch(renewal());
    h.userContext.set({ user_id: U01, consent: { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', region: 'US-CA', source: 'cmp' } });
    await h.drainer.drain();
    expect((await h.outbox.get(`reddit:SEND:${RENEWAL}`))!.data).toMatchObject({ status: 'skipped', reason: 'consent_changed_since_enqueue' });
  });

  it('a user-context outage leaves the record queued instead of sending without a consent check', async () => {
    const h = outboxHarness({ config: only('meta') });
    await h.dispatcher.dispatch(renewal());
    h.userContext.get = async () => {
      throw new Error('bigquery unavailable');
    };
    expect(await h.drainer.drain()).toMatchObject({ requests: 0 });
    expect((await h.outbox.get(`meta:SEND:${RENEWAL}`))!.data.status).toBe('pending');
  });
});

describe('sends of an acquisition purchase wait for its purchase-time value', () => {
  const occurred = Date.parse('2026-06-03T17:04:11Z');
  const score = () => purchaseValueRows().find((s) => s.event_id === FIRST)!;

  it('held on value_score, then patched in place with predicted_profit_90d once the score exists', async () => {
    const config = only('google_ads', 'meta');
    config.google.multiSourceConfirmed = true;
    const h = outboxHarness({ config, now: '2026-06-03T17:04:41Z' });
    const provisional = await h.values.resolve(g(FIRST), h.clock.now());
    expect(provisional).toMatchObject({ pending: true, basis: 'cash_fallback', value: 14 });
    await h.dispatcher.dispatch(enrichedFrom(g(FIRST), { email: EMAIL, value: provisional }));
    for (const p of ['google_ads', 'meta']) {
      expect((await h.outbox.get(`${p}:SEND:${FIRST}`))!.data, p).toMatchObject({
        status: 'held',
        hold_gate: 'value_score',
        reason: 'awaiting_value_score',
        next_attempt_at_ms: h.clock.now() + 60_000,
        meta: { value_pending: true, value_cash_minor: 1400, value_cash_currency: 'USD' },
      });
    }
    expect((await h.drainer.drain()).requests).toBe(0);
    h.scores.add(score());
    h.clock.set(occurred + 90_000);
    const report = await h.drainer.drain();
    expect(report).toMatchObject({ requests: 2, dry_run: 2 });
    const t = h.transport as ScriptedTransport;
    const google = (t.requests.find((r) => r.platform === 'google_ads')!.body.events as Array<Record<string, unknown>>)[0]!;
    expect(google).toMatchObject({ transactionId: 'sub_in_1SynthU01Inv0001First', conversionValue: 22.11, currency: 'USD' });
    const meta = (t.requests.find((r) => r.platform === 'meta')!.body.data as Array<Record<string, any>>)[0]!;
    expect(meta.custom_data).toEqual({ value: 22.11, currency: 'USD', order_id: 'sub_in_1SynthU01Inv0001First', predicted_ltv: 22.11, value_basis: 'predicted_profit_90d' });
    expect((await h.outbox.get(`meta:SEND:${FIRST}`))!.data).toMatchObject({
      status: 'dry_run',
      item: null,
      meta: { value_pending: false, value: 22.11, value_currency: 'USD', value_basis: 'predicted_profit_90d', value_floored: false },
    });
  });

  it('no purchase-time score within the SLA: sent as cash, tagged cash_fallback', async () => {
    const h = outboxHarness({ config: only('meta'), now: '2026-06-03T17:04:41Z' });
    await h.dispatcher.dispatch(enrichedFrom(g(FIRST), { email: EMAIL, value: await h.values.resolve(g(FIRST), h.clock.now()) }));
    h.clock.set(occurred + h.config.value.scoreSlaMs + 1);
    await h.drainer.drain();
    const meta = ((h.transport as ScriptedTransport).requests[0]!.body.data as Array<Record<string, any>>)[0]!;
    expect(meta.custom_data).toEqual({ value: 14, currency: 'USD', order_id: 'sub_in_1SynthU01Inv0001First', value_basis: 'cash_fallback' });
    expect((await h.outbox.get(`meta:SEND:${FIRST}`))!.data.meta).toMatchObject({ value_basis: 'cash_fallback', value_pending: false });
  });
});

describe('what a 2xx means', () => {
  it('a validation-only request (Google validateOnly) is recorded as validated, never as sent', async () => {
    const t = new ScriptedTransport(() => ({ kind: 'ok', status: 200, dryRun: false }));
    const config = only('google_ads');
    config.google.validateOnly = true;
    const h = outboxHarness({ transport: t, config });
    await h.dispatcher.dispatch(renewal());
    expect(await h.drainer.drain()).toMatchObject({ validated: 1, sent: 0 });
    expect((await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data.status).toBe('validated');
  });

  it('adjustments depend only on truly sent originals once they would go live; dry-run previews stay dry-run', () => {
    const rec = { meta: {} } as OutboxRecord;
    expect(adjustmentDependency(rec, 'sent', true)).toBe('ready');
    expect(adjustmentDependency(rec, 'dry_run', true)).toBe('unconfirmed');
    expect(adjustmentDependency(rec, 'validated', true)).toBe('unconfirmed');
    expect(adjustmentDependency(rec, 'validated', false)).toBe('ready');
    expect(adjustmentDependency(rec, 'dry_run', false)).toBe('ready');
    expect(adjustmentDependency(rec, 'held', true)).toBe('wait');
  });
});

describe('refund supersession is re-checked at send time', () => {
  it('a partial refund queued before a larger refund was recorded is skipped when its turn comes', async () => {
    const config = only('google_ads');
    config.google.adjustments = 'data_manager_restatement';
    const h = outboxHarness({ config, now: '2026-08-03T17:05:00Z' });
    const renewal3: ConversionLedgerEvent = { ...g(RENEWAL), event_id: 'purchase_in_1SynthU01Inv0003Cycle', order_id: 'sub_in_1SynthU01Inv0003Cycle', invoice_id: 'in_1SynthU01Inv0003Cycle', occurred_at: '2026-08-03T17:04:11Z' };
    await h.ledger.write([renewal3]);
    await h.dispatcher.dispatch(enrichedFrom(renewal3, { email: EMAIL, value: CASH_14 }));
    await h.drainer.drain();
    h.clock.set(Date.parse('2026-08-05T09:13:10Z'));
    const partial = { ...g('refund_ch_3SynthU01Chg0003_1400'), event_id: 'refund_ch_3SynthU01Chg0003_700', cash_value_minor: -700 };
    await h.dispatcher.dispatch(enrichedFrom(partial, { email: EMAIL }));
    expect((await h.outbox.get('google_ads:ADJUST:refund_ch_3SynthU01Chg0003_700'))!.data.status).toBe('pending');
    await h.store.put('stripe_charge_refunds', 'ch_3SynthU01Chg0003', { max_cumulative_refunded: 1400, previous_by_cumulative: {}, user_id: U01, expire_at: '2027-01-01T00:00:00Z' });
    await h.drainer.drain();
    expect((await h.outbox.get('google_ads:ADJUST:refund_ch_3SynthU01Chg0003_700'))!.data).toMatchObject({ status: 'skipped', reason: 'superseded_by_later_refund' });
  });
});

describe('credential failures never dead-letter while the record can still be sent', () => {
  it('auth retries do not use up attempts; the record dies only at its send-by deadline', async () => {
    const t = new ScriptedTransport(() => ({ kind: 'retry', status: 401, error: 'HTTP 401: token expired', auth: true }));
    const config = only('google_ads');
    config.outbox = { ...config.outbox, maxAttempts: 2 };
    const h = outboxHarness({ transport: t, config });
    await h.dispatcher.dispatch(renewal());
    for (let i = 0; i < 4; i += 1) {
      await h.drainer.drain();
      h.clock.advance(2 * 3_600_000);
    }
    expect((await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data).toMatchObject({ status: 'pending', attempts: 4, last_error: 'HTTP 401: token expired' });
    h.clock.advance(91 * DAY);
    await h.drainer.drain();
    expect((await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data).toMatchObject({ status: 'dead', reason: 'retry_window_exhausted' });
  });
});

describe('terminal records: payload blanked, value kept in meta, TTL set', () => {
  it('a sent purchase keeps only non-PII meta, and lives long enough for a refund adjustment', async () => {
    const h = outboxHarness({ config: only('google_ads', 'meta') });
    await h.dispatcher.dispatch(renewal());
    await h.drainer.drain();
    const rec = (await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data;
    expect(rec).toMatchObject({ status: 'dry_run', item: null, user_id: U01, meta: { value: 14, value_currency: 'USD', value_basis: 'cash' } });
    expect(Date.parse(rec.expire_at)).toBe(h.clock.now() + 100 * DAY);
    const skipped = (await h.outbox.get(`linkedin:SEND:${RENEWAL}`))!.data;
    expect(skipped).toMatchObject({ status: 'skipped', item: null });
  });

  it('pending records live at least until their send-by deadline', async () => {
    const h = outboxHarness({ config: only('google_ads') });
    await h.dispatcher.dispatch(renewal());
    const rec = (await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data;
    expect(Date.parse(rec.expire_at)).toBeGreaterThanOrEqual(rec.deadline_ms! + 30 * DAY);
  });
});

describe('held records are not re-read on every drain', () => {
  it('a gate hold wakes at its deadline or when the gate configuration changes', async () => {
    const h = outboxHarness({ config: only('reddit'), now: '2026-06-03T17:05:00Z' });
    await h.dispatcher.dispatch(enrichedFrom(g(FIRST), { email: EMAIL, value: CASH_14 }));
    const held = (await h.outbox.get(`reddit:SEND:${FIRST}`))!.data;
    expect(held).toMatchObject({ status: 'held', hold_gate: 'reddit_dedup', next_attempt_at_ms: held.deadline_ms });
    expect((await h.drainer.drain()).still_held).toBe(1); // first drain of a process: full scan
    expect((await h.drainer.drain()).still_held).toBe(0); // not due: not even read
    h.config.reddit.dedupVerified = true; // gate configuration changed: full scan again
    expect(await h.drainer.drain()).toMatchObject({ released: 1, dry_run: 1 });
  });

  it('an expired gate hold is found at its deadline and skipped', async () => {
    const h = outboxHarness({ config: only('reddit'), now: '2026-06-03T17:05:00Z' });
    await h.dispatcher.dispatch(enrichedFrom(g(FIRST), { email: EMAIL, value: CASH_14 }));
    await h.drainer.drain();
    h.clock.advance(3 * DAY);
    expect(await h.drainer.drain()).toMatchObject({ skipped: 1 });
    expect((await h.outbox.get(`reddit:SEND:${FIRST}`))!.data).toMatchObject({ status: 'skipped', reason: 'window_expired_while_held' });
  });
});

describe('leases are renewed while a drain is still sending', () => {
  it('a send that outlasts the lease keeps its records (renewed), settles them, and adds no history noise', async () => {
    const h = outboxHarness({ config: only('google_ads') });
    h.config.outbox = { ...h.config.outbox, leaseRenewMs: 5 };
    let renewals = 0;
    const renew = h.outbox.renewLease.bind(h.outbox);
    h.outbox.renewLease = async (...args) => {
      renewals += 1;
      return renew(...args);
    };
    const slow: Transport = {
      send: async () => {
        h.clock.advance(h.config.outbox.leaseMs + 1);
        await new Promise((r) => setTimeout(r, 40));
        return { kind: 'ok', status: 200, dryRun: true };
      },
    };
    const drainer = new Drainer({ outbox: h.outbox, transport: slow, config: h.config, clock: h.clock.now, log: h.log, rng: () => 0.5, userContext: h.userContext, values: h.values, store: h.store });
    await h.dispatcher.dispatch(renewal());
    await drainer.drain();
    expect(renewals).toBeGreaterThan(0);
    const rec = (await h.outbox.get(`google_ads:SEND:${RENEWAL}`))!.data;
    expect(rec).toMatchObject({ status: 'dry_run', lease_until_ms: null });
    expect(rec.history.map((x) => x.status)).toEqual(['pending', 'in_flight', 'dry_run']);
  });

  it('while one chunk sends slowly, another drain cannot steal the later chunks: every record is sent once', async () => {
    const h = outboxHarness({ config: only('google_ads', 'microsoft') });
    h.config.outbox = { ...h.config.outbox, leaseRenewMs: 5 };
    const sends: string[] = [];
    let other: Drainer | null = null;
    let otherReport: Awaited<ReturnType<Drainer['drain']>> | null = null;
    const transport: Transport = {
      send: async (req) => {
        sends.push(req.platform);
        if (other && !otherReport) {
          h.clock.advance(h.config.outbox.leaseMs + 1);
          await new Promise((r) => setTimeout(r, 40));
          otherReport = await other.drain();
        }
        return { kind: 'ok', status: 200, dryRun: true };
      },
    };
    const deps = { outbox: h.outbox, transport, config: h.config, clock: h.clock.now, log: h.log, rng: () => 0.5, userContext: h.userContext, values: h.values, store: h.store };
    const drainer = new Drainer(deps);
    other = new Drainer(deps);
    await h.dispatcher.dispatch(renewal());
    await drainer.drain();
    expect(sends.sort()).toEqual(['google_ads', 'microsoft']);
    expect(otherReport).toMatchObject({ requests: 0 });
  });
});
