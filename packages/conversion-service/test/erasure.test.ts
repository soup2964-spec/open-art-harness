import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { InMemoryClickIdStore } from '../src/adapters/click-id-resolver.js';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { InMemoryLedger } from '../src/adapters/ledger.js';
import { InMemoryUserContext } from '../src/adapters/user-context.js';
import { InMemoryPurchaseValues } from '../src/adapters/value-resolver.js';
import { demoConfig } from '../src/config.js';
import { HUBSPOT_CONTACTS } from '../src/ingest/internal-events.js';
import { MemoryLogger } from '../src/log.js';
import { ManualClock } from '../src/time.js';
import { readJsonFixture, stripeEvents } from './helpers/fixtures.js';

const U01 = 'SynthU01StarterMonA1';
const U03 = 'SynthU03PlusAddUpgC3';

function build() {
  const clock = new ManualClock(Date.parse('2026-06-01T00:00:00Z'));
  const store = new InMemoryDocumentStore();
  const ledger = new InMemoryLedger();
  const app = createApp({
    config: { ...demoConfig('/tmp/unused'), drainAfterIngest: 'off' },
    clock: clock.now,
    log: new MemoryLogger(),
    store,
    ledger,
    userContext: new InMemoryUserContext([
      { user_id: U01, region: 'US', email: 'synth.u01@example.test', client_user_agent: 'UA' },
      { user_id: U03, region: 'US', email: 'synth.u03@example.test', client_user_agent: 'UA' },
    ]),
    clickIdStore: new InMemoryClickIdStore({}),
    purchaseValues: new InMemoryPurchaseValues([]),
    transport: { send: async () => ({ kind: 'ok', status: 200, dryRun: true }) },
  });
  return { app, store, ledger, clock };
}

function mentions(store: InMemoryDocumentStore, collection: string, needle: string): string[] {
  return store
    .dump(collection)
    .filter((d) => JSON.stringify(d).includes(needle))
    .map((d) => d.key);
}

describe('erasure by user id', () => {
  it('deletes every document that holds the user (outbox, parked, inbox, dead letters, value decisions, Stripe join state) and erases the ledger rows', async () => {
    const { app, store, ledger, clock } = build();
    const u01 = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json');
    const refund = u01.find((e) => e.type === 'charge.refunded')!;
    for (const e of [...u01.filter((x) => x !== refund), ...stripeEvents('stripe/u03_plus_add_on_then_upgrade.json')]) {
      clock.set(Math.max(clock.now(), e.created * 1000 + 30_000));
      await app.pipeline.ingestStripe(e);
    }
    // A second refund whose charge nobody knows: it stays parked (user id on the parked copy).
    const orphan = structuredClone(refund);
    orphan.id = 'evt_1SynthU01OrphanRefund';
    Object.assign(orphan.data.object, { id: 'ch_3SynthU01Unknown0001', payment_intent: 'pi_3SynthU01Unknown0001' });
    await app.pipeline.ingestStripe(orphan);
    await app.pipeline.drain();

    const collections = ['outbox', 'parked', 'inbox', 'value_decisions', 'stripe_subscriptions', 'stripe_payment_intents', 'stripe_charges', 'stripe_invoice_checkout', 'stripe_charge_refunds'];
    expect(collections.flatMap((c) => mentions(store, c, U01)).length).toBeGreaterThan(10);
    const u03Before = collections.flatMap((c) => mentions(store, c, U03)).length;

    const report = await app.eraser.erase({ user_id: U01 });
    expect(report).toMatchObject({ user_id: U01, ledger: 'deleted' });
    expect(report.deleted.outbox).toBeGreaterThan(0);
    for (const c of collections) expect(mentions(store, c, U01), c).toEqual([]);
    // Invoice-keyed join state written without a customer (invoice_payment.paid) is found through the user's purchases.
    expect(mentions(store, 'stripe_payment_intents', 'in_1SynthU01')).toEqual([]);
    expect(mentions(store, 'stripe_charges', 'in_1SynthU01')).toEqual([]);
    expect(ledger.all().some((r) => r.user_id === U01)).toBe(false);
    // Nobody else is touched.
    expect(collections.flatMap((c) => mentions(store, c, U03)).length).toBe(u03Before);
    expect(ledger.all().some((r) => r.user_id === U03)).toBe(true);
  });

  it('erases a HubSpot contact (lead state is keyed by contact id, not by an OpenArt uid)', async () => {
    const { app, store } = build();
    const forms = readJsonFixture<unknown[]>('hubspot/enterprise_form_submissions.json');
    await app.pipeline.ingestInternal({ kind: 'hubspot_form_submission', submission: forms[0] as never, contact_id: '90000000001', context: { region: 'US' } });
    expect(store.dump(HUBSPOT_CONTACTS)).toHaveLength(1);
    const report = await app.eraser.erase({ hubspot_contact_id: '90000000001' });
    expect(report.deleted.hubspot_contacts).toBe(1);
    expect(store.dump(HUBSPOT_CONTACTS)).toEqual([]);
  });

  it('refuses an empty request', async () => {
    const { app } = build();
    await expect(app.eraser.erase({})).rejects.toThrow(/user_id or hubspot_contact_id/);
  });
});
