import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTERNAL_SIGNATURE_HEADER, signInternalBody } from '../src/http/internal-auth.js';
import { DEAD_LETTERS, PARKED } from '../src/pipeline/pipeline.js';
import { stripeEvents } from './helpers/fixtures.js';
import { HMAC_SECRET, STRIPE_SECRET, startHarness } from './e2e/harness.js';
import type { Harness } from './e2e/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('HTTP surface', () => {
  beforeEach(async () => {
    h = await startHarness({}, '2026-06-03T17:05:00Z');
  });

  it('GET /healthz is a bare liveness check: no mode, no live platforms, no secrets', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      import('node:http').then(({ default: http }) =>
        http.get({ host: '127.0.0.1', port: h.port, path: '/healthz' }, (r) => {
          let d = '';
          r.on('data', (c: Buffer) => (d += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: d }));
        }).on('error', reject),
      );
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(res.body).not.toMatch(/whsec|hmac/i);
  });

  it('unknown path 404, wrong method 405 with Allow', async () => {
    expect((await h.postRaw('/nope', '{}', { 'Content-Type': 'application/json' })).status).toBe(404);
    const r = await h.postRaw('/healthz', '{}', { 'Content-Type': 'application/json' });
    expect(r.status).toBe(405);
  });

  it('Stripe webhook: unsigned, wrongly signed and stale-signed requests are 400; nothing is processed', async () => {
    const payload = JSON.stringify(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json')[1]);
    expect((await h.postRaw('/webhooks/stripe', payload, { 'Content-Type': 'application/json' })).json).toEqual({ error: 'invalid_signature' });
    const wrong = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_attacker', timestamp: Math.floor(h.clock.now() / 1000) });
    expect((await h.postRaw('/webhooks/stripe', payload, { 'Content-Type': 'application/json', 'Stripe-Signature': wrong })).status).toBe(400);
    const stale = Stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET, timestamp: Math.floor(h.clock.now() / 1000) - 301 });
    expect((await h.postRaw('/webhooks/stripe', payload, { 'Content-Type': 'application/json', 'Stripe-Signature': stale })).status).toBe(400);
    expect(h.ledger.all()).toEqual([]);
  });

  it('Stripe webhook: unsupported types are acknowledged and ignored; schema-incompatible events are dead-lettered (200, no retry storm)', async () => {
    const other = { ...stripeEvents('stripe/u01_starter_monthly_renewals_refund.json')[1]!, id: 'evt_1Other', type: 'customer.created' };
    expect((await h.postStripe(JSON.stringify(other))).json).toMatchObject({ status: 'ignored', reason: 'unsupported_event_type' });
    const broken = structuredClone(stripeEvents('stripe/u01_starter_monthly_renewals_refund.json')[1]!);
    broken.id = 'evt_1Broken';
    delete (broken.data.object as Record<string, unknown>).lines;
    const res = await h.postStripe(JSON.stringify(broken));
    expect(res).toMatchObject({ status: 200, json: { status: 'dead_lettered', reason: 'stripe_event_schema_invalid' } });
    expect(h.store.dump(DEAD_LETTERS).map((d) => d.key)).toEqual(['stripe:evt_1Broken|schema']);
  });

  it('POST /events requires the HMAC, JSON content type, and a valid envelope; bodies over the limit are 413', async () => {
    const body = JSON.stringify({ kind: 'nope' });
    expect((await h.postRaw('/events', body, { 'Content-Type': 'application/json' })).json).toEqual({ error: 'missing_signature' });
    expect((await h.postRaw('/events', body, { 'Content-Type': 'text/plain', [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, body, Math.floor(h.clock.now() / 1000)) })).status).toBe(415);
    const bad = await h.postEvents({ kind: 'nope' });
    expect(bad).toMatchObject({ status: 400, json: { error: 'invalid_events' } });
    const huge = JSON.stringify({ kind: 'credit_ledger_entry', entry: { pad: 'x'.repeat(h.config.maxBodyBytes) } });
    expect((await h.postRaw('/events', huge, { 'Content-Type': 'application/json', [INTERNAL_SIGNATURE_HEADER]: 't=1,v1=00' })).status).toBe(413);
  });

  it('POST /tasks/drain requires auth', async () => {
    expect((await h.postRaw('/tasks/drain', '{}', { 'Content-Type': 'application/json' })).status).toBe(401);
  });
});

