// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestWindow, runClassicScript, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import {
  FBC_MAX_AGE_SECONDS,
  OPPREF_MAX_AGE_SECONDS,
  SHIM_VERSION,
  runClickIdShim,
  type ShimWindow,
} from '../src/shim';
import { captureAdClickIds, parseClickIdStore, readCookie } from '../../app-patches/src/click-id-keys';

const ORIGINAL_SHIM = readFixture(import.meta.url, './fixtures/original-click-id-shim.js');
const NOW = Date.UTC(2026, 8, 29, 18, 0, 0); // fixed clock

const FULL_LANDING =
  'https://openart.ai/?utm_source=kj_audit&utm_medium=test&utm_campaign=audit_20260929' +
  '&gclid=KJAUDIT_G&fbclid=KJAUDIT_F&msclkid=KJAUDIT_M&rdt_cid=KJAUDIT_R&gbraid=KJAUDIT_GB&wbraid=KJAUDIT_WB' +
  '&ttclid=KJAUDIT_T&twclid=KJAUDIT_X&li_fat_id=KJAUDIT_L&oppref=KJAUDIT_O&im_ref=KJAUDIT_IM&irpid=KJAUDIT_IR';

interface Harness extends TestWindow {
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
}

const opened: TestWindow[] = [];

function open(url: string): Harness {
  const t = createTestWindow({ url });
  opened.push(t);
  const fetchCalls: Harness['fetchCalls'] = [];
  (t.window as unknown as { fetch: unknown }).fetch = (input: string, init?: RequestInit) => {
    fetchCalls.push({ url: input, init });
    return Promise.resolve(undefined);
  };
  return Object.assign(t, { fetchCalls });
}

function storageKeys(h: Harness): string[] {
  const s = h.window.localStorage;
  return Array.from({ length: s.length }, (_, i) => s.key(i)!).sort();
}

function runNew(h: Harness): ReturnType<typeof runClickIdShim> {
  return runClickIdShim(h.window as unknown as ShimWindow, { now: () => NOW });
}

