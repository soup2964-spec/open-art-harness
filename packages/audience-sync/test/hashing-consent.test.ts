import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CONSENT_REQUIRED_REGIONS } from '@openart-signal/contracts';
import { describe, expect, it } from 'vitest';
import { consentEligibility } from '../src/consent.js';
import { identifiersFor, memberKey } from '../src/identifiers.js';
import type { AudienceCandidateRow } from '../src/types.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function candidate(over: Partial<AudienceCandidateRow> = {}): AudienceCandidateRow {
  return {
    user_id: 'SynthU02WonderYearB2',
    email: 'synth.u02@example.test',
    phone_e164: null,
    country: 'US',
    computed_at: '2026-09-29T06:00:00Z',
    predicted_profit: 120,
    model_version: 'test',
    is_active_subscriber: false,
    has_refund: false,
    has_chargeback: false,
    is_fraud: false,
    consent: { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted', region: 'US', source: 'regional_default' },
    ...over,
  };
}

describe('hashing vectors per platform (published examples, re-hashed with node:crypto)', () => {
  it('Google Data Manager API: lowercase, strip whitespace, gmail/googlemail dots and +suffix only', () => {
    // Data Manager formatting guide examples and the send-audience-members sample hashes.
    expect(identifiersFor('google_ads', candidate({ email: 'dana@example.com' })).email_sha256).toBe(
      '07e2f1394b0ea80e2adca010ea8318df697001a005ba7452720edda4b0ce57b3',
    );
    expect(identifiersFor('google_ads', candidate({ email: ' DanaM@Example.com ' })).email_sha256).toBe(
      '1df6b43bc68dd38eca94e6a65b4f466ae537b796c81a526918b40ac4a7b906c7',
    );
    // cloudy.sanfrancisco+shopping@gmail.com -> cloudysanfrancisco@gmail.com (223ebda6...)
    expect(identifiersFor('google_ads', candidate({ email: 'cloudy.sanfrancisco+shopping@gmail.com' })).email_sha256).toBe(
      '223ebda6f6889b1494551ba902d9d381daf2f642bae055888e96343d53e9f9c4',
    );
    // Non-Google domains keep dots and plus: user.name+NYC@Example.com -> user.name+nyc@example.com
    expect(identifiersFor('google_ads', candidate({ email: 'user.name+NYC@Example.com' })).email_sha256).toBe(sha256('user.name+nyc@example.com'));
    // E.164 with the plus sign: (800) 555-0100 in the US -> +18005550100 (fb4f73a6...)
    expect(identifiersFor('google_ads', candidate({ phone_e164: '+1 (800) 555-0100' })).phone_sha256).toBe(
      'fb4f73a6ec5fdb7077d564cdd22c3554b43ce49168550c3b12c547b78c517b30',
    );
    expect(identifiersFor('google_ads', candidate()).external_id_sha256).toBeUndefined();
  });

  it('Meta: email trim + lowercase, phone digits without +, EXTERN_ID = SHA-256 of the lower-cased uid (as the pixel sends it)', () => {
    expect(identifiersFor('meta', candidate({ email: ' Mary@Example.com' })).email_sha256).toBe(
      'f1904cf1a9d73a55fa5de0ac823c4403ded71afd4c3248d00bdcd0866552bb79',
    );
    expect(identifiersFor('meta', candidate({ phone_e164: '+1 555 987 6543' })).phone_sha256).toBe(
      '1ef970831d7963307784fa8688e8fce101a15685d62aa765fed23f3a2c576a4e',
    );
    // Cross-check with the contracts canonical fixture (audience_members.jsonl, SynthU02WonderYearB2).
    const require = createRequire(import.meta.url);
    const canonical = readFileSync(require.resolve('@openart-signal/contracts/fixtures/canonical/audience_members.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { platform: string; identifiers: Record<string, string> })
      .find((r) => r.platform === 'meta')!;
    expect(identifiersFor('meta', candidate())).toEqual({ email_sha256: canonical.identifiers.email_sha256, external_id_sha256: canonical.identifiers.external_id_sha256 });
  });

  it('TikTok: email trim + lowercase, phone E.164 with +', () => {
    // TikTok's normalization page labels this vector "johndoe@gmail.com" but the published hash is janedoe's.
    expect(identifiersFor('tiktok', candidate({ email: 'JaneDoe@gmail.com ' })).email_sha256).toBe(
      'd6117306485ed0e50afab3ac871e98f81699151f30281527d63ff5f233656c69',
    );
    expect(identifiersFor('tiktok', candidate({ phone_e164: '+14155550100' })).phone_sha256).toBe(sha256('+14155550100'));
  });

  it('never reuses one platform normalisation for another (Gmail dots matter only to Google)', () => {
    const c = candidate({ email: 'Jane.Doe+ads@gmail.com' });
    expect(identifiersFor('google_ads', c).email_sha256).toBe(sha256('janedoe@gmail.com'));
    expect(identifiersFor('meta', c).email_sha256).toBe(sha256('jane.doe+ads@gmail.com'));
    expect(identifiersFor('tiktok', c).email_sha256).toBe(sha256('jane.doe+ads@gmail.com'));
  });

  it('emits lowercase 64-char hex only, and skips values that are not emails or E.164 phones', () => {
    const ids = identifiersFor('meta', candidate({ email: 'not-an-email', phone_e164: '4155550100' }));
    expect(ids).toEqual({ external_id_sha256: sha256('synthu02wonderyearb2') });
    for (const v of Object.values(identifiersFor('google_ads', candidate({ phone_e164: '+14155550100' })))) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it('member keys depend on the identifiers only (the diff key)', () => {
    expect(memberKey({ email_sha256: 'a', phone_sha256: 'b' })).toBe(memberKey({ phone_sha256: 'b', email_sha256: 'a' }));
    expect(memberKey({ email_sha256: 'a' })).not.toBe(memberKey({ email_sha256: 'a', phone_sha256: 'b' }));
  });
});

describe('consent gate (finding 7: contracts CONSENT_REQUIRED_REGIONS; default-eligible outside them)', () => {
  const consent = (over: Partial<AudienceCandidateRow['consent']>) => ({ ...candidate().consent, ...over });
  const UNKNOWN = { ad_storage: 'unknown', ad_user_data: 'unknown', ad_personalization: 'unknown', analytics_storage: 'unknown', source: 'none' } as const;

  it('uses the shared contracts region list, including the EU territories geolocation reports separately', () => {
    // The old local list missed the outermost regions and Aland: they are EU territory.
    for (const region of ['RE', 'GF', 'GP', 'MQ', 'YT', 'MF', 'AX', 'DE', 'FR', 'GB', 'CH', 'NO', 'IS', 'LI']) {
      expect(CONSENT_REQUIRED_REGIONS.has(region), region).toBe(true);
      expect(consentEligibility(candidate({ country: region, consent: consent({ region }) })).reason, region).toBe('consent_required_needs_cmp_grant');
      expect(consentEligibility(candidate({ country: region, consent: consent({ region, source: 'cmp' }) })).eligible, region).toBe(true);
    }
    // Subdivision codes resolve to their country; "UK" is the GB alias.
    expect(consentEligibility(candidate({ country: null, consent: consent({ region: 'GB-ENG' }) })).eligible).toBe(false);
    expect(consentEligibility(candidate({ country: null, consent: consent({ region: 'UK' }) })).eligible).toBe(false);
    expect(consentEligibility(candidate({ consent: consent({ region: 'US-CA' }) })).eligible).toBe(true);
  });

  it('outside consent-required regions a user is eligible by default, with no signal recorded', () => {
    expect(consentEligibility(candidate({ consent: { ...UNKNOWN, region: 'US' } }))).toEqual({ eligible: true, reason: 'default_eligible' });
    expect(consentEligibility(candidate({ country: 'BR', consent: { ...UNKNOWN, region: 'BR' } })).eligible).toBe(true);
    // Granted signals (CMP or regional default) are of course eligible too.
    expect(consentEligibility(candidate()).eligible).toBe(true);
  });

  it('GPC or a US-state sale/sharing opt-out blocks the user everywhere, a CMP grant included', () => {
    expect(consentEligibility(candidate({ consent: { ...UNKNOWN, region: 'US', gpc: true } }))).toEqual({ eligible: false, reason: 'opted_out_gpc_or_sale_sharing' });
    expect(consentEligibility(candidate({ consent: { ...UNKNOWN, region: 'US-CA', opt_out_sale_sharing: true } })).reason).toBe('opted_out_gpc_or_sale_sharing');
    expect(consentEligibility(candidate({ country: 'DE', consent: consent({ region: 'DE', source: 'cmp', gpc: true }) })).eligible).toBe(false);
    expect(consentEligibility(candidate({ consent: { ...UNKNOWN, region: 'US', gpc: false, opt_out_sale_sharing: false } })).eligible).toBe(true);
  });

  it('any explicit denial blocks the user, whatever its source and region', () => {
    for (const signal of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'] as const) {
      expect(consentEligibility(candidate({ consent: { ...UNKNOWN, region: 'US', [signal]: 'denied' } })), signal).toEqual({ eligible: false, reason: 'explicit_denial' });
    }
    expect(consentEligibility(candidate({ consent: consent({ ad_user_data: 'denied', source: 'regional_default' }) })).reason).toBe('explicit_denial');
  });

  it('inside consent-required regions both ad_user_data and ad_personalization need an explicit CMP grant', () => {
    expect(consentEligibility(candidate({ country: 'FR', consent: consent({ region: 'FR', source: 'cmp', ad_personalization: 'unknown' }) })).reason).toBe('consent_required_needs_cmp_grant');
    expect(consentEligibility(candidate({ country: 'FR', consent: consent({ region: 'FR', source: 'regional_default' }) })).reason).toBe('consent_required_needs_cmp_grant');
    expect(consentEligibility(candidate({ country: 'FR', consent: { ...UNKNOWN, region: 'FR' } })).eligible).toBe(false);
  });

  it('treats an unknown region as consent-required (fail closed)', () => {
    expect(consentEligibility(candidate({ country: null, consent: consent({ region: null }) })).reason).toBe('unknown_region_needs_cmp_grant');
    expect(consentEligibility(candidate({ country: null, consent: consent({ region: 'XX' }) })).reason).toBe('unknown_region_needs_cmp_grant');
    expect(consentEligibility(candidate({ country: null, consent: consent({ region: null, source: 'cmp' }) })).eligible).toBe(true);
  });

  it('uses the stricter of the consent region and the account country', () => {
    // Consent recorded while travelling in the US, but the account country is Germany.
    expect(consentEligibility(candidate({ country: 'DE', consent: consent({ region: 'US' }) })).eligible).toBe(false);
    expect(consentEligibility(candidate({ country: 'US', consent: consent({ region: 'RE' }) })).eligible).toBe(false);
  });
});
