import { describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { InMemoryLedger } from '../src/adapters/ledger.js';
import { Dispatcher, adjustmentDependency } from '../src/dispatch/dispatcher.js';
import { evaluateGates, gatesFor, sendWindow } from '../src/dispatch/policy.js';
import { getPlatformMapping } from '@openart-signal/contracts';
import { Outbox } from '../src/outbox/outbox.js';
import { STRIPE_STATE } from '../src/ingest/stripe-mapper.js';
import { ManualClock, DAY_MS, HOUR_MS } from '../src/time.js';
import type { OutboxRecord, ResolvedValue } from '../src/types.js';
import { PREDICTED_22_11, SYNTH_IP, SYNTH_UA, enrichedFrom, testConfig, valueOf } from './helpers/enriched.js';
import { goldenLedgerRows } from './helpers/fixtures.js';

const golden = goldenLedgerRows();
const g = (id: string): ConversionLedgerEvent => structuredClone(golden.find((r) => r.event_id === id)!);
const PRED: ResolvedValue = PREDICTED_22_11;

function setup(now: string, config = testConfig()) {
  const clock = new ManualClock(Date.parse(now));
  const store = new InMemoryDocumentStore();
  const ledger = new InMemoryLedger();
  const outbox = new Outbox(store, clock.now);
  const dispatcher = new Dispatcher({ config, clock: clock.now, ledger, outbox, store });
  return { clock, store, ledger, outbox, dispatcher, config };
}

describe('policy windows and gates', () => {
  it('twins get the dedup window, server-only rows the platform max age', () => {
    const t0 = Date.parse('2026-06-03T17:04:11Z');
    expect(sendWindow('meta', getPlatformMapping('purchase_first', 'meta'), t0).deadlineMs).toBe(t0 + 48 * HOUR_MS);
    expect(sendWindow('meta', getPlatformMapping('purchase_renewal', 'meta'), t0).deadlineMs).toBe(t0 + 7 * DAY_MS);
    // Google tag twins: the value override only reaches bidding within 7 days; no backfills.
    expect(sendWindow('google_ads', getPlatformMapping('purchase_first', 'google_ads'), t0).deadlineMs).toBe(t0 + 7 * DAY_MS);
    expect(sendWindow('google_ads', getPlatformMapping('purchase_renewal', 'google_ads'), t0).deadlineMs).toBe(t0 + 90 * DAY_MS);
    expect(sendWindow('reddit', getPlatformMapping('purchase_first', 'reddit'), t0).deadlineMs).toBe(t0 + 48 * HOUR_MS);
    expect(sendWindow('linkedin', getPlatformMapping('purchase_first', 'linkedin'), t0).deadlineMs).toBe(t0 + 90 * DAY_MS);
    expect(sendWindow('tiktok', getPlatformMapping('purchase_renewal', 'tiktok'), t0).deadlineMs).toBe(t0 + 7 * DAY_MS);
    const offline = testConfig();
    offline.microsoft.sendMode = 'offline_conversions';
    expect(sendWindow('microsoft', getPlatformMapping('purchase_renewal', 'microsoft'), t0).deadlineMs).toBe(t0 + 7 * DAY_MS);
    expect(sendWindow('microsoft', getPlatformMapping('purchase_renewal', 'microsoft'), t0, offline).deadlineMs).toBe(t0 + 90 * DAY_MS);
  });

  it('gates: every requires_web_fix row, Google tag-twin rows, and every Reddit twin', () => {
    expect(gatesFor('tiktok', getPlatformMapping('signup', 'tiktok'))).toEqual(['web_fix']);
    expect(gatesFor('reddit', getPlatformMapping('signup', 'reddit'))).toEqual(['web_fix', 'reddit_dedup']);
    expect(gatesFor('reddit', getPlatformMapping('purchase_first', 'reddit'))).toEqual(['reddit_dedup']);
    expect(gatesFor('google_ads', getPlatformMapping('purchase_first', 'google_ads'))).toEqual(['google_multi_source']);
    expect(gatesFor('google_ads', getPlatformMapping('signup', 'google_ads'))).toEqual([]);
    expect(gatesFor('meta', getPlatformMapping('purchase_first', 'meta'))).toEqual([]);
    const cfg = testConfig({ webFixesLive: new Map([['signup:tiktok', Date.parse('2026-10-01T00:00:00Z')]]) });
    expect(evaluateGates(['web_fix'], { event: 'signup', platform: 'tiktok', occurredMs: Date.parse('2026-09-30T23:59:59Z') }, cfg)).toEqual({ kind: 'drop', reason: 'predates_web_fix' });
    expect(evaluateGates(['web_fix'], { event: 'signup', platform: 'tiktok', occurredMs: Date.parse('2026-10-01T00:00:00Z') }, cfg)).toEqual({ kind: 'release' });
  });
});

describe('Dispatcher decisions', () => {
  it('Meta/TikTok skip purchase_first rows that are not the first purchase (win-back): the pixel only fires on the first', async () => {
    const { dispatcher } = setup('2026-06-03T17:05:00Z');
    const winBack = enrichedFrom({ ...g('purchase_in_1SynthU01Inv0001First'), is_first_purchase: false }, { email: 'a@b.test', value: PRED });
    expect(await dispatcher.decide(winBack, 'meta')).toMatchObject({ status: 'skipped', reason: 'not_first_purchase' });
    expect(await dispatcher.decide(winBack, 'tiktok')).toMatchObject({ status: 'skipped', reason: 'not_first_purchase' });
    expect(await dispatcher.decide(winBack, 'x')).toMatchObject({ status: 'pending' });
  });

  it('a twin arriving after the platform twin window (but inside max age) is skipped as twin_window_expired', async () => {
    const { dispatcher } = setup('2026-06-06T17:05:00Z');
    const e = enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: 'a@b.test', value: PRED });
    expect(await dispatcher.decide(e, 'meta')).toMatchObject({ status: 'skipped', reason: 'twin_window_expired' });
    expect(await dispatcher.decide(e, 'google_ads')).toMatchObject({ status: 'held', reason: 'awaiting_google_multi_source' });
  });

  it('events stamped in the future are refused', async () => {
    const { dispatcher } = setup('2026-06-03T16:00:00Z');
    const e = enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: 'a@b.test', value: PRED });
    expect(await dispatcher.decide(e, 'google_ads')).toMatchObject({ status: 'skipped', reason: 'event_time_in_future' });
  });

  it('evaluates every platform concurrently (seven sequential round trips per event are gone)', { timeout: 3_000 }, async () => {
    const { dispatcher, store } = setup('2026-06-03T17:05:00Z');
    // create() resolves only once all seven platform records are being created: a sequential dispatch never finishes.
    let waiting = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    const create = store.create.bind(store);
    store.create = async (c, k, d) => {
      waiting += 1;
      if (waiting === 7) release();
      await all;
      return create(c, k, d);
    };
    const records = await dispatcher.dispatch(enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: 'a@b.test', value: PRED }));
    expect(records).toHaveLength(7);
  });

  it('event_source_url from the request is https-only and never carries a query string or fragment', async () => {
    const { dispatcher } = setup('2026-06-03T17:05:00Z');
    const withUrl = (url: string) => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: 'a@b.test', value: PRED, context: { client_user_agent: SYNTH_UA, client_ip_address: SYNTH_IP, event_source_url: url } });
    const a = await dispatcher.decide(withUrl('https://openart.ai/suite/subscriptions?uid=SynthU01StarterMonA1&session_id=cs_live_x#top'), 'meta');
    expect((a.item as Record<string, unknown>).event_source_url).toBe('https://openart.ai/suite/subscriptions');
    const b = await dispatcher.decide(withUrl('http://openart.ai/elsewhere?x=1'), 'meta');
    expect((b.item as Record<string, unknown>).event_source_url).toBe('https://openart.ai/suite/subscriptions');
  });

  it('platform kill switch', async () => {
    const { dispatcher } = setup('2026-06-03T17:05:00Z', testConfig({ enabledPlatforms: new Set(['google_ads'] as const) }));
    const e = enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: 'a@b.test', value: PRED });
    expect(await dispatcher.decide(e, 'meta')).toMatchObject({ status: 'skipped', reason: 'platform_disabled' });
  });
});