function runOriginal(h: Harness, consoleStub: { log: (...a: unknown[]) => void }): void {
  runClassicScript(h.window, ORIGINAL_SHIM, { console: consoleStub, Date: { now: () => NOW } });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe('parity with the original inline shim (raw/bundles/page_.html)', () => {
  it('writes the same standalone cookies with the same attributes', () => {
    const before = open(FULL_LANDING);
    runOriginal(before, { log: () => undefined });
    const after = open(FULL_LANDING);
    runNew(after);

    for (const key of ['gclid', 'fbclid', 'msclkid', 'rdt_cid', 'gbraid', 'wbraid']) {
      const o = before.jar.find(key);
      const n = after.jar.find(key);
      expect(o, `original wrote ${key}`).toBeDefined();
      expect(n?.value).toBe(o?.value);
      expect(n?.domain).toBe('openart.ai');
      expect(n?.maxAge).toBe(7776000);
      expect(n?.path).toBe('/');
      expect(n?.sameSite).toBe('Lax');
      expect(n?.raw.startsWith(o!.raw)).toBe(true); // identical prefix, only `; Secure` appended
    }
    // ttclid never had a standalone cookie; neither version adds one.
    expect(before.jar.find('ttclid')).toBeUndefined();
    expect(after.jar.find('ttclid')).toBeUndefined();
  });

  it('keeps every oa_ad_clids entry the original wrote, byte for byte', () => {
    const before = open(FULL_LANDING);
    runOriginal(before, { log: () => undefined });
    const after = open(FULL_LANDING);
    runNew(after);

    const o = JSON.parse(readCookie(before.jar.get(), 'oa_ad_clids')!);
    const n = JSON.parse(readCookie(after.jar.get(), 'oa_ad_clids')!);
    for (const key of Object.keys(o)) expect(n[key]).toEqual(o[key]);
    expect(Object.keys(o).sort()).toEqual(['fbclid', 'gbraid', 'gclid', 'msclkid', 'ttclid', 'wbraid']);
    expect(JSON.parse(after.window.localStorage.getItem('oa_ad_clids')!)).toEqual(n);
  });

  it('keeps the Impact behaviour (localStorage + identical POST)', () => {
    const before = open(FULL_LANDING);
    runOriginal(before, { log: () => undefined });
    const after = open(FULL_LANDING);
    runNew(after);

    expect(after.window.localStorage.getItem('impact_clickid')).toBe(before.window.localStorage.getItem('impact_clickid'));
    expect(after.window.localStorage.getItem('impact_irpid')).toBe(before.window.localStorage.getItem('impact_irpid'));
    expect(after.fetchCalls).toHaveLength(1);
    expect(after.fetchCalls).toEqual(before.fetchCalls);
    expect(after.fetchCalls[0]!.url).toBe('/legacy/api/tracking/impact/store-clickid');
    expect(after.fetchCalls[0]!.init?.body).toBe(JSON.stringify({ clickId: 'KJAUDIT_IM' }));
  });

  it('loads Tolt exactly like the original on the production host only', () => {
    const before = open(FULL_LANDING);
    runOriginal(before, { log: () => undefined });
    const after = open(FULL_LANDING);
    runNew(after);
    const o = before.window.document.getElementById('tolt-referral') as unknown as HTMLScriptElement;
    const n = after.window.document.getElementById('tolt-referral') as unknown as HTMLScriptElement;
    expect(n.getAttribute('src')).toBe(o.getAttribute('src'));
    expect(n.getAttribute('data-tolt')).toBe(o.getAttribute('data-tolt'));
    expect(n.async).toBe(true);

    const staging = open('https://staging.openart.ai/?gclid=G');
    runNew(staging);
    expect(staging.window.document.getElementById('tolt-referral')).toBeNull();
  });

  it('does not log click-id values (the original logged every value twice)', () => {
    const originalLog = vi.fn();
    const before = open(FULL_LANDING);
    runOriginal(before, { log: originalLog });
    expect(originalLog).toHaveBeenCalledWith('value', 'KJAUDIT_G');

    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const after = open(FULL_LANDING);
    runNew(after);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });

  it('behaves like the original off *.openart.ai: no cookies, no Impact POST, localStorage only', () => {
    const url = 'https://pageforge-56o.pages.dev/?gclid=G1&im_ref=IM';
    const before = open(url);
    runOriginal(before, { log: () => undefined });
    const after = open(url);
    const result = runNew(after);
    expect(result.isOpenArtHost).toBe(false);
    expect(after.jar.names()).toEqual(before.jar.names());
    expect(after.jar.names()).toEqual([]);
    expect(after.fetchCalls).toHaveLength(0);
    expect(after.window.localStorage.getItem('impact_clickid')).toBe('IM');
    expect(parseClickIdStore(after.window.localStorage.getItem('oa_ad_clids')).gclid?.v).toBe('G1');
  });
});

describe('new keys in oa_ad_clids', () => {
  it('stores rdt_cid, twclid, li_fat_id and oppref next to the original six', () => {
    const h = open(FULL_LANDING);
    runNew(h);
    const store = parseClickIdStore(readCookie(h.jar.get(), 'oa_ad_clids'));
    expect(Object.keys(store).sort()).toEqual(
      ['fbclid', 'gbraid', 'gclid', 'li_fat_id', 'msclkid', 'oppref', 'rdt_cid', 'ttclid', 'twclid', 'wbraid'].sort(),
    );
    expect(store.li_fat_id).toEqual({ v: 'KJAUDIT_L', ts: NOW });
  });

  it('never drops keys it does not overwrite (T2c: gbraid survives a later fbclid landing)', () => {
    const h = open('https://openart.ai/?gbraid=GB_FIRST');
    runClickIdShim(h.window as unknown as ShimWindow, { now: () => NOW - 60_000 });
    h.navigate('https://openart.ai/ai-model/seedance-2-5/?fbclid=F_SECOND');
    runNew(h);
    const store = parseClickIdStore(readCookie(h.jar.get(), 'oa_ad_clids'));
    expect(store.gbraid).toEqual({ v: 'GB_FIRST', ts: NOW - 60_000 });
    expect(store.fbclid).toEqual({ v: 'F_SECOND', ts: NOW });
  });

  it('merges a newer entry that only survived in localStorage', () => {
    const h = open('https://openart.ai/?gclid=G_NEW');
    h.window.localStorage.setItem('oa_ad_clids', JSON.stringify({ wbraid: { v: 'WB_LS', ts: NOW - 5 } }));
    runNew(h);
    const store = parseClickIdStore(readCookie(h.jar.get(), 'oa_ad_clids'));
    expect(store.wbraid?.v).toBe('WB_LS');
    expect(store.gclid?.v).toBe('G_NEW');
  });

  it('ignores invalid click-id values for oa_ad_clids', () => {
    const h = open('https://openart.ai/?gclid=' + encodeURIComponent('bad value<script>'));
    const r = runNew(h);
    expect(r.incoming).toEqual({});
    expect(readCookie(h.jar.get(), 'oa_ad_clids')).toBeUndefined();
  });
});

describe('Meta _fbc', () => {
  it('mints fb.1.<ms>.<fbclid> on .openart.ai for 90 days', () => {
    const h = open('https://openart.ai/?fbclid=IwAR0Abc-123_x');
    const r = runNew(h);
    const fbc = h.jar.find('_fbc');
    expect(r.wrote.fbc).toBe(true);
    expect(fbc?.value).toBe(`fb.1.${NOW}.IwAR0Abc-123_x`);
    expect(fbc?.domain).toBe('openart.ai');
    expect(fbc?.maxAge).toBe(FBC_MAX_AGE_SECONDS);
    expect(fbc?.secure).toBe(true);
  });

  it('keeps an existing _fbc for the same click (creation time must not move)', () => {
    const h = open('https://openart.ai/?fbclid=SAMECLICK');
    h.jar.seed('_fbc', 'fb.1.1790000000000.SAMECLICK');
    runNew(h);
    expect(h.jar.find('_fbc')?.value).toBe('fb.1.1790000000000.SAMECLICK');
  });

  it('replaces _fbc when the landing carries a different fbclid', () => {
    const h = open('https://openart.ai/?fbclid=NEWCLICK');
    h.jar.seed('_fbc', 'fb.1.1790000000000.OLDCLICK');
    runNew(h);
    expect(h.jar.find('_fbc')?.value).toBe(`fb.1.${NOW}.NEWCLICK`);
  });

  it('does not mint _fbc without a valid fbclid', () => {
    const h = open('https://openart.ai/?gclid=G&fbclid=' + encodeURIComponent('x y'));
    runNew(h);
    expect(h.jar.find('_fbc')).toBeUndefined();
  });
});

describe('OpenAI Ads __oppref', () => {
  it('writes __oppref for 30 days so the SDK cookie fallback works on the next page', () => {
    const h = open('https://openart.ai/ai-model/seedance-2-5/?oppref=KJAUDIT_O');
    runNew(h);
    const c = h.jar.find('__oppref');
    expect(c?.maxAge).toBe(OPPREF_MAX_AGE_SECONDS);
    expect(c?.domain).toBe('openart.ai');
    // oaiq-web 0.1.41 reads it with decodeURIComponent(cookie) — same helper here.
    h.navigate('https://openart.ai/home');
    expect(readCookie(h.window.document.cookie, '__oppref')).toBe('KJAUDIT_O');
  });

  it('drops refs outside the click-id pattern, the same rule oa_ad_clids applies', () => {
    const h = open('https://openart.ai/?oppref=' + encodeURIComponent('abc+/=:1'));
    const r = runNew(h);
    expect(r.wrote.oppref).toBe(false);
    expect(h.jar.find('__oppref')).toBeUndefined();
    expect(r.incoming.oppref).toBeUndefined();
  });
});

describe('every stored or posted value passes CLICK_ID_VALUE_PATTERN (review: raw URL values)', () => {
  const BIG = 'A'.repeat(3800); // 3.8 KB: a cookie that size rides on every openart.ai request for 90 days
  const IMG = '<img src=x onerror=alert(document.cookie)>';
  const CLICK_PARAMS = ['gclid', 'fbclid', 'msclkid', 'rdt_cid', 'gbraid', 'wbraid', 'ttclid', 'twclid', 'li_fat_id', 'oppref'];

  it('the original shim stores both payloads verbatim and posts them to the backend (the bug)', () => {
    const h = open(`https://openart.ai/?gclid=${encodeURIComponent(IMG)}&msclkid=${BIG}&im_ref=${encodeURIComponent(IMG)}&irpid=${BIG}`);
    runOriginal(h, { log: () => undefined });
    expect(readCookie(h.jar.get(), 'gclid')).toBe(IMG);
    expect(h.jar.find('msclkid')?.value).toHaveLength(3800);
    expect(h.window.localStorage.getItem('impact_clickid')).toBe(IMG);
    expect(h.window.localStorage.getItem('impact_irpid')).toBe(BIG);
    expect(h.fetchCalls[0]!.init?.body).toBe(JSON.stringify({ clickId: IMG }));
  });

  for (const [label, value] of [
    ['3.8 KB', BIG],
    ['<img…> payload', IMG],
  ] as const) {
    it(`writes no cookie and no storage for a ${label} value on any click-id key`, () => {
      const qs = CLICK_PARAMS.map((k) => `${k}=${encodeURIComponent(value)}`).join('&');
      const h = open(`https://openart.ai/?${qs}&utm_source=ok`);
      const r = runNew(h);
      expect(r.incoming).toEqual({});
      expect(r.wrote).toMatchObject({ standalone: [], oaAdClids: false, fbc: false, oppref: false, utm: true });
      expect(h.jar.names()).toEqual(['oa_utm']);
      expect(storageKeys(h)).toEqual(['oa_utm']);
      expect(h.jar.writes.join('\n')).not.toMatch(/onerror|A{600}/);
    });

    it(`never stores or POSTs a ${label} Impact im_ref / irpid`, () => {
      const h = open(`https://openart.ai/?im_ref=${encodeURIComponent(value)}&irpid=${encodeURIComponent(value)}`);
      const r = runNew(h);
      expect(r.wrote.impactClickId).toBe(false);
      expect(r.wrote.impactPartnerId).toBe(false);
      expect(r.impactPosted).toBe(false);
      expect(h.window.localStorage.getItem('impact_clickid')).toBeNull();
      expect(h.window.localStorage.getItem('impact_irpid')).toBeNull();
      expect(h.fetchCalls).toEqual([]);
    });
  }

  it('keeps valid values that arrive next to invalid ones', () => {
    const h = open(`https://openart.ai/?gclid=G_OK&fbclid=${encodeURIComponent(IMG)}&im_ref=IM_OK-1.2&irpid=${BIG}`);
    const r = runNew(h);
    expect(r.wrote.standalone).toEqual(['gclid']);
    expect(h.jar.find('fbclid')).toBeUndefined();
    expect(h.jar.find('_fbc')).toBeUndefined();
    expect(h.window.localStorage.getItem('impact_clickid')).toBe('IM_OK-1.2');
    expect(h.window.localStorage.getItem('impact_irpid')).toBeNull();
    expect(h.fetchCalls.map((c) => c.init?.body)).toEqual([JSON.stringify({ clickId: 'IM_OK-1.2' })]);
  });

  it('never re-stores an invalid entry already in oa_ad_clids when it rewrites the cookie', () => {
    const h = open('https://openart.ai/?fbclid=F1');
    h.jar.seed(
      'oa_ad_clids',
      encodeURIComponent(
        JSON.stringify({ gclid: { v: IMG, ts: 1 }, msclkid: { v: BIG, ts: 1 }, irclickid: { v: 'IR1', ts: 2 }, 'x-evil': { v: 'X', ts: 3 }, __proto__x: { v: IMG, ts: 4 } }),
      ),
    );
    runNew(h);
    const written = JSON.parse(readCookie(h.jar.get(), 'oa_ad_clids')!);
    expect(written).toEqual({ irclickid: { v: 'IR1', ts: 2 }, fbclid: { v: 'F1', ts: NOW } }); // the edge Worker's extra key survives
    expect(JSON.parse(h.window.localStorage.getItem('oa_ad_clids')!)).toEqual(written);
  });

  it('caps every value at 512 characters (the Suite reader’s limit)', () => {
    const ok = 'B'.repeat(512);
    const h = open(`https://openart.ai/?gclid=${ok}&wbraid=${ok}B`);
    runNew(h);
    expect(h.jar.find('gclid')?.value).toBe(ok);
    expect(h.jar.find('wbraid')).toBeUndefined();
  });
});

describe('first-seen timestamps agree with the Suite capture (review: capture reset ts, the shim kept it)', () => {
  it('the shim and captureAdClickIds write the same oa_ad_clids for the same landing', () => {
    const seeded = encodeURIComponent(JSON.stringify({ gclid: { v: 'G1', ts: 5 }, fbclid: { v: 'F_OLD', ts: 6 }, gbraid: { v: 'GB', ts: 7 } }));
    const url = 'https://openart.ai/home?gclid=G1&fbclid=F_NEW&twclid=X1';
    const viaShim = open(url);
    viaShim.jar.seed('oa_ad_clids', seeded);
    runNew(viaShim);
    const viaSuite = open(url);
    viaSuite.jar.seed('oa_ad_clids', seeded);
    captureAdClickIds({ location: viaSuite.window.location, document: viaSuite.window.document, localStorage: viaSuite.window.localStorage }, { now: NOW });
    const shimStore = parseClickIdStore(readCookie(viaShim.jar.get(), 'oa_ad_clids'));
    expect(shimStore).toEqual(parseClickIdStore(readCookie(viaSuite.jar.get(), 'oa_ad_clids')));
    expect(shimStore.gclid).toEqual({ v: 'G1', ts: 5 });
    expect(shimStore.fbclid).toEqual({ v: 'F_NEW', ts: NOW });
  });

  it('a localStorage copy of the same click id with a later ts does not move the first-seen ts', () => {
    const h = open('https://openart.ai/?gclid=G1');
    h.jar.seed('oa_ad_clids', encodeURIComponent(JSON.stringify({ gclid: { v: 'G1', ts: 5 } })));
    h.window.localStorage.setItem('oa_ad_clids', JSON.stringify({ gclid: { v: 'G1', ts: 50 }, wbraid: { v: 'WB', ts: 40 } }));
    runNew(h);
    const store = parseClickIdStore(readCookie(h.jar.get(), 'oa_ad_clids'));
    expect(store.gclid).toEqual({ v: 'G1', ts: 5 });
    expect(store.wbraid).toEqual({ v: 'WB', ts: 40 });
  });
});

describe('Global Privacy Control and US opt-out signals (review: consent consistency)', () => {
  const setGpc = (h: Harness) => Object.defineProperty(h.window.navigator, 'globalPrivacyControl', { configurable: true, value: true });
  const optOutCookies = [
    `oa_consent=${encodeURIComponent(JSON.stringify({ opt_out_sale_sharing: true }))}`,
    `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: 'granted', opt_out_sale_sharing: true }))}`,
    'usprivacy=1YYN',
  ];

  it('under GPC holds back every ad identifier, Impact and Tolt, and keeps the non-identifying UTM store', () => {
    const h = open(FULL_LANDING);
    setGpc(h);
    const r = runNew(h);
    const w = h.window as unknown as ShimWindow;
    expect(r.consent).toBe('opt_out');
    expect(r.deferred).toBe(true);
    expect(h.jar.names()).toEqual(['oa_utm']);
    expect(storageKeys(h)).toEqual(['oa_utm']);
    expect(h.fetchCalls).toEqual([]);
    expect(h.window.document.getElementById('tolt-referral')).toBeNull();
    expect(w.oaClickIdShim!.pending()).toBeGreaterThan(0);
  });

  for (const cookie of optOutCookies) {
    it(`treats ${decodeURIComponent(cookie)} as a sale/sharing opt-out, and grant() does not release it`, () => {
      const h = open(FULL_LANDING);
      const [name, value] = [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)];
      h.jar.seed(name, value);
      const r = runNew(h);
      expect(r.consent).toBe('opt_out');
      expect(h.jar.find('oa_ad_clids')).toBeUndefined();
      expect(h.jar.find('_fbc')).toBeUndefined();
      (h.window as unknown as ShimWindow).oaClickIdShim!.grant();
      expect(h.jar.find('oa_ad_clids')).toBeUndefined();
      expect(h.fetchCalls).toEqual([]);
    });
  }

  it('an explicit ad_storage grant wins over GPC (the visitor opted back in)', () => {
    const h = open(FULL_LANDING);
    setGpc(h);
    (h.window as unknown as ShimWindow).__oaConsent = { ad_storage: 'granted' };
    const r = runNew(h);
    expect(r.consent).toBe('granted');
    expect(h.jar.find('_fbc')).toBeDefined();
    expect(h.fetchCalls).toHaveLength(1);
  });

  it('grant() releases what GPC held once the CMP records a grant', () => {
    const h = open(FULL_LANDING);
    setGpc(h);
    runNew(h);
    const w = h.window as unknown as ShimWindow;
    w.__oaConsent = { ad_storage: 'granted' };
    w.oaClickIdShim!.grant();
    expect(h.jar.find('oa_ad_clids')).toBeDefined();
    expect(h.jar.find('_fbc')).toBeDefined();
    expect(h.fetchCalls).toHaveLength(1);
    expect(w.oaClickIdShim!.pending()).toBe(0);
  });
});

