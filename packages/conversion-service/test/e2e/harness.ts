/**
 * End-to-end harness: the real node:http server on 127.0.0.1, in-memory adapters seeded from
 * the contracts fixtures, a manual clock, and the dry-run transport. Stripe payloads are signed
 * offline with the stripe library's generateTestHeaderString; /events calls with the HMAC.
 *
 * advanceTo(t) plays the Cloud Scheduler job (drain every minute) between deliveries: it runs the
 * sweep + drain at every time something becomes due before t (a send held for its purchase-time
 * value, a gate hold reaching its deadline, an adjustment's not-before time, a parking deadline).
 */

import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import type { ClickIdStoreRecordExtended } from '@openart-signal/contracts';
import { HUBSPOT_LEADS, SCENARIO_USERS } from '../../../contracts/src/fixtures/scenarios.js';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { InMemoryClickIdStore } from '../../src/adapters/click-id-resolver.js';
import { InMemoryDocumentStore } from '../../src/adapters/document-store.js';
import { InMemoryLedger } from '../../src/adapters/ledger.js';
import { InMemoryUserContext } from '../../src/adapters/user-context.js';
import type { UserContext } from '../../src/adapters/user-context.js';
import { InMemoryPurchaseValues } from '../../src/adapters/value-resolver.js';
import { demoConfig } from '../../src/config.js';
import type { ServiceConfig } from '../../src/config.js';
import { INTERNAL_SIGNATURE_HEADER, signInternalBody } from '../../src/http/internal-auth.js';
import { MemoryLogger } from '../../src/log.js';
import { DryRunTransport } from '../../src/outbox/transport.js';
import { PARKED } from '../../src/pipeline/pipeline.js';
import type { ParkedDoc } from '../../src/pipeline/pipeline.js';
import { createHttpServer } from '../../src/server.js';
import type { ServerHandle } from '../../src/server.js';
import { ManualClock } from '../../src/time.js';
import type { StripeEvent } from '../../src/ingest/stripe-types.js';
import { DAY_MS } from '../../src/time.js';
import { allStripeEvents, clickIdPayloads, purchaseValueRows, readJsonFixture, readJsonlFixture } from '../helpers/fixtures.js';

export const STRIPE_SECRET = 'whsec_offline_test_secret_not_a_real_key';
export const HMAC_SECRET = 'offline-test-hmac-key-0123456789abcdef';

/** Synthetic browser context OpenArt's backend would have captured at signup/checkout. */
export const SYNTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 (synthetic)';
export const synthIp = (n: number) => `203.0.113.${n}`;

export const ARMS_U01 = { 'suite-default-model-create-image': 'nano-banana-pro', 'suite-default-model-create-video': 'byte-plus-seedance-2' };
export const ARMS_U05 = { 'suite-default-model-create-image': 'gpt-image-2-5', 'suite-default-model-create-video': 'wan3-0' };

