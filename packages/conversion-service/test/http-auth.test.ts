import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { INTERNAL_SIGNATURE_HEADER, signInternalBody, verifyInternalSignature } from '../src/http/internal-auth.js';
import { verifyStripeWebhook } from '../src/http/stripe-verify.js';
import { verifyPushToken } from '../src/http/oidc.js';

const SECRET = 'offline-test-hmac-key-0123456789abcdef';
const NOW_S = 1_790_000_000;

describe('internal HMAC auth (POST /events, /tasks/drain)', () => {
  const body = Buffer.from(JSON.stringify({ kind: 'credit_ledger_entry' }));

  it('accepts a fresh signature from any configured key (rotation), rejects everything else', () => {
    const header = signInternalBody(SECRET, body, NOW_S);
    expect(header).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(verifyInternalSignature(body, header, ['old-key-0000000000000000000000000000', SECRET], 300, NOW_S * 1000)).toEqual({ ok: true });
    expect(verifyInternalSignature(Buffer.from(`${body} `), header, [SECRET], 300, NOW_S * 1000)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(verifyInternalSignature(body, header, [SECRET], 300, (NOW_S + 301) * 1000)).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect(verifyInternalSignature(body, header, [SECRET], 300, (NOW_S - 301) * 1000)).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect(verifyInternalSignature(body, undefined, [SECRET], 300, NOW_S * 1000)).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyInternalSignature(body, 't=abc,v1=zz', [SECRET], 300, NOW_S * 1000)).toEqual({ ok: false, reason: 'malformed_signature' });
    expect(INTERNAL_SIGNATURE_HEADER).toBe('x-openart-signal-signature');
  });
});

describe('Stripe webhook verification (offline, stripe.webhooks.constructEvent)', () => {
  const secret = 'whsec_offline_test_secret_not_a_real_key';
  const payload = JSON.stringify({ id: 'evt_1Test', object: 'event', type: 'invoice.paid', created: NOW_S, data: { object: {} }, livemode: true, api_version: '2026-08-26.dahlia' });

  it('returns the parsed event for a valid signature and tries every configured secret', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: NOW_S });
    const ev = verifyStripeWebhook(Buffer.from(payload), header, ['whsec_rotated_out_0000000000', secret], 300, NOW_S * 1000 + 5_000);
    expect(ev).toMatchObject({ ok: true, event: { id: 'evt_1Test' } });
  });

  it('rejects tampered bodies, stale timestamps and missing headers', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: NOW_S });
    expect(verifyStripeWebhook(Buffer.from(`${payload} `), header, [secret], 300, NOW_S * 1000)).toMatchObject({ ok: false });
    expect(verifyStripeWebhook(Buffer.from(payload), header, [secret], 300, (NOW_S + 301) * 1000)).toMatchObject({ ok: false });
    expect(verifyStripeWebhook(Buffer.from(payload), undefined, [secret], 300, NOW_S * 1000)).toEqual({ ok: false, reason: 'missing_signature' });
  });
});

describe('OIDC push-token checks (Pub/Sub push, Cloud Scheduler)', () => {
  const verifier = async (token: string, audience: string) => {
    if (token !== 'good' || audience !== 'https://conversion-service.example.run.app') throw new Error('bad token');
    return { email: 'pubsub-push@oa-proj.iam.gserviceaccount.com', email_verified: true };
  };

  it('accepts only a verified token for the expected service account', async () => {
    const ok = await verifyPushToken('Bearer good', { audience: 'https://conversion-service.example.run.app', allowedEmails: ['pubsub-push@oa-proj.iam.gserviceaccount.com'] }, verifier);
    expect(ok).toEqual({ ok: true, email: 'pubsub-push@oa-proj.iam.gserviceaccount.com' });
    expect(await verifyPushToken('Bearer good', { audience: 'https://conversion-service.example.run.app', allowedEmails: ['someone-else@x.iam.gserviceaccount.com'] }, verifier)).toEqual({ ok: false, reason: 'unexpected_principal' });
    expect(await verifyPushToken('Bearer bad', { audience: 'https://conversion-service.example.run.app', allowedEmails: [] }, verifier)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await verifyPushToken(undefined, { audience: 'x', allowedEmails: [] }, verifier)).toEqual({ ok: false, reason: 'missing_token' });
  });
});