describe('oa_utm (last non-empty UTM set)', () => {
  it('persists UTMs with a timestamp in cookie and localStorage', () => {
    const h = open(FULL_LANDING);
    runNew(h);
    const utm = JSON.parse(readCookie(h.jar.get(), 'oa_utm')!);
    expect(utm).toEqual({ utm_source: 'kj_audit', utm_medium: 'test', utm_campaign: 'audit_20260929', ts: NOW });
    expect(JSON.parse(h.window.localStorage.getItem('oa_utm')!)).toEqual(utm);
  });

  it('leaves oa_utm untouched on a landing without UTMs', () => {
    const h = open('https://openart.ai/?gclid=G');
    h.jar.seed('oa_utm', encodeURIComponent(JSON.stringify({ utm_source: 'old', ts: 1 })));
    runNew(h);
    expect(JSON.parse(readCookie(h.jar.get(), 'oa_utm')!)).toEqual({ utm_source: 'old', ts: 1 });
  });
});

describe('consent gate (inert unless a CMP signal exists)', () => {
  it('holds every write and the Impact POST while ad_storage is denied, then grants once', () => {
    const h = open(FULL_LANDING);
    const w = h.window as unknown as ShimWindow;
    w.__oaConsent = { ad_storage: 'denied' };
    const r = runNew(h);
    expect(r.deferred).toBe(true);
    expect(h.jar.names()).toEqual([]);
    expect(h.window.localStorage.length).toBe(0);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.window.document.getElementById('tolt-referral')).toBeNull();
    expect(w.oaClickIdShim?.pending()).toBeGreaterThan(0);

    w.oaClickIdShim!.grant();
    expect(h.jar.find('_fbc')).toBeDefined();
    expect(h.jar.find('oa_ad_clids')).toBeDefined();
    expect(h.fetchCalls).toHaveLength(1);
    w.oaClickIdShim!.grant();
    expect(h.fetchCalls).toHaveLength(1); // idempotent
    expect(w.oaClickIdShim!.pending()).toBe(0);
  });

  it('reads the oa_consent cookie shared with edge-attribution when no JS signal is set', () => {
    const denied = open(FULL_LANDING);
    denied.jar.seed('oa_consent', encodeURIComponent(JSON.stringify({ ad_storage: 'denied', analytics_storage: 'granted' })));
    expect(runNew(denied).deferred).toBe(true);
    expect(denied.jar.find('_fbc')).toBeUndefined();

    const granted = open(FULL_LANDING);
    granted.jar.seed('oa_consent', encodeURIComponent(JSON.stringify({ ad_storage: 'granted' })));
    expect(runNew(granted).deferred).toBe(false);

    const garbage = open(FULL_LANDING);
    garbage.jar.seed('oa_consent', '%7Bnot-json');
    expect(runNew(garbage).deferred).toBe(false); // unreadable = no signal = today's behaviour

    const override = open(FULL_LANDING);
    override.jar.seed('oa_consent', encodeURIComponent(JSON.stringify({ ad_storage: 'denied' })));
    (override.window as unknown as ShimWindow).__oaConsent = { ad_storage: 'granted' };
    expect(runNew(override).deferred).toBe(false); // explicit JS signal wins
  });

  it('writes immediately when consent is granted or no signal is present', () => {
    const h = open(FULL_LANDING);
    (h.window as unknown as ShimWindow).__oaConsent = { ad_storage: 'granted' };
    expect(runNew(h).deferred).toBe(false);
    expect(h.jar.find('_fbc')).toBeDefined();
    expect((h.window as unknown as ShimWindow).oaClickIdShim?.version).toBe(SHIM_VERSION);
  });
});

