import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activationEventId,
  canonicalEventId,
  chargebackEventId,
  checkoutStartedEventId,
  enterpriseLeadEventId,
  leadStageChangeEventId,
  metaExternalId,
  purchaseEventId,
  purchaseOrderId,
  redditPixelConversionId,
  refundEventId,
  sha256Hex,
  signupEventId,
  parseBrowserDedupId,
} from '../src/index.js';

/**
 * Vectors come from the sealed replay of OpenArt's live GTM container
 * (research/11_sealed_replay_verification.md §3 and §9): the X pixel sent
 * SHA-256("seal.test@example.com") = 3954eed7…54f0, Reddit sent the hash of the
 * dot-stripped address 466077b2…9270, and Reddit's m.conversionId was
 * SHA-256("sub_SEALTEST_1") = a43ae336….
 */
describe('sha256Hex (pure implementation, runtime-agnostic)', () => {
  it('matches the sealed-replay wire hashes', () => {
    expect(sha256Hex('seal.test@example.com')).toBe(
      '3954eed7e6fa8e044adb47617ff334f24f58ce4ce97ce0cc8c8949891f5f54f0',
    );
    expect(sha256Hex('sealtest@example.com')).toBe(
      '466077b2a66b98bceca9f24700707498fdb8b22dc638b7eb833dd54171c99270',
    );
    expect(sha256Hex('sub_SEALTEST_1')).toBe(
      'a43ae336e15b430db5c860a47f0e664a372829024619bfa8293aef844c2b6b9c',
    );
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('agrees with node:crypto on random and multi-block UTF-8 inputs', () => {
    const inputs = ['abc', 'é漢字🙂', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)];
    for (let i = 0; i < 50; i += 1) inputs.push(randomBytes(1 + i * 7).toString('base64'));
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });
});

describe('event_id rules reuse the ids OpenArt browsers already send', () => {
  const uid = 'Ab1CdE2fGh3IjK4lMn5o'; // synthetic 20-char Firebase-style uid (case-sensitive)
  const invoiceId = 'in_1SYNTHa1b2c3d4e5f6g7h8';

  it('signup = reg_<uid> (Meta CompleteRegistration eventID, OpenAI registration_completed event_id)', () => {
    expect(signupEventId(uid)).toBe(`reg_${uid}`);
    expect(canonicalEventId({ event_name: 'signup', user_id: uid })).toBe(`reg_${uid}`);
  });

  it('purchase event_id = purchase_<invoiceId> (Meta Purchase eventID, OpenAI subscription_created event_id)', () => {
    expect(purchaseEventId(invoiceId)).toBe(`purchase_${invoiceId}`);
    for (const event_name of [
      'purchase_first',
      'purchase_renewal',
      'purchase_upgrade',
      'purchase_add_on',
      'purchase_one_time_pack',
    ] as const) {
      expect(canonicalEventId({ event_name, invoice_id: invoiceId })).toBe(`purchase_${invoiceId}`);
    }
  });

  it('purchase order id = sub_<invoiceId> (Google Ads oid, Reddit transactionId, X conversion_id, TikTok event_id, UET transaction_id)', () => {
    expect(purchaseOrderId(invoiceId)).toBe(`sub_${invoiceId}`);
  });

  it('one-time packs without an invoice fall back to the Checkout Session id', () => {
    expect(canonicalEventId({ event_name: 'purchase_one_time_pack', checkout_session_id: 'cs_live_a1B2' })).toBe(
      'purchase_cs_live_a1B2',
    );
  });

  it('Reddit pixel sends SHA-256 of the order id as m.conversionId', () => {
    expect(redditPixelConversionId('sub_SEALTEST_1')).toBe(
      'a43ae336e15b430db5c860a47f0e664a372829024619bfa8293aef844c2b6b9c',
    );
  });

  it('Meta external_id = SHA-256 of the lower-cased uid (not of the raw case-sensitive uid)', () => {
    expect(metaExternalId(uid)).toBe(createHash('sha256').update(uid.toLowerCase()).digest('hex'));
    expect(metaExternalId(uid)).not.toBe(createHash('sha256').update(uid).digest('hex'));
  });

  it('new (server-only) event ids are deterministic and prefixed', () => {
    expect(activationEventId(uid)).toBe(`activation_${uid}`);
    expect(checkoutStartedEventId('cs_live_x')).toBe('checkout_cs_live_x');
    expect(refundEventId('ch_1Abc', 1400)).toBe('refund_ch_1Abc_1400');
    expect(chargebackEventId('dp_1Abc')).toBe('chargeback_dp_1Abc');
    expect(enterpriseLeadEventId('9b8c7d6e-0000-4000-8000-000000000001')).toBe(
      'lead_9b8c7d6e-0000-4000-8000-000000000001',
    );
    expect(leadStageChangeEventId('12345', 'salesqualifiedlead')).toBe('leadstage_12345_salesqualifiedlead');
  });

  it('rejects ids that would produce ambiguous or empty dedup keys', () => {
    expect(() => signupEventId('')).toThrow();
    expect(() => purchaseEventId('ch_123')).toThrow(/invoice/);
    expect(() => purchaseOrderId('')).toThrow();
    expect(() => refundEventId('ch_1', -5)).toThrow();
    expect(() => canonicalEventId({ event_name: 'purchase_first' })).toThrow();
  });

  it('parses browser dedup ids back to their parts', () => {
    expect(parseBrowserDedupId(`reg_${uid}`)).toEqual({ kind: 'signup', user_id: uid });
    expect(parseBrowserDedupId(`purchase_${invoiceId}`)).toEqual({ kind: 'purchase_event', invoice_id: invoiceId });
    expect(parseBrowserDedupId(`sub_${invoiceId}`)).toEqual({ kind: 'purchase_order', invoice_id: invoiceId });
    // The browser's fallback id when the invoice lookup fails is NOT a stable dedup key (02 §3.2).
    expect(parseBrowserDedupId('sub_Essential_1000_uid_1790000000000')).toEqual({ kind: 'unstable_fallback' });
    expect(parseBrowserDedupId('ob3_plugin-set_abc')).toEqual({ kind: 'unknown' });
  });
});
