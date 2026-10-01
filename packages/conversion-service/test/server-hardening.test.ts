/**
 * HTTP hardening (review findings): malformed request lines never crash the process, /healthz
 * reveals nothing, Stripe livemode is checked, the scheduled drain always runs, shutdown waits for
 * in-flight requests, GET /value serves the pixel the server's value, POST /tasks/erase erases.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryClickIdStore } from '../src/adapters/click-id-resolver.js';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import { InMemoryLedger } from '../src/adapters/ledger.js';
import { InMemoryUserContext } from '../src/adapters/user-context.js';
import { InMemoryPurchaseValues } from '../src/adapters/value-resolver.js';
import { createApp } from '../src/app.js';
import { demoConfig } from '../src/config.js';
import { MemoryLogger } from '../src/log.js';
import type { Transport } from '../src/outbox/transport.js';
import { PARKED } from '../src/pipeline/pipeline.js';
import { installProcessHandlers } from '../src/process.js';
import { createHttpServer } from '../src/server.js';
import { ManualClock } from '../src/time.js';
import { purchaseValueRows, stripeEvents } from './helpers/fixtures.js';
import { startHarness } from './e2e/harness.js';
import type { Harness } from './e2e/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Write raw bytes to the server and read the raw response (or '' if the socket closes without one). */
function rawRequest(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`no response to ${JSON.stringify(bytes.split('\r\n')[0])}`));
    });
    socket.on('data', (c: Buffer) => (data += c.toString()));
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.write(bytes);
  });
}