describe('coexistence with the edge-attribution Worker (server-set cookies)', () => {
  it('does not rewrite cookies the edge already set with the same values', () => {
    const h = open('https://openart.ai/?gclid=G1&fbclid=F1&oppref=O1&utm_source=ig');
    // What the Worker's Set-Cookie headers left in the jar before any script ran.
    h.jar.seed('gclid', 'G1');
    h.jar.seed('fbclid', 'F1');
    h.jar.seed('_fbc', `fb.1.${NOW - 1000}.F1`);
    h.jar.seed('__oppref', 'O1');
    const edgeClids = JSON.stringify({ gclid: { v: 'G1', ts: NOW - 1000 }, fbclid: { v: 'F1', ts: NOW - 1000 }, oppref: { v: 'O1', ts: NOW - 1000 } });
    h.jar.seed('oa_ad_clids', encodeURIComponent(edgeClids));
    h.jar.seed('oa_utm', encodeURIComponent(JSON.stringify({ utm_source: 'ig', ts: NOW - 1000 })));

    const r = runNew(h);
    const rewritten = h.jar.writes.map((w) => w.split('=')[0]);
    expect(rewritten).toEqual([]); // nothing downgraded to a JS-set (ITP-capped) cookie
    expect(r.wrote.standalone).toEqual([]);
    expect(readCookie(h.jar.get(), 'oa_ad_clids')).toBe(edgeClids);
    // localStorage still gets the copy the Suite reader merges.
    expect(parseClickIdStore(h.window.localStorage.getItem('oa_ad_clids')).gclid).toEqual({ v: 'G1', ts: NOW - 1000 });
  });

  it('keeps the first-seen ts for a click id it already has and adds only new ones', () => {
    const h = open('https://openart.ai/?gclid=G1&twclid=X1');
    h.jar.seed('oa_ad_clids', encodeURIComponent(JSON.stringify({ gclid: { v: 'G1', ts: 5 } })));
    runNew(h);
    const store = parseClickIdStore(readCookie(h.jar.get(), 'oa_ad_clids'));
    expect(store.gclid).toEqual({ v: 'G1', ts: 5 });
    expect(store.twclid).toEqual({ v: 'X1', ts: NOW });
  });
});