describe('Ordering over HTTP: parking and release', () => {
  it('a refund delivered before its invoice_payment.paid is parked (minimal projection), then released and adjusted normally', async () => {
    h = await startHarness({}, '2026-06-01T00:00:00Z');
    h.config.google.adjustments = 'data_manager_restatement';
    const events = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json');
    const refund = events.find((e) => e.type === 'charge.refunded')!;
    // Real Charges carry billing details; the parked copy must not keep them.
    (refund.data.object as Record<string, unknown>).billing_details = { email: 'synth.u01@example.test', name: 'Synthetic Person' };
    h.clock.set(refund.created * 1000);
    const parked = await h.postStripe(JSON.stringify(refund));
    expect(parked.json).toMatchObject({ status: 'parked', reason: 'refund_before_purchase_join' });
    const stored = h.store.dump<{ event: unknown }>(PARKED);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]!.data.event)).not.toContain('billing_details');
    for (const e of events.filter((x) => x !== refund)) {
      h.clock.set(Math.max(h.clock.now(), e.created * 1000 + 30_000));
      expect((await h.postStripe(JSON.stringify(e))).status).toBe(200);
    }
    expect(h.store.dump(PARKED)).toEqual([]);
    expect(h.ledger.all().map((r) => r.event_id)).toContain('refund_ch_3SynthU01Chg0003_1400');
  });

  it('past the parking deadline, a parked refund is mapped degraded by the scheduled sweep', async () => {
    h = await startHarness({}, '2026-08-05T09:12:40Z');
    const refund = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json').find((e) => e.type === 'charge.refunded')!;
    await h.postStripe(JSON.stringify(refund));
    h.clock.advance(h.config.parking.maxParkMs + 1);
    const raw = '{}';
    const res = await h.postRaw('/tasks/drain', raw, { 'Content-Type': 'application/json', [INTERNAL_SIGNATURE_HEADER]: signInternalBody(HMAC_SECRET, raw, Math.floor(h.clock.now() / 1000)) });
    expect(res.json).toMatchObject({ swept_parked: 1 });
    expect(h.ledger.all().find((r) => r.event_name === 'refund')).toMatchObject({ cash_value_minor: -1400, adjusts_event_id: null });
  });
});

describe('Pub/Sub push alternative', () => {
  it('accepts a push from the configured service account carrying the forwarded Stripe signature; rejects anything else', async () => {
    h = await startHarness(
      {
        oidc: { audience: 'https://conversion-service.example.run.app', pubsubServiceAccount: 'pubsub-push@oa-proj.iam.gserviceaccount.com', schedulerServiceAccount: null },
      },
      '2026-06-03T17:05:00Z',
    );
    (h.app.deps as { idTokenVerifier?: unknown }).idTokenVerifier = async (token: string, audience: string) => {
      if (token !== 'push-token' || audience !== 'https://conversion-service.example.run.app') throw new Error('bad');
      return { email: 'pubsub-push@oa-proj.iam.gserviceaccount.com', email_verified: true };
    };
    const event = stripeEvents('stripe/u01_starter_monthly_renewals_refund.json')[1]!;
    const raw = JSON.stringify(event);
    // Their existing handler already verified this; it forwards the raw body and the original header.
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: STRIPE_SECRET, timestamp: event.created });
    const push = (auth: string, sig: string | undefined) =>
      h.postRaw('/pubsub/stripe', JSON.stringify({ message: { data: Buffer.from(raw).toString('base64'), messageId: '1', attributes: sig ? { stripe_signature: sig } : {} }, subscription: 'projects/p/subscriptions/stripe-events-conversion-service' }), {
        'Content-Type': 'application/json',
        Authorization: auth,
      });
    expect((await push('Bearer wrong', signature)).status).toBe(401);
    expect((await push('Bearer push-token', undefined)).status).toBe(400);
    // Delivered 20 minutes after Stripe signed it: fine for Pub/Sub (tolerance covers Stripe's retry horizon).
    h.clock.set(event.created * 1000 + 20 * 60_000);
    const ok = await push('Bearer push-token', signature);
    expect(ok).toMatchObject({ status: 200, json: { status: 'processed', event_ids: ['purchase_in_1SynthU01Inv0001First'] } });
  });
});