describe('malformed request lines never take the process down', () => {
  it('GET ///, GET //[ and friends get a 4xx and the server keeps serving', async () => {
    h = await startHarness({}, '2026-06-03T17:05:00Z');
    for (const target of ['///', '//[', '//[::1', '///..//%', '//x:99999']) {
      const res = await rawRequest(h.port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      expect(res, target).toMatch(/^HTTP\/1\.1 4\d\d /);
    }
    expect((await h.getRaw('/healthz')).status).toBe(200);
  });

  it('a handler that throws after the response started never becomes an unhandled rejection', async () => {
    h = await startHarness({}, '2026-06-03T17:05:00Z');
    const route = (h.app.pipeline as unknown as { drain: () => Promise<unknown> });
    route.drain = async () => {
      throw new Error('boom');
    };
    const res = await h.postSigned('/tasks/drain', {});
    expect(res.status).toBe(500);
    expect((await h.getRaw('/healthz')).status).toBe(200);
  });
});

describe('/healthz', () => {
  it('says ok and nothing else (no mode, no live platforms)', async () => {
    h = await startHarness({}, '2026-06-03T17:05:00Z');
    expect(await h.getRaw('/healthz')).toEqual({ status: 200, json: { status: 'ok' } });
  });
});

describe('Stripe livemode', () => {
  it('a test-mode event is acknowledged and ignored when only live events count', async () => {
    h = await startHarness({}, '2026-06-03T17:05:00Z');
    h.config.stripe.livemode = 'live';
    const inv = structuredClone(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0001')!);
    inv.livemode = false;
    const res = await h.postStripe(JSON.stringify(inv));
    expect(res).toMatchObject({ status: 200, json: { status: 'ignored', reason: 'stripe_livemode_mismatch' } });
    expect(h.ledger.all()).toEqual([]);
    inv.livemode = true;
    expect((await h.postStripe(JSON.stringify(inv))).json).toMatchObject({ status: 'processed' });
  });
});

describe('the scheduled drain always runs', () => {
  it('a failing parked-event sweep is reported and the outbox is still drained', async () => {
    h = await startHarness({}, '2026-06-03T17:05:00Z');
    const query = h.store.query.bind(h.store);
    h.store.query = async (collection, filters, options) => {
      if (collection === PARKED) throw new Error('firestore unavailable');
      return query(collection, filters, options);
    };
    const res = await h.postSigned('/tasks/drain', {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sweep_error: 'firestore unavailable', drain: { requests: 0 } });
  });
});

describe('graceful shutdown', () => {
  it('stops accepting, waits for the in-flight request, then resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transport: Transport = {
      send: async () => {
        await gate;
        return { kind: 'ok', status: 200, dryRun: true };
      },
    };
    const clock = new ManualClock(Date.parse('2026-07-03T17:05:00Z'));
    const app = createApp({
      config: { ...demoConfig('/tmp/unused'), drainAfterIngest: 'sync' },
      clock: clock.now,
      log: new MemoryLogger(),
      store: new InMemoryDocumentStore(),
      ledger: new InMemoryLedger(),
      userContext: new InMemoryUserContext([{ user_id: 'SynthU01StarterMonA1', region: 'US', email: 'synth.u01@example.test', client_user_agent: 'UA' }]),
      clickIdStore: new InMemoryClickIdStore({}),
      purchaseValues: new InMemoryPurchaseValues([]),
      transport,
    });
    const handle = createHttpServer(app);
    await new Promise<void>((r) => handle.server.listen(0, '127.0.0.1', r));
    const port = (handle.server.address() as { port: number }).port;
    const { default: Stripe } = await import('stripe');
    const inv = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0002')!;
    const payload = JSON.stringify(inv);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_offline_test_secret_not_a_real_key', timestamp: Math.floor(clock.now() / 1000) });
    const inFlight = rawRequest(port, `POST /webhooks/stripe HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nStripe-Signature: ${signature}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
    // Wait until the request is inside the transport.
    for (let i = 0; i < 100 && (await app.outbox.all()).every((r) => r.status !== 'in_flight'); i += 1) await new Promise((r) => setTimeout(r, 10));
    let done = false;
    const shutdown = handle.shutdown(5_000).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    await expect(rawRequest(port, 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n')).rejects.toThrow();
    release();
    expect(await inFlight).toMatch(/^HTTP\/1\.1 200 /);
    await shutdown;
    expect(done).toBe(true);
  });
});

describe('process handlers', () => {
  it('an unhandledRejection is logged instead of crashing the process', () => {
    const proc = new EventEmitter();
    const log = new MemoryLogger();
    installProcessHandlers(proc as unknown as NodeJS.Process, log);
    proc.emit('unhandledRejection', new Error('lost promise'), Promise.resolve());
    expect(log.entries).toEqual([expect.objectContaining({ severity: 'ERROR', message: 'process.unhandled_rejection', fields: expect.objectContaining({ error: 'lost promise' }) })]);
  });
});

describe('GET /value: the browser pixel gets exactly the value the server sends', () => {
  const FIRST = 'purchase_in_1SynthU01Inv0001First';
  const invoicePaid = () => stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0001')!;

  it('needs the internal HMAC over the request line, and knows only purchases in the ledger', async () => {
    h = await startHarness({}, '2026-06-03T17:04:43Z');
    expect((await h.getRaw('/value?invoice_id=in_1SynthU01Inv0001First')).status).toBe(401);
    expect(await h.getSigned('/value?invoice_id=in_1SynthU01Inv0001First&max_wait_ms=0')).toMatchObject({ status: 404, json: { error: 'unknown_purchase' } });
    expect((await h.getSigned('/value?invoice_id=not-an-invoice')).status).toBe(400);
  });

  it('asked before the purchase-time score exists: fixes cash_fallback, and the server sends the same value', async () => {
    h = await startHarness({}, '2026-06-03T17:04:43Z');
    await h.postStripe(JSON.stringify(invoicePaid()));
    const res = await h.getSigned('/value?invoice_id=in_1SynthU01Inv0001First&max_wait_ms=0');
    expect(res).toEqual({ status: 200, json: { event_id: FIRST, invoice_id: 'in_1SynthU01Inv0001First', value: 14, currency: 'USD', value_basis: 'cash_fallback', value_floored: false } });
    // The score lands later; the server's send still carries the value the pixel already sent.
    await h.advanceTo(Date.parse('2026-06-03T18:00:00Z'));
    const meta = h.transport.written.map((w) => w.request).find((r) => r.platform === 'meta')!;
    expect((meta.body.data as Array<Record<string, any>>)[0]!.custom_data).toMatchObject({ value: 14, value_basis: 'cash_fallback' });
  });

  it('asked after the score exists: the predicted value, identical to the server send', async () => {
    h = await startHarness({}, '2026-06-03T17:04:43Z');
    await h.postStripe(JSON.stringify(invoicePaid()));
    h.clock.set(Date.parse('2026-06-03T17:05:00Z'));
    const res = await h.getSigned('/value?invoice_id=in_1SynthU01Inv0001First&max_wait_ms=0');
    expect(res.json).toMatchObject({ value: 22.11, currency: 'USD', value_basis: 'predicted_profit_90d' });
    await h.advanceTo(Date.parse('2026-06-03T18:00:00Z'));
    const meta = h.transport.written.map((w) => w.request).find((r) => r.platform === 'meta')!;
    expect((meta.body.data as Array<Record<string, any>>)[0]!.custom_data).toMatchObject({ value: 22.11, value_basis: 'predicted_profit_90d' });
  });

  it('a later purchase (renewal) is valued at cash', async () => {
    h = await startHarness({}, '2026-07-03T17:04:43Z');
    await h.postStripe(JSON.stringify(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0002')!));
    expect((await h.getSigned('/value?invoice_id=in_1SynthU01Inv0002Cycle&max_wait_ms=0')).json).toMatchObject({ value: 14, value_basis: 'cash' });
  });
});

describe('POST /tasks/erase', () => {
  it('needs auth, validates the body, and erases the user', async () => {
    h = await startHarness({}, '2026-06-03T17:04:43Z');
    await h.postStripe(JSON.stringify(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.id === 'evt_1SynthU01InvPaid0001')!));
    expect((await h.postRaw('/tasks/erase', JSON.stringify({ user_id: 'SynthU01StarterMonA1' }), { 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await h.postSigned('/tasks/erase', { nobody: true })).status).toBe(400);
    const res = await h.postSigned('/tasks/erase', { user_id: 'SynthU01StarterMonA1' });
    expect(res).toMatchObject({ status: 200, json: { user_id: 'SynthU01StarterMonA1', ledger: 'deleted' } });
    expect(h.ledger.all()).toEqual([]);
    expect((await h.app.outbox.all()).some((r) => r.user_id === 'SynthU01StarterMonA1')).toBe(false);
  });
});

it('purchase value fixtures include the U01 first purchase (used above)', () => {
  expect(purchaseValueRows().some((s) => s.event_id === 'purchase_in_1SynthU01Inv0001First')).toBe(true);
});
