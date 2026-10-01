import { describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { createApp } from '../src/app.js';
import { InMemoryClickIdStore } from '../src/adapters/click-id-resolver.js';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { InMemoryLedger } from '../src/adapters/ledger.js';
import { InMemoryUserContext } from '../src/adapters/user-context.js';
import type { UserContext } from '../src/adapters/user-context.js';
import { InMemoryPurchaseValues } from '../src/adapters/value-resolver.js';
import { demoConfig } from '../src/config.js';
import { MemoryLogger } from '../src/log.js';
import { DEAD_LETTERS, INBOX, PARKED } from '../src/pipeline/pipeline.js';
import { ManualClock } from '../src/time.js';
import type { Transport } from '../src/outbox/transport.js';
import { stripeEvents } from './helpers/fixtures.js';

class FlakyLedger extends InMemoryLedger {
  failNext: ((row: ConversionLedgerEvent) => boolean) | null = null;
  override async write(rows: ConversionLedgerEvent[]) {
    if (this.failNext && rows.some(this.failNext)) {
      this.failNext = null;
      throw new Error('ledger unavailable');
    }
    return super.write(rows);
  }
}

function build(users: UserContext[] = [{ user_id: 'SynthU01StarterMonA1', region: 'US', email: 'synth.u01@example.test', client_user_agent: 'UA' }]) {
  const clock = new ManualClock(Date.parse('2026-06-03T17:05:00Z'));
  const store = new InMemoryDocumentStore();
  const ledger = new FlakyLedger();
  const transport: Transport = { send: async () => ({ kind: 'ok', status: 200, dryRun: true }) };
  const log = new MemoryLogger();
  const app = createApp({
    config: { ...demoConfig('/tmp/unused'), drainAfterIngest: 'off' },
    clock: clock.now,
    log,
    store,
    ledger,
    userContext: new InMemoryUserContext(users),
    clickIdStore: new InMemoryClickIdStore({}),
    purchaseValues: new InMemoryPurchaseValues([]),
    transport,
  });
  return { app, store, ledger, clock, log };
}

const u01 = () => stripeEvents('stripe/u01_starter_monthly_renewals_refund.json');
const u04 = () => stripeEvents('stripe/u04_pro_monthly_chargeback.json');

describe('enrichment', () => {
  it('drops invalid experiment_arms entries from the user store instead of dead-lettering the purchase', async () => {
    const { app, ledger, store, log } = build([
      { user_id: 'SynthU01StarterMonA1', region: 'US', email: 'synth.u01@example.test', client_user_agent: 'UA', experiment_arms: { 'suite-default-model-create-image': 'nano-banana-pro', 'bad key!': 'x', 'empty-arm': '' } },
    ]);
    const inv = u01().find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;
    expect(await app.pipeline.ingestStripe(inv)).toMatchObject({ status: 'processed' });
    expect(ledger.all()[0]!.experiment_arms).toEqual({ 'suite-default-model-create-image': 'nano-banana-pro' });
    expect(store.dump(DEAD_LETTERS)).toEqual([]);
    expect(log.entries.some((e) => e.message === 'enrich.experiment_arms_dropped')).toBe(true);
  });

  it('reads the user context, the click ids and the value concurrently', { timeout: 3_000 }, async () => {
    const { enrich } = await import('../src/pipeline/enrich.js');
    let started = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    const barrier = async <T>(v: T): Promise<T> => {
      started += 1;
      if (started === 3) release();
      await all;
      return v;
    };
    const row = { ...stripeRow() };
    const result = await enrich(
      { row, identity: {}, context: {}, consentFromSource: false },
      {
        userContext: { get: () => barrier(null) },
        clickIds: { resolve: () => barrier({ click_ids: {}, utm: {}, fbc: null }) } as never,
        values: { resolve: () => barrier(null) } as never,
        log: new MemoryLogger(),
      },
      Date.parse('2026-06-03T17:05:00Z'),
    );
    expect(result.ok).toBe(true);
  });
});

function stripeRow(): ConversionLedgerEvent {
  return {
    schema_version: 1,
    event_id: 'purchase_in_1SynthU01Inv0002Cycle',
    event_name: 'purchase_renewal',
    occurred_at: '2026-07-03T17:04:11Z',
    source_system: 'stripe',
    source_event_id: 'evt_1SynthU01InvPaid0002',
    user_id: 'SynthU01StarterMonA1',
    device_id: null,
    order_id: 'sub_in_1SynthU01Inv0002Cycle',
    adjusts_event_id: null,
    adjusts_order_id: null,
    cash_value_minor: 1400,
    currency: 'USD',
    invoice_id: 'in_1SynthU01Inv0002Cycle',
    subscription_id: 'sub_1SynthU01Starter000001',
    checkout_session_id: null,
    charge_id: null,
    plan_tier: 'essential',
    plan_tier_code: 1000,
    billing_interval: 'month',
    previous_plan_tier: null,
    credit_pack_quantity: null,
    is_first_purchase: false,
    is_business: false,
    generation: null,
    lead: null,
    click_ids: {},
    utm: {},
    ga_client_id: null,
    ga_session_id: null,
    tolt_referral: null,
    consent: { ad_storage: 'unknown', ad_user_data: 'unknown', ad_personalization: 'unknown', analytics_storage: 'unknown', region: 'US', source: 'none' },
    experiment_arms: {},
  };
}

describe('Pipeline failure semantics', () => {
  it('an infrastructure failure forgets the inbox entry so the sender retries, and the retry succeeds', async () => {
    const { app, store, ledger } = build();
    const inv = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;
    ledger.failNext = () => true;
    await expect(app.pipeline.ingestStripe(inv)).rejects.toThrow('ledger unavailable');
    expect(await store.get(INBOX, 'stripe:evt_1SynthU01InvPaid0001')).toBeNull();
    expect(await app.pipeline.ingestStripe(inv)).toMatchObject({ status: 'processed', event_ids: ['purchase_in_1SynthU01Inv0001First'] });
    expect(await app.pipeline.ingestStripe(inv)).toMatchObject({ status: 'duplicate' });
  });

  it('a parked event whose replay fails is restored, then replayed on the retry', async () => {
    const { app, store, ledger } = build();
    const events = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json');
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    const invoicePayment3 = events.find((e) => e.id === 'evt_1SynthU01InvPay0003')!;
    const others = events.filter((e) => e !== refund && e !== invoicePayment3 && e.type !== 'customer.subscription.updated' && e.type !== 'customer.subscription.deleted');
    for (const e of others) await app.pipeline.ingestStripe(e);
    expect(await app.pipeline.ingestStripe(refund)).toMatchObject({ status: 'parked' });
    ledger.failNext = (row) => row.event_name === 'refund';
    await expect(app.pipeline.ingestStripe(invoicePayment3)).rejects.toThrow('ledger unavailable');
    expect(store.dump(PARKED)).toHaveLength(1);
    await app.pipeline.ingestStripe(invoicePayment3);
    expect(store.dump(PARKED)).toHaveLength(0);
    expect(ledger.all().map((r) => r.event_id)).toContain('refund_ch_3SynthU01Chg0003_1400');
  });

  it('a failed replay never deletes the parked copy first (delete only after a successful apply)', async () => {
    const { app, store, ledger, clock } = build();
    const events = u01();
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    await app.pipeline.ingestStripe(refund);
    const deletes: string[] = [];
    const del = store.delete.bind(store);
    store.delete = async (c, k) => {
      if (c === PARKED) deletes.push(k);
      return del(c, k);
    };
    ledger.failNext = (row) => row.event_name === 'refund';
    clock.set(Date.parse('2026-12-31T00:00:00Z'));
    await expect(app.pipeline.sweepParked()).resolves.toMatchObject({ failed: 1 });
    expect(deletes).toEqual([]);
    expect(store.dump(PARKED)).toHaveLength(1);
  });

  it('the sweep isolates a failing parked event, keeps processing the others, and dead-letters it after N failed sweeps', async () => {
    const { app, store, ledger, clock } = build();
    const refund = u01().find((e) => e.type === 'charge.refunded')!;
    const dispute = u04().find((e) => e.type === 'charge.dispute.created')!;
    await app.pipeline.ingestStripe(refund);
    await app.pipeline.ingestStripe(dispute);
    expect(store.dump(PARKED)).toHaveLength(2);
    clock.set(Date.parse('2026-12-31T00:00:00Z'));
    ledger.failNext = null;
    const failRefunds = (row: ConversionLedgerEvent) => row.event_name === 'refund';
    // Poison: the refund always fails to write.
    const write = ledger.write.bind(ledger);
    ledger.write = async (rows) => {
      if (rows.some(failRefunds)) throw new Error('poison');
      return write(rows);
    };
    const first = await app.pipeline.sweepParked();
    expect(first).toMatchObject({ swept: 2, failed: 1, dead_lettered: 0 });
    expect(ledger.all().map((r) => r.event_id)).toContain('chargeback_dp_1SynthU04Dispute0001');
    expect(store.dump<{ sweep_attempts: number }>(PARKED).map((d) => d.data.sweep_attempts)).toEqual([1]);
    for (let i = 1; i < app.deps.config.parking.maxSweepAttempts; i += 1) await app.pipeline.sweepParked();
    expect(store.dump(PARKED)).toEqual([]);
    expect(store.dump<{ reason: string }>(DEAD_LETTERS).map((d) => d.data.reason)).toEqual(['parked_replay_failed']);
  });

  it('re-parking on a new dependency keeps the original parked_at_ms (the parking deadline never slides)', async () => {
    const { app, store, clock } = build();
    const events = u01();
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    clock.set(refund.created * 1000);
    await app.pipeline.ingestStripe(refund);
    const [first] = store.dump<{ parked_at_ms: number; dependency: string }>(PARKED);
    expect(first!.data.dependency).toMatch(/^pi:/);
    // The payment join arrives, but the purchase row does not exist yet: the refund re-parks on it.
    clock.advance(3_600_000);
    await app.pipeline.ingestStripe(events.find((e) => e.id === 'evt_1SynthU01InvPay0003')!);
    const parked = store.dump<{ parked_at_ms: number; dependency: string }>(PARKED);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.data.dependency).toMatch(/^purchase:/);
    expect(parked[0]!.data.parked_at_ms).toBe(first!.data.parked_at_ms);
  });

  it('maps once more after parking, so a dependency that landed between map and park is not missed until the sweep', async () => {
    const { app, store, ledger } = build();
    const events = u01();
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    const payment3 = events.find((e) => e.id === 'evt_1SynthU01InvPay0003')!;
    for (const e of events.filter((x) => x !== refund && x !== payment3 && x.type !== 'customer.subscription.updated' && x.type !== 'customer.subscription.deleted')) {
      await app.pipeline.ingestStripe(e);
    }
    // Race: the join is satisfied (and its release finds nothing parked) just before the refund's park is written.
    const put = store.put.bind(store);
    let raced = false;
    store.put = async (c, k, d) => {
      if (c === PARKED && !raced) {
        raced = true;
        await app.pipeline.ingestStripe(payment3);
      }
      return put(c, k, d);
    };
    const result = await app.pipeline.ingestStripe(refund);
    expect(result).toMatchObject({ status: 'processed', event_ids: ['refund_ch_3SynthU01Chg0003_1400'] });
    expect(store.dump(PARKED)).toEqual([]);
    expect(ledger.all().map((r) => r.event_id)).toContain('refund_ch_3SynthU01Chg0003_1400');
  });

  it('inbox, parked and dead-letter documents carry the user id (erasure) and an expire_at (TTL)', async () => {
    const { app, store } = build();
    await app.pipeline.ingestStripe(u01().find((e) => e.id === 'evt_1SynthU01InvPaid0001')!);
    await app.pipeline.ingestStripe(u01().find((e) => e.type === 'charge.refunded')!);
    const inbox = store.dump<{ user_id: string | null; expire_at: string }>(INBOX).find((d) => d.key === 'stripe:evt_1SynthU01InvPaid0001')!;
    expect(inbox.data).toMatchObject({ user_id: 'SynthU01StarterMonA1' });
    expect(Date.parse(inbox.data.expire_at)).toBeGreaterThan(Date.parse('2026-07-01T00:00:00Z'));
    const parked = store.dump<{ user_id: string | null; expire_at: string }>(PARKED)[0]!;
    expect(parked.data.user_id).toBe('SynthU01StarterMonA1');
    expect(parked.data.expire_at).toBeDefined();
  });

  it('a concurrent delivery of the same event while the first is still processing is told to retry later', async () => {
    const { app, store } = build();
    await store.create(INBOX, 'stripe:evt_1SynthU01InvPaid0001', { status: 'processing', started_at_ms: Date.parse('2026-06-03T17:04:30Z') });
    const inv = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;
    expect(await app.pipeline.ingestStripe(inv)).toMatchObject({ status: 'in_progress' });
  });
});
