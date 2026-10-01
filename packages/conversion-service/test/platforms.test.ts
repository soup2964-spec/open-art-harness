import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { PLATFORM_MODULES, validateRequest } from '../src/platforms/registry.js';
import { oauth1Header, oauth1Signature } from '../src/platforms/x/oauth1.js';
import type { ResolvedValue } from '../src/types.js';
import { CASH_14, PREDICTED_22_11, SYNTH_IP, SYNTH_UA, build, enrichedFrom, requestFor, sendConsent, testConfig, valueOf } from './helpers/enriched.js';
import { goldenLedgerRows } from './helpers/fixtures.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const golden = goldenLedgerRows();
const g = (id: string): ConversionLedgerEvent => structuredClone(golden.find((r) => r.event_id === id)!);

const PREDICTED: ResolvedValue = PREDICTED_22_11;
const U01_EMAIL = 'synth.u01@example.test';
const firstPurchase = () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL, value: PREDICTED });
const renewal = () => enrichedFrom(g('purchase_in_1SynthU01Inv0002Cycle'), { email: U01_EMAIL, value: CASH_14 });

function expectValid(req: { platform: never; action: never; body: Record<string, unknown> } | ReturnType<typeof requestFor>) {
  const v = validateRequest(req as never);
  expect(v.errors).toEqual([]);
}

describe('Google Data Manager builder', () => {
  it('purchase_first: transactionId = the tag oid sub_<invoiceId>, predicted value, gclid+gbraid, hashed email, NEW customer', () => {
    const e = firstPurchase();
    e.row.click_ids = { ...e.row.click_ids, gbraid: { value: '0AAAAASYNTHgbraidU01', created_at: '2026-06-02T14:57:40.000Z' } };
    const r = build('google_ads', e);
    expect(r).toMatchObject({ ok: true, batchKey: '1000000000:9000000004' });
    const req = requestFor('google_ads', r);
    expectValid(req);
    expect(req.url).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(req.body).toMatchObject({
      destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1000000000' }, productDestinationId: '9000000004' }],
      encoding: 'HEX',
      validateOnly: true,
    });
    expect((req.body.events as unknown[])[0]).toEqual({
      transactionId: 'sub_in_1SynthU01Inv0001First',
      eventTimestamp: '2026-06-03T17:04:11Z',
      eventSource: 'WEB',
      conversionValue: 22.11,
      currency: 'USD',
      adIdentifiers: { gclid: 'Cj0KCQjwSYNTHgclidU01', gbraid: '0AAAAASYNTHgbraidU01' },
      userData: { userIdentifiers: [{ emailAddress: sha(U01_EMAIL) }] },
      eventDeviceInfo: { userAgent: SYNTH_UA, ipAddress: SYNTH_IP },
      userProperties: { customerType: 'NEW' },
    });
  });

  it('signup: transactionId reg_<uid> on the (dead-tag) signup action; no value', () => {
    const r = build('google_ads', enrichedFrom(g('reg_SynthU05FreeTrialE5x'), { email: 'synth.u05@example.test' }));
    const req = requestFor('google_ads', r);
    expectValid(req);
    expect((req.body.events as Array<Record<string, unknown>>)[0]).toMatchObject({ transactionId: 'reg_SynthU05FreeTrialE5x' });
    expect((req.body.events as Array<Record<string, unknown>>)[0]).not.toHaveProperty('conversionValue');
  });

  it('refund adjustment: same transactionId and conversion action as the original, restated value', () => {
    const refund = enrichedFrom(g('refund_ch_3SynthU01Chg0003_1400'), { email: U01_EMAIL });
    const original = { ...g('purchase_in_1SynthU01Inv0002Cycle'), event_id: 'purchase_in_1SynthU01Inv0003Cycle', order_id: 'sub_in_1SynthU01Inv0003Cycle', invoice_id: 'in_1SynthU01Inv0003Cycle', occurred_at: '2026-08-03T17:04:11Z' };
    const r = PLATFORM_MODULES.google_ads.buildAdjustment!({ event: refund, original, restatedValue: 0, currency: 'USD', full: true, consent: sendConsent('google_ads'), config: testConfig() });
    expect(r).toMatchObject({ ok: true, batchKey: '1000000000:9000000005' });
    const req = requestFor('google_ads', r, testConfig(), 'ADJUST');
    expectValid(req);
    expect((req.body.events as unknown[])[0]).toEqual({
      transactionId: 'sub_in_1SynthU01Inv0003Cycle',
      eventTimestamp: '2026-08-03T17:04:11Z',
      conversionValue: 0,
      currency: 'USD',
      userData: { userIdentifiers: [{ emailAddress: sha(U01_EMAIL) }] },
    });
  });

  it('refuses events without any identifier, and unconfigured destinations', () => {
    const noIds = enrichedFrom({ ...g('purchase_in_1SynthU01Inv0001First'), click_ids: {} }, { context: {}, value: PREDICTED });
    expect(build('google_ads', noIds)).toEqual({ ok: false, reason: 'no_match_keys' });
    expect(build('google_ads', firstPurchase(), testConfig({ google: { ...testConfig().google, conversionActions: {} } }))).toEqual({ ok: false, reason: 'destination_not_configured' });
  });

  it('schema rejects what the API rejects: no identifiers, value without currency, hyphenated customer id, non-hex hash', () => {
    const req = requestFor('google_ads', build('google_ads', firstPurchase()));
    const event = (req.body.events as Array<Record<string, unknown>>)[0]!;
    const bad = (mut: (b: Record<string, any>) => void) => {
      const body = structuredClone(req.body) as Record<string, any>;
      mut(body);
      return validateRequest({ platform: 'google_ads', action: 'SEND', body }).valid;
    };
    expect(bad(() => undefined)).toBe(true);
    expect(bad((b) => { delete b.events[0].adIdentifiers; delete b.events[0].userData; delete b.events[0].eventDeviceInfo; })).toBe(false);
    expect(bad((b) => { delete b.events[0].currency; })).toBe(false);
    expect(bad((b) => { b.destinations[0].operatingAccount.accountId = '100-000-0000'; })).toBe(false);
    expect(bad((b) => { b.events[0].userData.userIdentifiers[0].emailAddress = 'synth.u01@example.test'; })).toBe(false);
    expect(bad((b) => { b.events[0].eventSource = 'OTHER'; })).toBe(false);
    expect(event.transactionId).toBe('sub_in_1SynthU01Inv0001First');
  });
});