/** Extra SYNTHETIC users for consent and web-fix scenarios (not in the contracts fixtures). */
export const EXTRA_USERS = {
  u06: { uid: 'SynthU06GmailSignupF6', email: '  Synth.U06+Promo@GoogleMail.com ', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000006' },
  u07: { uid: 'SynthU07GermanyNoCmp', email: 'synth.u07@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000007' },
  u08: { uid: 'SynthU08CaliforniaOpt', email: 'synth.u08@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000008' },
  u09: { uid: 'SynthU09FranceGranted', email: 'synth.u09@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000009' },
} as const;

export function userContexts(): UserContext[] {
  const U = SCENARIO_USERS;
  const base = (u: { uid: string; email: string; deviceId: string }, n: number, extra: Partial<UserContext> = {}): UserContext => ({
    user_id: u.uid,
    email: u.email,
    device_id: u.deviceId,
    region: 'US',
    client_ip_address: synthIp(n),
    client_user_agent: SYNTH_UA,
    fbp: `fb.1.1780000000000.10000000${n}`,
    ...extra,
  });
  return [
    base(U.u01, 1, { experiment_arms: ARMS_U01 }),
    base(U.u02, 2),
    base(U.u03, 3),
    base(U.u04, 4),
    base(U.u05, 5, { experiment_arms: ARMS_U05 }),
    base(EXTRA_USERS.u06, 6),
    base(EXTRA_USERS.u07, 7, { region: 'DE' }),
    base(EXTRA_USERS.u08, 8, {
      consent: { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted', region: 'US-CA', source: 'cmp' },
    }),
    base(EXTRA_USERS.u09, 9, {
      consent: { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied', analytics_storage: 'granted', region: 'FR', source: 'cmp' },
    }),
  ];
}

/** Which ad-click-ids payload belongs to which scenario user (the fixture values are named after them). */
export function clickIdStore(): InMemoryClickIdStore {
  const { current, extended } = clickIdPayloads();
  const records: Record<string, ClickIdStoreRecordExtended> = {
    [SCENARIO_USERS.u01.uid]: extended[0]!,
    [SCENARIO_USERS.u03.uid]: current[1]!,
    [SCENARIO_USERS.u04.uid]: extended[1]!,
  };
  return new InMemoryClickIdStore(records);
}

export interface Harness {
  app: App;
  handle: ServerHandle;
  clock: ManualClock;
  config: ServiceConfig;
  transport: DryRunTransport;
  ledger: InMemoryLedger;
  store: InMemoryDocumentStore;
  log: MemoryLogger;
  outDir: string;
  port: number;
  postStripe(payload: string): Promise<{ status: number; json: any }>;
  postEvents(body: unknown): Promise<{ status: number; json: any }>;
  postRaw(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; json: any }>;
  /** POST signed with the internal HMAC (e.g. /tasks/drain, /tasks/erase). */
  postSigned(path: string, body: unknown): Promise<{ status: number; json: any }>;
  getRaw(path: string, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
  /** GET signed with the internal HMAC over "GET <path>" (e.g. /value). */
  getSigned(path: string): Promise<{ status: number; json: any }>;
  /** Run the scheduler's sweep + drain at every due time before `target` (the clock ends at the last tick). */
  advanceTo(target: number): Promise<number>;
  purchaseValues: InMemoryPurchaseValues;
  close(): Promise<void>;
}

export async function startHarness(configOverrides: Partial<ServiceConfig> = {}, start = '2026-06-01T00:00:00Z'): Promise<Harness> {
  const outDir = mkdtempSync(join(tmpdir(), 'conversion-service-e2e-'));
  const base = demoConfig(outDir);
  const config: ServiceConfig = {
    ...base,
    drainAfterIngest: 'sync',
    webFixesLive: new Map(),
    ...configOverrides,
  };
  const clock = new ManualClock(Date.parse(start));
  const store = new InMemoryDocumentStore();
  const ledger = new InMemoryLedger();
  const log = new MemoryLogger();
  const transport = new DryRunTransport(outDir, { retainWritten: 100_000 });
  const purchaseValues = new InMemoryPurchaseValues(purchaseValueRows());
  const app = createApp({
    config,
    clock: clock.now,
    log,
    store,
    ledger,
    userContext: new InMemoryUserContext(userContexts()),
    clickIdStore: clickIdStore(),
    purchaseValues,
    transport,
    rng: () => 0.5,
  });
  const handle = createHttpServer(app);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as { port: number }).port;

  const request = (method: 'GET' | 'POST', path: string, body: string | null, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const h = body === null ? headers : { 'Content-Length': String(Buffer.byteLength(body)), ...headers };
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end(body ?? undefined);
    });
  const postRaw = (path: string, body: string, headers: Record<string, string>) => request('POST', path, body, headers);
  const now = () => Math.floor(clock.now() / 1000);

  /** Earliest time after now at which the scheduler would find work. */
  const nextDue = async (): Promise<number | null> => {
    const current = clock.now();
    const times: number[] = [];
    for (const r of await app.outbox.all()) {
      if (r.status === 'pending' || r.status === 'held') times.push(Math.max(r.next_attempt_at_ms, r.not_before_ms ?? 0));
      if (r.status === 'in_flight' && r.lease_until_ms !== null) times.push(r.lease_until_ms);
    }
    for (const p of store.dump<ParkedDoc>(PARKED)) times.push(p.data.parked_at_ms + config.parking.maxParkMs + 1);
    const future = times.filter((t) => t > current);
    return future.length > 0 ? Math.min(...future) : null;
  };
  const advanceTo = async (target: number): Promise<number> => {
    let ticks = 0;
    for (let guard = 0; guard < 5_000; guard += 1) {
      const due = await nextDue();
      if (due === null || due >= target) break;
      clock.set(due);
      await app.pipeline.sweepParked();
      await app.pipeline.drain();
      ticks += 1;
    }
    return ticks;
  };

  return {
    app,
    handle,
    clock,
    config,
    transport,
    ledger,
    store,
    log,
    outDir,
    port,
    postRaw,
    purchaseValues,
    advanceTo,
    postSigned: (path, body) => {
      const raw = JSON.stringify(body);
      return postRaw(path, raw, { 'Content-Type': 'application/json', [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, raw, now()) });
    },
    getRaw: (path, headers = {}) => request('GET', path, null, headers),
    getSigned: (path) => request('GET', path, null, { [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, `GET ${path}`, now()) }),
    postStripe: (payload) =>
      postRaw('/webhooks/stripe', payload, {
        'Content-Type': 'application/json; charset=utf-8',
        'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET, timestamp: Math.floor(clock.now() / 1000) }),
      }),
    postEvents: (body) => {
      const raw = JSON.stringify(body);
      return postRaw('/events', raw, {
        'Content-Type': 'application/json',
        [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, raw, Math.floor(clock.now() / 1000)),
      });
    },
    close: async () => {
      await handle.idle();
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    },
  };
}

/** A USER_SIGNUP_TRIAL ledger entry in the exact observed shape (synthetic ids). */
export function signupLedgerEntry(uid: string, createdAt: string, uuidTail: string): Record<string, unknown> {
  return {
    id: `019f8a00-0000-7000-8000-${uuidTail.padStart(12, '0')}`,
    sequenceId: 0,
    type: 'ADD',
    amount: 40,
    creditField: 'trial_credit_balance',
    balanceBefore: 0,
    balanceAfter: 40,
    previousSequenceId: null,
    reference: { businessType: 'USER_SIGNUP_TRIAL', businessId: uid },
    idempotencyKey: `USER_SIGNUP_TRIAL:ADD:${uid}`,
    createdAt,
    userId: uid,
    reason: 'New user trial grant',
  };
}

export type Delivery = { at: number; label: string } & ({ kind: 'stripe'; event: StripeEvent } | { kind: 'events'; body: unknown });

/** Every fixture event, delivered 30 s after it happened (U02 arrives 9 days late), in time order. */
export function timeline(): Delivery[] {
  const out: Delivery[] = [];
  for (const event of allStripeEvents()) {
    const late = event.id.includes('U02');
    out.push({ kind: 'stripe', event, at: event.created * 1000 + (late ? 9 * DAY_MS : 30_000), label: event.id });
  }
  const ledger = readJsonFixture<{ entries: Array<{ id: string; createdAt: string }> }>('credit_ledger/u05_observed_shape_trial_and_sdxl.json').entries;
  for (const entry of ledger) out.push({ kind: 'events', body: { kind: 'credit_ledger_entry', entry }, at: Date.parse(entry.createdAt) + 30_000, label: `ledger ${entry.id}` });
  const amp = readJsonlFixture<{ event_time: string; event_type: string }>('amplitude/checkout_and_conversion_reported.jsonl').filter((r) => r.event_type === 'subscription_started');
  for (const row of amp) out.push({ kind: 'events', body: { kind: 'amplitude_event', row }, at: Date.parse(row.event_time) + 30_000, label: 'amplitude subscription_started' });
  const forms = readJsonFixture<Array<{ submittedAt: number; conversionId: string }>>('hubspot/enterprise_form_submissions.json');
  const formContext = (n: number) => ({ region: 'US', client_ip_address: synthIp(n), client_user_agent: SYNTH_UA, event_source_url: 'https://openart.ai/enterprise' });
  out.push({ kind: 'events', at: forms[0]!.submittedAt + 30_000, label: 'hubspot form (ad click)', body: { kind: 'hubspot_form_submission', submission: forms[0], contact_id: String(HUBSPOT_LEADS.adClick.contactId), context: formContext(21) } });
  out.push({ kind: 'events', at: forms[1]!.submittedAt + 30_000, label: 'hubspot form (organic)', body: { kind: 'hubspot_form_submission', submission: forms[1], context: formContext(22) } });
  for (const change of readJsonFixture<Array<{ occurredAt: number; propertyValue: string }>>('hubspot/contact_lifecycle_changes.json')) {
    out.push({ kind: 'events', at: change.occurredAt + 30_000, label: `hubspot ${change.propertyValue}`, body: { kind: 'hubspot_contact_property_change', change, context: { region: 'US' } } });
  }
  // Consent scenarios (synthetic users; their CMP state / region lives in the user store).
  const consentSignup = (u: { uid: string }, iso: string, tail: string) => ({ kind: 'events' as const, at: Date.parse(iso) + 30_000, label: `signup ${u.uid}`, body: { kind: 'credit_ledger_entry', entry: signupLedgerEntry(u.uid, iso, tail) } });
  out.push(consentSignup(EXTRA_USERS.u07, '2026-09-24T18:00:00.000Z', '7'));
  out.push(consentSignup(EXTRA_USERS.u08, '2026-09-24T18:05:00.000Z', '8'));
  out.push(consentSignup(EXTRA_USERS.u09, '2026-09-24T18:10:00.000Z', '9'));
  return out.map((d, i) => ({ d, i })).sort((a, b) => a.d.at - b.d.at || a.i - b.i).map(({ d }) => d);
}

export { HUBSPOT_LEADS, SCENARIO_USERS };