describe('robustness', () => {
  it('never throws when storage and cookies throw', () => {
    const h = open(FULL_LANDING);
    Object.defineProperty(h.window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    Object.defineProperty(h.window.document, 'cookie', {
      configurable: true,
      get: () => '',
      set: () => {
        throw new Error('cookies disabled');
      },
    });
    expect(() => runNew(h)).not.toThrow();
  });

  it('defers the Tolt script until the DOM exists when run at document start', () => {
    let domReady: (() => void) | undefined;
    const appended: unknown[] = [];
    const fakeDoc = {
      cookie: '',
      head: null as null | { appendChild: (n: unknown) => unknown },
      documentElement: null,
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ id: '', src: '', async: false, defer: false, setAttribute: () => undefined }),
      addEventListener: (_type: string, cb: () => void) => {
        domReady = cb;
      },
    };
    const w: ShimWindow = {
      location: { search: '', hostname: 'openart.ai', protocol: 'https:' },
      document: fakeDoc,
      localStorage: null,
    };
    const r = runClickIdShim(w, { now: () => NOW });
    expect(r.toltRequested).toBe(true);
    expect(appended).toHaveLength(0);
    fakeDoc.head = { appendChild: (n: unknown) => appended.push(n) };
    domReady?.();
    expect(appended).toHaveLength(1);
  });
});