describe('Meta CAPI builder', () => {
  it('Purchase: pixel event_id, lower-cased-uid external_id, fbc, value = predicted profit + predicted_ltv, website', () => {
    const e = firstPurchase();
    e.fbc = 'fb.1.1780412260000.IwAR3SYNTHfbclidU01';
    const req = requestFor('meta', build('meta', e));
    expectValid(req);
    expect(req.url).toBe('https://graph.facebook.com/v26.0/843671884361709/events');
    expect(req.body).toEqual({
      data: [
        {
          event_name: 'Purchase',
          event_time: Math.floor(Date.parse('2026-06-03T17:04:11Z') / 1000),
          event_id: 'purchase_in_1SynthU01Inv0001First',
          event_source_url: 'https://openart.ai/suite/subscriptions',
          action_source: 'website',
          user_data: {
            em: [sha(U01_EMAIL)],
            external_id: [sha('synthu01startermona1')],
            client_ip_address: SYNTH_IP,
            client_user_agent: SYNTH_UA,
            fbc: 'fb.1.1780412260000.IwAR3SYNTHfbclidU01',
            subscription_id: 'sub_1SynthU01Starter000001',
          },
          custom_data: { value: 22.11, currency: 'USD', order_id: 'sub_in_1SynthU01Inv0001First', predicted_ltv: 22.11, value_basis: 'predicted_profit_90d' },
          data_processing_options: [],
        },
      ],
    });
  });

  it('renewals are system_generated custom events (no event_source_url or UA needed)', () => {
    const e = renewal();
    e.context = {};
    const req = requestFor('meta', build('meta', e));
    expectValid(req);
    expect((req.body.data as Array<Record<string, unknown>>)[0]).toMatchObject({ event_name: 'purchase_renewal', action_source: 'system_generated', event_id: 'purchase_in_1SynthU01Inv0002Cycle' });
    expect((req.body.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty('event_source_url');
  });

  it('a website event without the browser user agent is not built (Meta rejects the whole batch)', () => {
    const e = firstPurchase();
    e.context = {};
    expect(build('meta', e)).toEqual({ ok: false, reason: 'meta_website_event_requires_client_user_agent' });
  });

  it('schema rejects ms timestamps, Purchase without value, website without UA, LDU without country/state', () => {
    const req = requestFor('meta', build('meta', firstPurchase()));
    const bad = (mut: (b: Record<string, any>) => void) => {
      const body = structuredClone(req.body) as Record<string, any>;
      mut(body);
      return validateRequest({ platform: 'meta', action: 'SEND', body }).valid;
    };
    expect(bad((b) => { b.data[0].event_time = Date.parse('2026-06-03T17:04:11Z'); })).toBe(false);
    expect(bad((b) => { delete b.data[0].custom_data.value; })).toBe(false);
    expect(bad((b) => { delete b.data[0].user_data.client_user_agent; })).toBe(false);
    expect(bad((b) => { b.data[0].data_processing_options = ['LDU']; })).toBe(false);
    expect(bad((b) => { b.data[0].user_data.em = ['synth.u01@example.test']; })).toBe(false);
  });
});

describe('Meta credential errors (OAuthException 190 and permission codes) are retries, not dead letters', () => {
  it('190 invalid/expired token, 102 session, 10 and 2xx permission codes -> credential retry; 100 invalid parameter -> fail', () => {
    const classify = PLATFORM_MODULES.meta.classifyResponse;
    for (const code of [190, 102, 10, 200, 294]) {
      expect(classify(400, { error: { code, type: 'OAuthException', message: 'x' } }, null), String(code)).toMatchObject({ kind: 'retry', auth: true });
    }
    expect(classify(400, { error: { code: 100, type: 'OAuthException', message: 'Invalid parameter' } }, null)).toMatchObject({ kind: 'fail' });
  });
});

describe('TikTok credential codes are retries', () => {
  it('access-token and permission codes in a 200 body retry with auth=true; other non-zero codes fail', () => {
    const classify = PLATFORM_MODULES.tiktok.classifyResponse;
    for (const code of [40001, 40101, 40102, 40104, 40105]) expect(classify(200, { code, message: 'x' }, null), String(code)).toMatchObject({ kind: 'retry', auth: true });
    expect(classify(200, { code: 40002, message: 'bad param' }, null)).toMatchObject({ kind: 'fail' });
  });
});

describe('validation-only requests are flagged so a 2xx is recorded as validated, never sent', () => {
  it('Google validateOnly, Meta/TikTok test_event_code and Reddit test_id set validationOnly; plain live requests do not', () => {
    const on = testConfig();
    on.google.validateOnly = true;
    expect(requestFor('google_ads', build('google_ads', firstPurchase()), on).validationOnly).toBe(true);
    const off = testConfig();
    off.google.validateOnly = false;
    expect(requestFor('google_ads', build('google_ads', firstPurchase()), off).validationOnly).toBe(false);
    const test = testConfig();
    test.meta.testEventCode = 'TEST123';
    test.tiktok.testEventCode = 'TEST456';
    test.reddit.testId = 't2_test';
    expect(requestFor('meta', build('meta', firstPurchase(), test), test).validationOnly).toBe(true);
    expect(requestFor('tiktok', build('tiktok', firstPurchase(), test), test).validationOnly).toBe(true);
    expect(requestFor('reddit', build('reddit', firstPurchase(), test), test).validationOnly).toBe(true);
    expect(requestFor('meta', build('meta', firstPurchase())).validationOnly).toBe(false);
    for (const p of ['linkedin', 'x', 'microsoft'] as const) expect(requestFor(p, build(p, firstPurchase())).validationOnly, p).toBe(false);
  });
});

describe('applyValue: a held item gets its purchase-time value patched in place', () => {
  const provisional = valueOf({ value: 14, basis: 'cash_fallback', pending: true });
  const floored = valueOf({ value: 0.01, raw_value: -4.37, basis: 'predicted_profit_90d', floored: true, predicted_ltv: 0.01, model_version: 'm' });
  const cfg = testConfig();
  const offline = testConfig();
  offline.microsoft.sendMode = 'offline_conversions';

  const cases: Array<[string, Parameters<typeof build>[0], () => ReturnType<typeof enrichedFrom>, ReturnType<typeof testConfig>]> = [
    ['google first purchase', 'google_ads', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['meta first purchase', 'meta', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['tiktok first purchase', 'tiktok', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['reddit first purchase', 'reddit', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['linkedin first purchase', 'linkedin', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['x first purchase', 'x', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['microsoft UET first purchase', 'microsoft', () => enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL }), cfg],
    ['microsoft offline one-time pack', 'microsoft', () => enrichedFrom(g('purchase_cs_live_a1SynthU05Pack00000001'), { email: 'synth.u05@example.test' }), offline],
  ];
  it.each(cases)('%s: applyValue(provisional item, final value) is byte-identical to building with the final value', (_label, platform, event, config) => {
    for (const final of [PREDICTED, floored]) {
      const withProvisional = build(platform, { ...event(), value: provisional }, config);
      const withFinal = build(platform, { ...event(), value: final }, config);
      if (!withProvisional.ok || !withFinal.ok) throw new Error('build failed');
      const patched = PLATFORM_MODULES[platform].applyValue(withProvisional.item, final, config);
      expect(JSON.stringify(patched)).toBe(JSON.stringify(withFinal.item));
      expectValid(PLATFORM_MODULES[platform].buildRequest('SEND', withFinal.batchKey, [patched], config));
    }
  });

  it('Meta tags the payload with value_basis (cash_fallback when no purchase-time score arrived)', () => {
    const r = build('meta', enrichedFrom(g('purchase_in_1SynthU01Inv0001First'), { email: U01_EMAIL, value: valueOf({ value: 14, basis: 'cash_fallback' }) }));
    if (!r.ok) throw new Error('build failed');
    expect((r.item as Record<string, any>).custom_data).toEqual({ value: 14, currency: 'USD', order_id: 'sub_in_1SynthU01Inv0001First', value_basis: 'cash_fallback' });
  });
});

describe('TikTok Events API builder', () => {
  it('Purchase: event_id = the pixel order id sub_<invoiceId>, hashed email/external_id, ttclid, page.url', () => {
    const e = firstPurchase();
    e.row.click_ids = { ttclid: { value: 'E.CPSYNTHttclidU01.1', created_at: '2026-06-02T14:57:40.000Z' } };
    const req = requestFor('tiktok', build('tiktok', e));
    expectValid(req);
    expect(req.url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');
    expect(req.body).toMatchObject({ event_source: 'web', event_source_id: 'D9QOQ5JC77U6RO6J21IG' });
    expect((req.body.data as unknown[])[0]).toEqual({
      event: 'Purchase',
      event_time: Math.floor(Date.parse('2026-06-03T17:04:11Z') / 1000),
      event_id: 'sub_in_1SynthU01Inv0001First',
      user: { email: sha(U01_EMAIL), external_id: sha('synthu01startermona1'), ttclid: 'E.CPSYNTHttclidU01.1', ip: SYNTH_IP, user_agent: SYNTH_UA },
      properties: { currency: 'USD', value: 22.11, order_id: 'sub_in_1SynthU01Inv0001First', customer_type: 'new' },
      page: { url: 'https://openart.ai/suite/subscriptions' },
      limited_data_use: false,
    });
  });

  it('schema: limited_data_use needs the IP; external_id must be hashed', () => {
    const req = requestFor('tiktok', build('tiktok', firstPurchase()));
    const bad = (mut: (b: Record<string, any>) => void) => {
      const body = structuredClone(req.body) as Record<string, any>;
      mut(body);
      return validateRequest({ platform: 'tiktok', action: 'SEND', body }).valid;
    };
    expect(bad((b) => { b.data[0].limited_data_use = true; delete b.data[0].user.ip; })).toBe(false);
    expect(bad((b) => { b.data[0].user.external_id = 'SynthU01StarterMonA1'; })).toBe(false);
    expect(bad((b) => { delete b.data[0].page; })).toBe(false);
  });

  it('reads TikTok success/failure from the body code, not just HTTP status', () => {
    expect(PLATFORM_MODULES.tiktok.classifyResponse(200, { code: 0, message: 'OK', data: {} }, null).kind).toBe('ok');
    expect(PLATFORM_MODULES.tiktok.classifyResponse(200, { code: 40002, message: 'Invalid value for data.0.event_id' }, null).kind).toBe('fail');
    expect(PLATFORM_MODULES.tiktok.classifyResponse(200, { code: 40100, message: 'rate limited' }, null).kind).toBe('retry');
  });
});

describe('Reddit CAPI v3 builder', () => {
  it('PURCHASE: conversion_id = SHA-256(sub_<invoiceId>) exactly as the pixel sends it; order_id plaintext; Reddit email normalisation', () => {
    const req = requestFor('reddit', build('reddit', firstPurchase()));
    expectValid(req);
    expect(req.url).toBe('https://ads-api.reddit.com/api/v3/pixels/a2_j6xo78gpljnf/conversion_events');
    expect((req.body.data as { events: unknown[] }).events[0]).toEqual({
      event_at: Date.parse('2026-06-03T17:04:11Z'),
      action_source: 'WEBSITE',
      type: { tracking_type: 'PURCHASE' },
      event_source_url: 'https://openart.ai/suite/subscriptions',
      metadata: { conversion_id: sha('sub_in_1SynthU01Inv0001First'), order_id: 'sub_in_1SynthU01Inv0001First', currency: 'USD', value: 22.11 },
      user: { email: sha('synthu01@example.test'), external_id: sha('synthu01startermona1'), ip_address: SYNTH_IP, user_agent: SYNTH_UA },
    });
  });

  it('plaintext conversion ids are a config switch; renewals are CUSTOM events with a name', () => {
    const plain = testConfig({ reddit: { ...testConfig().reddit, conversionIdMode: 'plaintext' } });
    const req = requestFor('reddit', build('reddit', firstPurchase(), plain), plain);
    expect((req.body.data as any).events[0].metadata.conversion_id).toBe('sub_in_1SynthU01Inv0001First');
    const ren = requestFor('reddit', build('reddit', renewal()));
    expectValid(ren);
    expect((ren.body.data as any).events[0].type).toEqual({ tracking_type: 'CUSTOM', custom_event_name: 'purchase_renewal' });
  });

  it('schema: CUSTOM needs a name; unknown properties are rejected (additionalProperties: false)', () => {
    const req = requestFor('reddit', build('reddit', renewal()));
    const bad = (mut: (b: Record<string, any>) => void) => {
      const body = structuredClone(req.body) as Record<string, any>;
      mut(body);
      return validateRequest({ platform: 'reddit', action: 'SEND', body }).valid;
    };
    expect(bad((b) => { delete b.data.events[0].type.custom_event_name; })).toBe(false);
    expect(bad((b) => { b.data.events[0].metadata.event_id = 'x'; })).toBe(false);
    expect(bad((b) => { b.data.events[0].event_at = 1780506251; })).toBe(false);
  });
});

describe('LinkedIn CAPI builder', () => {
  it('enterprise_lead: server conversion rule, eventId lead_<id>, SHA256_EMAIL + externalIds', () => {
    const lead = g('lead_6f1d2c3b-0000-4000-8000-00000000a001');
    const req = requestFor('linkedin', build('linkedin', enrichedFrom(lead, { email: 'lead.one@synthetic-brand.example.test' })));
    expectValid(req);
    expect(req.headers).toMatchObject({ 'Linkedin-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'BATCH_CREATE' });
    expect((req.body.elements as unknown[])[0]).toEqual({
      conversion: 'urn:lla:llaPartnerConversion:9000003',
      conversionHappenedAt: Date.parse('2026-09-18T16:20:00Z'),
      eventId: 'lead_6f1d2c3b-0000-4000-8000-00000000a001',
      user: { userIds: [{ idType: 'SHA256_EMAIL', idValue: sha('lead.one@synthetic-brand.example.test') }, { idType: 'PLAINTEXT_IP_ADDRESS', idValue: SYNTH_IP }] },
    });
  });

  it('purchase: conversionValue.amount is a decimal string; eventId = sub_<invoiceId> (the web-fix id)', () => {
    const req = requestFor('linkedin', build('linkedin', firstPurchase()));
    expectValid(req);
    expect((req.body.elements as any)[0]).toMatchObject({ conversionValue: { currencyCode: 'USD', amount: '22.11' }, eventId: 'sub_in_1SynthU01Inv0001First' });
  });

  it('schema rejects a numeric amount and an IPv6 PLAINTEXT_IP_ADDRESS', () => {
    const req = requestFor('linkedin', build('linkedin', firstPurchase()));
    const bad = (mut: (b: Record<string, any>) => void) => {
      const body = structuredClone(req.body) as Record<string, any>;
      mut(body);
      return validateRequest({ platform: 'linkedin', action: 'SEND', body }).valid;
    };
    expect(bad((b) => { b.elements[0].conversionValue.amount = 22.11; })).toBe(false);
    expect(bad((b) => { b.elements[0].user.userIds.push({ idType: 'PLAINTEXT_IP_ADDRESS', idValue: '2001:db8::1' }); })).toBe(false);
  });
});

describe('X Conversion API builder', () => {
  it('purchase: Events Manager event id + conversion_id sub_<invoiceId>, identifiers with IP/UA only alongside a hash', () => {
    const req = requestFor('x', build('x', firstPurchase()));
    expectValid(req);
    expect(req.url).toBe('https://ads-api.x.com/12/measurement/conversions/qwghh');
    expect((req.body.conversions as unknown[])[0]).toEqual({
      conversion_time: '2026-06-03T17:04:11.000Z',
      event_id: 'tw-qwghh-13vj24',
      identifiers: [{ hashed_email: sha(U01_EMAIL) }, { ip_address: SYNTH_IP, user_agent: SYNTH_UA }],
      conversion_id: 'sub_in_1SynthU01Inv0001First',
      value: 22.11,
      price_currency: 'USD',
    });
    const anon = enrichedFrom({ ...g('purchase_in_1SynthU01Inv0001First'), click_ids: {} }, { value: PREDICTED });
    expect(build('x', anon)).toEqual({ ok: false, reason: 'no_match_keys' });
  });

  it('OAuth 1.0a signer reproduces the X documentation example signature', () => {
    const creds = {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    };
    const opts = {
      method: 'POST',
      url: 'https://api.x.com/1.1/statuses/update.json?include_entities=true',
      params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
    };
    // docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
    expect(oauth1Signature(creds, opts)).toBe('Ls93hJiZbQ3akF3HF3x1Bz8/zU4=');
    expect(oauth1Header(creds, opts)).toContain('oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D"');
  });
});

describe('Microsoft builders', () => {
  it('UET CAPI purchase: eventId sub_<invoiceId>, eventName purchase, transactionId, hashed externalId, Microsoft email normalisation', () => {
    const e = firstPurchase();
    e.row.click_ids = { msclkid: { value: 'b1c2d3e4f5a6478899aa000000000004', created_at: '2026-06-02T14:57:40.000Z' } };
    const req = requestFor('microsoft', build('microsoft', e));
    expectValid(req);
    expect(req.url).toBe('https://capi.uet.microsoft.com/v1/187107444/events');
    expect((req.body.data as unknown[])[0]).toEqual({
      eventType: 'custom',
      eventId: 'sub_in_1SynthU01Inv0001First',
      eventName: 'purchase',
      eventTime: Math.floor(Date.parse('2026-06-03T17:04:11Z') / 1000),
      eventSourceUrl: 'https://openart.ai/suite/subscriptions',
      userData: {
        em: sha('synthu01@example.test'),
        externalId: sha('synthu01startermona1'),
        msclkid: 'b1c2d3e4f5a6478899aa000000000004',
        clientIpAddress: SYNTH_IP,
        clientUserAgent: SYNTH_UA,
      },
      customData: { value: 22.11, currency: 'USD', transactionId: 'sub_in_1SynthU01Inv0001First' },
    });
  });

  it('online adjustments: Restate carries value+currency, Retract carries neither', () => {
    const refund = enrichedFrom(g('refund_ch_3SynthU01Chg0003_1400'), { email: U01_EMAIL });
    const original = g('purchase_in_1SynthU01Inv0001First');
    const restate = PLATFORM_MODULES.microsoft.buildAdjustment!({ event: refund, original, restatedValue: 9, currency: 'USD', full: false, consent: sendConsent('microsoft'), config: testConfig() });
    const retract = PLATFORM_MODULES.microsoft.buildAdjustment!({ event: refund, original, restatedValue: 0, currency: 'USD', full: true, consent: sendConsent('microsoft'), config: testConfig() });
    const rq = requestFor('microsoft', restate, testConfig(), 'ADJUST');
    const rt = requestFor('microsoft', retract, testConfig(), 'ADJUST');
    expectValid(rq);
    expectValid(rt);
    expect(rq.headers).toMatchObject({ CustomerId: '100000001', CustomerAccountId: '100000002' });
    expect((rq.body.OnlineConversionAdjustments as unknown[])[0]).toEqual({
      AdjustmentType: 'Restate',
      AdjustmentTime: '2026-08-05T09:12:40.000Z',
      AdjustmentValue: 9,
      AdjustmentCurrencyCode: 'USD',
      ConversionName: 'purchase',
      TransactionId: 'sub_in_1SynthU01Inv0001First',
    });
    expect((rt.body.OnlineConversionAdjustments as unknown[])[0]).toEqual({
      AdjustmentType: 'Retract',
      AdjustmentTime: '2026-08-05T09:12:40.000Z',
      ConversionName: 'purchase',
      TransactionId: 'sub_in_1SynthU01Inv0001First',
    });
    const bad = structuredClone(rt.body) as Record<string, any>;
    bad.OnlineConversionAdjustments[0].AdjustmentValue = 0;
    expect(validateRequest({ platform: 'microsoft', action: 'ADJUST', body: bad }).valid).toBe(false);
  });

  it('PartialErrors in a 200 response are a failure', () => {
    expect(PLATFORM_MODULES.microsoft.classifyResponse(200, { PartialErrors: [{ Code: 5620 }] }, null).kind).toBe('fail');
    expect(PLATFORM_MODULES.microsoft.classifyResponse(200, { PartialErrors: [] }, null).kind).toBe('ok');
  });
});

describe('Microsoft offline conversion import (MICROSOFT_SEND_MODE=offline_conversions)', () => {
  const offline = () => {
    const c = testConfig();
    c.microsoft.sendMode = 'offline_conversions';
    return c;
  };

  it('server-only goals go to ApplyOfflineConversions with hashed email; tag twins are skipped (offline imports never dedupe with UET)', () => {
    const cfg = offline();
    const req = requestFor('microsoft', build('microsoft', renewal(), cfg), cfg);
    expectValid(req);
    expect(req).toMatchObject({
      url: 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply',
      auth: 'microsoft_ads_api',
      headers: { CustomerId: '100000001', CustomerAccountId: '100000002' },
    });
    expect((req.body.OfflineConversions as unknown[])[0]).toEqual({
      ConversionName: 'purchase_renewal',
      ConversionTime: '2026-07-03T17:04:11.000Z',
      ConversionValue: 14,
      ConversionCurrencyCode: 'USD',
      HashedEmailAddress: sha('synthu01@example.test'),
    });
    expect(build('microsoft', firstPurchase(), cfg)).toEqual({ ok: false, reason: 'offline_import_cannot_dedupe_with_uet_tag' });
  });

  it('schema: an offline conversion needs an identifier and a UTC time', () => {
    const cfg = offline();
    const req = requestFor('microsoft', build('microsoft', renewal(), cfg), cfg);
    const bad = (mut: (b: Record<string, any>) => void) => {
      const body = structuredClone(req.body) as Record<string, any>;
      mut(body);
      return validateRequest({ platform: 'microsoft', action: 'SEND', body }).valid;
    };
    expect(bad((b) => { delete b.OfflineConversions[0].HashedEmailAddress; })).toBe(false);
    expect(bad((b) => { b.OfflineConversions[0].ConversionTime = '2026-07-03T10:04:11-07:00'; })).toBe(false);
  });
});

describe('response classification shared rules', () => {
  it('retries 429/5xx (honouring Retry-After) and 401/403 (systemic credential problems), fails other 4xx', () => {
    for (const p of Object.values(PLATFORM_MODULES)) {
      expect(p.classifyResponse(503, { error: 'x' }, null).kind, p.platform).toBe('retry');
      expect(p.classifyResponse(429, { error: 'x' }, '7')).toMatchObject({ kind: 'retry', retryAfterMs: 7000 });
      expect(p.classifyResponse(400, { error: { message: 'bad' } }, null).kind, p.platform).toBe('fail');
      expect(p.classifyResponse(401, { error: 'expired token' }, null).kind, p.platform).toBe('retry');
    }
    expect(PLATFORM_MODULES.meta.classifyResponse(400, { error: { code: 17, message: 'User request limit reached' } }, null).kind).toBe('retry');
  });
});
