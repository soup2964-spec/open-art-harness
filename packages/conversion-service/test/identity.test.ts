import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashIdentity } from '../src/identity.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('hashIdentity (per-platform normalisation, verified with node:crypto)', () => {
  const raw = { email: '  Synth.U06+Promo@GoogleMail.com ', phone: '+1 (650) 555-1212' };
  const id = hashIdentity(raw, 'SynthU06GmailSignupF6');

  it('Google Data Manager: lowercase, strip dots and +suffix only for gmail/googlemail', () => {
    expect(id.email.google_ads).toBe(sha('synthu06@googlemail.com'));
  });

  it('Meta, TikTok, LinkedIn, X: trim + lowercase only', () => {
    for (const p of ['meta', 'tiktok', 'linkedin', 'x'] as const) {
      expect(id.email[p], p).toBe(sha('synth.u06+promo@googlemail.com'));
    }
  });

  it('Reddit and Microsoft: strip dots and +suffix for every domain', () => {
    expect(id.email.reddit).toBe(sha('synthu06@googlemail.com'));
    expect(id.email.microsoft).toBe(sha('synthu06@googlemail.com'));
    const other = hashIdentity({ email: 'synth.u01@example.test' }, 'SynthU01StarterMonA1');
    expect(other.email.reddit).toBe(sha('synthu01@example.test'));
    expect(other.email.google_ads).toBe(sha('synth.u01@example.test'));
    expect(other.email.meta).toBe(sha('synth.u01@example.test'));
  });

  it('phones: Meta digits only, everyone else E.164 with +', () => {
    expect(id.phone.meta).toBe(sha('16505551212'));
    expect(id.phone.google_ads).toBe(sha('+16505551212'));
    expect(id.phone.tiktok).toBe(sha('+16505551212'));
  });

  it('external_id is SHA-256 of the lower-cased uid (the Meta pixel rule), not of the raw uid', () => {
    expect(id.external_id).toBe(sha('synthu06gmailsignupf6'));
    expect(id.external_id).not.toBe(sha('SynthU06GmailSignupF6'));
  });

  it('invalid email or phone yields no hash instead of a wrong one', () => {
    const bad = hashIdentity({ email: 'not-an-email', phone: '555-1212' }, null);
    expect(bad.email).toEqual({});
    expect(bad.phone).toEqual({});
    expect(bad.external_id).toBeNull();
  });
});
