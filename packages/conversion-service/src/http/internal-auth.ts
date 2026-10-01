/**
 * Authentication for OpenArt's backend -> POST /events (and /tasks/drain without OIDC).
 * Same construction as Stripe's webhook signatures, so it is familiar and replay-safe:
 *
 *   X-OpenArt-Signal-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Several secrets may be configured (rotation); several v1 values may be sent. Comparison is
 * constant-time; the timestamp must be within the tolerance in either direction.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_SIGNATURE_HEADER = 'x-openart-signal-signature';

export function signInternalBody(secret: string, body: Buffer | string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(body).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export type InternalAuthResult = { ok: true } | { ok: false; reason: 'missing_signature' | 'malformed_signature' | 'timestamp_outside_tolerance' | 'signature_mismatch' };

export function verifyInternalSignature(
  body: Buffer,
  header: string | undefined,
  secrets: readonly string[],
  toleranceSeconds: number,
  nowMs: number,
): InternalAuthResult {
  if (!header) return { ok: false, reason: 'missing_signature' };
  let t: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v && /^\d{9,11}$/.test(v)) t = Number(v);
    if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(Buffer.from(v, 'hex'));
  }
  if (t === null || signatures.length === 0) return { ok: false, reason: 'malformed_signature' };
  if (Math.abs(Math.floor(nowMs / 1000) - t) > toleranceSeconds) return { ok: false, reason: 'timestamp_outside_tolerance' };
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
    if (signatures.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected))) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}