describe('Adjustments', () => {
  const on = () => {
    const c = testConfig();
    c.google.adjustments = 'data_manager_restatement';
    c.microsoft.adjustments = 'online_conversion_adjustments';
    return c;
  };
  const renewal3 = (): ConversionLedgerEvent => ({ ...g('purchase_in_1SynthU01Inv0002Cycle'), event_id: 'purchase_in_1SynthU01Inv0003Cycle', order_id: 'sub_in_1SynthU01Inv0003Cycle', invoice_id: 'in_1SynthU01Inv0003Cycle', occurred_at: '2026-08-03T17:04:11Z' });

  async function withOriginal(status: OutboxRecord['status'] | null, value = 14) {
    const s = setup('2026-08-05T09:13:10Z', on());
    await s.ledger.write([renewal3()]);
    if (status) {
      const original = await s.dispatcher.decide(enrichedFrom(renewal3(), { email: 'a@b.test', value: valueOf({ value }) }), 'google_ads');
      await s.outbox.enqueue({ ...original, status });
    }
    return s;
  }

  it('flags off -> skipped; partial refund restates proportionally to what was sent; full refund restates to 0', async () => {
    const off = setup('2026-08-05T09:13:10Z');
    await off.ledger.write([renewal3()]);
    expect(await off.dispatcher.decide(enrichedFrom(g('refund_ch_3SynthU01Chg0003_1400')), 'google_ads')).toMatchObject({ status: 'skipped', reason: 'google_adjustments_disabled' });

    const s = await withOriginal('dry_run', 20);
    const partial = { ...g('refund_ch_3SynthU01Chg0003_1400'), event_id: 'refund_ch_3SynthU01Chg0003_700', cash_value_minor: -700 };
    const rec = await s.dispatcher.decide(enrichedFrom(partial, { email: 'a@b.test' }), 'google_ads');
    // Sent value 20 for 1400 cents; 700 refunded -> half the value remains.
    expect(rec).toMatchObject({ status: 'pending', action: 'ADJUST', item: { conversionValue: 10, transactionId: 'sub_in_1SynthU01Inv0003Cycle' } });
    expect(rec.not_before_ms).toBe(Date.parse('2026-08-04T17:04:11Z'));
    const full = await s.dispatcher.decide(enrichedFrom(g('refund_ch_3SynthU01Chg0003_1400'), { email: 'a@b.test' }), 'google_ads');
    expect(full).toMatchObject({ item: { conversionValue: 0 } });
    const ms = await s.dispatcher.decide(enrichedFrom(partial, { email: 'a@b.test' }), 'microsoft');
    expect(ms).toMatchObject({ status: 'pending', item: { AdjustmentType: 'Restate', AdjustmentValue: 7 } });
  });

  it('an older (lower cumulative) refund processed after a newer one never raises the value back', async () => {
    const s = await withOriginal('dry_run');
    await s.store.put(STRIPE_STATE.chargeRefunds, 'ch_3SynthU01Chg0003', { max_cumulative_refunded: 1400 });
    const stale = { ...g('refund_ch_3SynthU01Chg0003_1400'), event_id: 'refund_ch_3SynthU01Chg0003_700', cash_value_minor: -700 };
    expect(await s.dispatcher.decide(enrichedFrom(stale, { email: 'a@b.test' }), 'google_ads')).toMatchObject({ status: 'skipped', reason: 'superseded_by_later_refund' });
  });

  it('Google adjusts only conversions it provably recorded (else the Data Manager would CREATE one)', () => {
    const rec = { meta: {} } as OutboxRecord;
    expect(adjustmentDependency(rec, 'dry_run')).toBe('ready');
    expect(adjustmentDependency(rec, 'sent')).toBe('ready');
    expect(adjustmentDependency(rec, 'held')).toBe('wait');
    expect(adjustmentDependency(rec, 'skipped')).toBe('unconfirmed');
    expect(adjustmentDependency(rec, null)).toBe('unconfirmed');
    expect(adjustmentDependency({ meta: { original_recorded_by_tag: true } } as unknown as OutboxRecord, null)).toBe('ready');
  });

  it('adjustments past 54 days are skipped', async () => {
    const s = await withOriginal('dry_run');
    s.clock.set(Date.parse('2026-09-27T17:04:12Z'));
    expect(await s.dispatcher.decide(enrichedFrom(g('refund_ch_3SynthU01Chg0003_1400'), { email: 'a@b.test' }), 'google_ads')).toMatchObject({ status: 'skipped', reason: 'adjustment_window_expired' });
  });
});
