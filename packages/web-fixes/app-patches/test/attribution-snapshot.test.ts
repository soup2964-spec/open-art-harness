import { describe, expect, it } from 'vitest';
import { decodeAmplitudeCampaignCookie, readAttributionSnapshot, readUtm } from '../src/attribution-snapshot';

/** Cookie values exactly as captured in crawl/teardown2/T1a_home_meta.json (step 1-2). */
const T1A = {
  AMP_MKTG_3e2fda7a5c:
    'JTdCJTIydXRtX2NhbXBhaWduJTIyJTNBJTIyYXVkaXRfMjAyNjA5MjklMjIlMkMlMjJ1dG1fbWVkaXVtJTIyJTNBJTIydGVzdCUyMiUyQyUyMnV0bV9zb3VyY2UlMjIlM0ElMjJral9hdWRpdCUyMiUyQyUyMmdjbGlkJTIyJTNBJTIyS0pBVURJVF9HJTIyJTJDJTIyZmJjbGlkJTIyJTNBJTIyS0pBVURJVF9GJTIyJTJDJTIydHRjbGlkJTIyJTNBJTIyS0pBVURJVF9UJTIyJTdE',
  _gcl_aw: 'GCL.1790701371.KJAUDIT_G',
  _fbc: 'fb.1.1790701395081.KJAUDIT_F',
  ttclid: 'KJAUDIT_T.1790701371000',
};

const cookie = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

describe('decodeAmplitudeCampaignCookie', () => {
  it('decodes the captured AMP_MKTG cookie', () => {
    expect(decodeAmplitudeCampaignCookie(T1A.AMP_MKTG_3e2fda7a5c)).toEqual({
      utm_campaign: 'audit_20260929',
      utm_medium: 'test',
      utm_source: 'kj_audit',
      gclid: 'KJAUDIT_G',
      fbclid: 'KJAUDIT_F',
      ttclid: 'KJAUDIT_T',
    });
    expect(decodeAmplitudeCampaignCookie('%%%')).toBeUndefined();
    expect(decodeAmplitudeCampaignCookie(undefined)).toBeUndefined();
  });
});

describe('readAttributionSnapshot', () => {
  it('prefers oa_ad_clids / oa_utm over vendor and Amplitude cookies', () => {
    const snap = readAttributionSnapshot({
      cookie: cookie({
        ...T1A,
        oa_ad_clids: encodeURIComponent(JSON.stringify({ gclid: { v: 'OA_G', ts: 1 } })),
        oa_utm: encodeURIComponent(JSON.stringify({ utm_source: 'oa', ts: 1 })),
      }),
    });
    expect(snap.clickIds.gclid).toBe('OA_G');
    expect(snap.clickIdSources.gclid).toBe('oa_ad_clids');
    expect(snap.utm).toEqual({ utm_source: 'oa' });
    expect(snap.utmSource).toBe('oa_utm');
  });

  it('falls back to vendor first-party cookies, then Amplitude (visitors from before the new shim)', () => {
    const snap = readAttributionSnapshot({ cookie: cookie(T1A) });
    expect(snap.clickIds).toEqual({ gclid: 'KJAUDIT_G', fbclid: 'KJAUDIT_F', ttclid: 'KJAUDIT_T' });
    expect(snap.clickIdSources).toEqual({ gclid: 'vendor_cookie', fbclid: 'vendor_cookie', ttclid: 'vendor_cookie' });
    expect(snap.utm).toEqual({ utm_source: 'kj_audit', utm_medium: 'test', utm_campaign: 'audit_20260929' });
    expect(snap.utmSource).toBe('amplitude');
    expect(snap.fbc).toBe('fb.1.1790701395081.KJAUDIT_F');

    const ampOnly = readAttributionSnapshot({ cookie: cookie({ AMP_MKTG_3e2fda7a5c: T1A.AMP_MKTG_3e2fda7a5c }) });
    expect(ampOnly.clickIdSources).toEqual({ gclid: 'amplitude', fbclid: 'amplitude', ttclid: 'amplitude' });
  });

  it('reads the remaining vendor cookies defensively', () => {
    const snap = readAttributionSnapshot({
      cookie: cookie({
        _uetmsclkid: '_uetKJAUDIT_M',
        _gcl_gb: 'GCL.1790702328.KJAUDIT_WB',
        li_fat_id: 'KJAUDIT_L',
        _rdt_cid: 'KJAUDIT_R',
        _twclid: encodeURIComponent(JSON.stringify({ twclid: 'KJAUDIT_X', ts: 1 })),
        __oppref: 'KJAUDIT_O',
      }),
    });
    expect(snap.clickIds).toEqual({
      msclkid: 'KJAUDIT_M',
      wbraid: 'KJAUDIT_WB',
      li_fat_id: 'KJAUDIT_L',
      rdt_cid: 'KJAUDIT_R',
      twclid: 'KJAUDIT_X',
      oppref: 'KJAUDIT_O',
    });
  });

  it('reads oa_utm from localStorage when the cookie is gone and rejects junk', () => {
    const storage = { getItem: (k: string) => (k === 'oa_utm' ? JSON.stringify({ utm_source: ' google ', utm_term: 'x'.repeat(300) }) : null) };
    expect(readUtm({ cookie: '', localStorage: storage })).toEqual({ utm: { utm_source: 'google' }, source: 'oa_utm' });
    expect(readUtm({ cookie: 'oa_utm=%7Bbad' })).toEqual({ utm: {}, source: 'none' });
  });
});
