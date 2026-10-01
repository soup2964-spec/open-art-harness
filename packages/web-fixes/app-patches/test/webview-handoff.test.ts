// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestWindow, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import { readAttributionSnapshot } from '../src/attribution-snapshot';
import {
  buildParamHandoffUrl,
  decorateAddressBar,
  getHandoffUrl,
  handoffRequestPath,
  isInAppBrowser,
  parseHandoffResponse,
  presentAuthProviders,
  requestHandoff,
  type FetchLike,
  type HandoffWindow,
} from '../src/webview-handoff';

const DETECTOR_SRC = readFixture(import.meta.url, './fixtures/suite-module-825073-webview-detector.js');
function shippedDetector(userAgent: string): boolean {
  const make = new Function('navigator', DETECTOR_SRC) as (n: { userAgent: string }) => () => boolean;
  return make({ userAgent })();
}

const UAS: Record<string, string> = {
  instagram_ios:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0 (iPhone15,2; iOS 18_6; en_US; en; scale=3.00; 1179x2556; 0)',
  instagram_android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 Instagram 350.0.0.0.0 Android',
  facebook_ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0]',
  tiktok_ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_36.0.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en',
  linkedin: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30',
  android_webview: 'Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36',
  google_app: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/350.0.0 Mobile/15E148 Safari/604.1',
  ios_wkwebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ios_safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  ios_chrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',
  desktop_chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  electron: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.40 Chrome/128 Electron/32 Safari/537.36',
};

describe('isInAppBrowser', () => {
  for (const [name, ua] of Object.entries(UAS)) {
    it(`matches the shipped detector for ${name}`, () => {
      expect(isInAppBrowser(ua)).toBe(shippedDetector(ua));
    });
  }
  it('flags the paid-social webviews and not real browsers', () => {
    expect(isInAppBrowser(UAS.instagram_ios)).toBe(true);
    expect(isInAppBrowser(UAS.tiktok_ios)).toBe(true);
    expect(isInAppBrowser(UAS.ios_safari)).toBe(false);
    expect(isInAppBrowser(UAS.ios_chrome)).toBe(false);
    expect(isInAppBrowser(undefined)).toBe(false);
  });
});

const opened: TestWindow[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (opened.length) await opened.pop()!.close();
});

/** T11a: Instagram webview, ad landing on `/` with fbclid/ttclid/UTMs, then CTA to /home. */
function t11aWindow(fetchImpl?: FetchLike): { t: TestWindow; win: HandoffWindow } {
  const t = createTestWindow({ url: 'https://openart.ai/home', userAgent: UAS.instagram_ios });
  opened.push(t);
  t.jar.seed(
    'oa_ad_clids',
    encodeURIComponent(JSON.stringify({ fbclid: { v: 'KJAUDIT_F', ts: 1 }, ttclid: { v: 'KJAUDIT_T', ts: 1 } })),
  );
  t.jar.seed('oa_utm', encodeURIComponent(JSON.stringify({ utm_source: 'kj_audit', utm_medium: 'test', utm_campaign: 'audit_20260929', ts: 1 })));
  const win = t.window as unknown as HandoffWindow;
  if (fetchImpl) win.fetch = fetchImpl;
  else delete (win as { fetch?: unknown }).fetch;
  return { t, win };
}

function jsonFetch(body: unknown, ok = true): FetchLike & { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const f = (async (input: string, init: RequestInit) => {
    calls.push([input, init]);
    return { ok, json: async () => body };
  }) as FetchLike & { calls: Array<[string, RequestInit]> };
  f.calls = calls;
  return f;
}

describe('getHandoffUrl', () => {
  it('today the overlay copies https://openart.ai/home; param mode restores click ids and UTMs', async () => {
    const { win } = t11aWindow();
    const r = await getHandoffUrl(win);
    expect(r.mode).toBe('params');
    const u = new URL(r.url);
    expect(u.pathname).toBe('/home');
    expect(u.searchParams.get('fbclid')).toBe('KJAUDIT_F');
    expect(u.searchParams.get('ttclid')).toBe('KJAUDIT_T');
    expect(u.searchParams.get('utm_campaign')).toBe('audit_20260929');
    expect(r.clickIdKeys).toEqual(['fbclid', 'ttclid']);
  });

  it('uses the edge-attribution token URL when the Worker answers (POST {path}, same-origin)', async () => {
    const fetchImpl = jsonFetch({ token: 'AbCdEfGhIjKlMnOpQrStUv', url: 'https://openart.ai/r/AbCdEfGhIjKlMnOpQrStUv', expiresAt: 1, path: '/home' });
    const { win } = t11aWindow(fetchImpl);
    const r = await getHandoffUrl(win);
    expect(r).toEqual({ url: 'https://openart.ai/r/AbCdEfGhIjKlMnOpQrStUv', mode: 'token', clickIdKeys: [] });
    expect(fetchImpl.calls[0]![0]).toBe('/api/attribution/handoff');
    expect(fetchImpl.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ path: '/home' }) });
  });

  it('token mode POSTs the pathname plus allow-listed attribution params only, never other query params (review finding)', async () => {
    const fetchImpl = jsonFetch({ token: 'AbCdEfGhIjKlMnOpQrStUv', url: 'https://openart.ai/r/AbCdEfGhIjKlMnOpQrStUv', expiresAt: 1, path: '/reset-password' });
    const t = createTestWindow({
      url: 'https://openart.ai/reset-password?token=SECRET_RESET&email=jane%40example.com&fbclid=F1&utm_source=ig&next=%2Fmagic%3Fcode%3DSECRET_MAGIC&gclid=G1',
      userAgent: UAS.instagram_ios,
    });
    opened.push(t);
    const win = t.window as unknown as HandoffWindow;
    win.fetch = fetchImpl;
    expect((await getHandoffUrl(win)).mode).toBe('token');
    const body = String(fetchImpl.calls[0]![1].body);
    expect(JSON.parse(body)).toEqual({ path: '/reset-password?gclid=G1&fbclid=F1&utm_source=ig' });
    expect(body).not.toMatch(/SECRET|jane|next|email|token=/);
  });

  it('drops click-id values outside the click-id pattern, over-long UTMs and UTMs carrying an email', () => {
    const search = `?gclid=${encodeURIComponent('<img src=x onerror=alert(1)>')}&wbraid=${'A'.repeat(3800)}&utm_campaign=${'c'.repeat(300)}&utm_medium=cpc&utm_term=${encodeURIComponent('jane@example.com')}&ttclid=T.1-_`;
    expect(handoffRequestPath({ pathname: '/home', search })).toBe('/home?ttclid=T.1-_&utm_medium=cpc');
    expect(handoffRequestPath({ pathname: '/home', search: '?x=1&code=abc' })).toBe('/home');
    expect(handoffRequestPath({ pathname: '/suite/video', search: '' })).toBe('/suite/video');
  });

  it('falls back to params when the Worker has nothing, errors, lies or is slow', async () => {
    for (const fetchImpl of [
      jsonFetch({ token: null, url: 'https://openart.ai/home', expiresAt: null, path: '/home' }),
      jsonFetch({ error: 'invalid_path' }, false),
      jsonFetch({ token: 'AbCdEfGhIjKlMnOpQrStUv', url: 'https://evil.example/r/AbCdEfGhIjKlMnOpQrStUv', expiresAt: 1, path: '/home' }),
      (async () => {
        throw new Error('offline');
      }) as FetchLike,
    ]) {
      const { win } = t11aWindow(fetchImpl);
      expect((await getHandoffUrl(win)).mode).toBe('params');
    }
    vi.useFakeTimers();
    const hang = (() => new Promise(() => undefined)) as unknown as FetchLike;
    const { win } = t11aWindow(hang);
    const pending = getHandoffUrl(win, { timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).mode).toBe('params');
  });

  it('returns the plain URL when nothing is stored', async () => {
    const t = createTestWindow({ url: 'https://openart.ai/home?x=1#frag' });
    opened.push(t);
    const win = t.window as unknown as HandoffWindow;
    delete (win as { fetch?: unknown }).fetch;
    expect(await getHandoffUrl(win)).toEqual({ url: 'https://openart.ai/home?x=1', mode: 'plain', clickIdKeys: [] });
  });
});

describe('buildParamHandoffUrl', () => {
  const snapshot = readAttributionSnapshot({
    cookie: `oa_ad_clids=${encodeURIComponent(JSON.stringify({ gclid: { v: 'G', ts: 1 }, oppref: { v: 'O', ts: 1 } }))}`,
  });

  it('never duplicates a param already in the URL', () => {
    const { url } = buildParamHandoffUrl('https://openart.ai/suite/video?gclid=LIVE', snapshot);
    expect(new URL(url).searchParams.getAll('gclid')).toEqual(['LIVE']);
    expect(new URL(url).searchParams.get('oppref')).toBe('O');
  });

  it('drops low-priority params first to stay under the length cap', () => {
    const long = readAttributionSnapshot({
      cookie:
        `oa_ad_clids=${encodeURIComponent(JSON.stringify({ gclid: { v: 'G'.repeat(300), ts: 1 }, oppref: { v: 'O'.repeat(300), ts: 1 } }))}; ` +
        `oa_utm=${encodeURIComponent(JSON.stringify({ utm_source: 's', utm_term: 'T'.repeat(250) }))}`,
    });
    const { url, clickIdKeys } = buildParamHandoffUrl('https://openart.ai/home', long, { maxLength: 400 });
    expect(url.length).toBeLessThanOrEqual(400);
    expect(clickIdKeys).toEqual(['gclid']);
    expect(new URL(url).searchParams.get('utm_source')).toBe('s');
  });
});

describe('parseHandoffResponse / requestHandoff', () => {
  it('accepts only same-origin /r/<token> URLs or token null', () => {
    const origin = 'https://openart.ai';
    expect(parseHandoffResponse({ token: 'AbCdEfGhIjKlMnOpQrStUv', url: 'https://openart.ai/r/AbCdEfGhIjKlMnOpQrStUv', expiresAt: 5, path: '/home' }, origin)).not.toBeNull();
    expect(parseHandoffResponse({ token: 'AbCdEfGhIjKlMnOpQrStUv', url: 'https://openart.ai/home', expiresAt: 5, path: '/home' }, origin)).toBeNull();
    expect(parseHandoffResponse({ token: 'short', url: 'https://openart.ai/r/short', expiresAt: 5, path: '/home' }, origin)).toBeNull();
    expect(parseHandoffResponse({ token: null, url: 'http://openart.ai/home', expiresAt: null, path: '/home' }, origin)).toBeNull();
    expect(parseHandoffResponse('nope', origin)).toBeNull();
  });

  it('returns null on non-OK responses', async () => {
    expect(await requestHandoff(jsonFetch({}, false), 'https://openart.ai', '/home')).toBeNull();
  });
});

describe('presentAuthProviders', () => {
  const eg = ['google', 'apple', 'discord', 'twitter'] as const;

  it('is unchanged outside webviews', () => {
    expect(presentAuthProviders(eg, { inAppBrowser: false }).map((p) => [p.id, p.emphasis, p.showHandoff])).toEqual([
      ['google', 'primary', false],
      ['apple', 'primary', false],
      ['discord', 'primary', false],
      ['twitter', 'primary', false],
    ]);
  });

  it('hides Google in webviews by default and shows the handoff instead', () => {
    expect(presentAuthProviders(eg, { inAppBrowser: true })).toEqual([
      { id: 'apple', emphasis: 'primary', showHandoff: false },
      { id: 'discord', emphasis: 'primary', showHandoff: false },
      { id: 'twitter', emphasis: 'primary', showHandoff: false },
      { id: 'google', emphasis: 'hidden', showHandoff: true },
    ]);
  });

  it('can de-emphasise instead of hiding', () => {
    expect(presentAuthProviders(eg, { inAppBrowser: true, googleInWebview: 'deemphasize' }).at(-1)).toEqual({
      id: 'google',
      emphasis: 'secondary',
      showHandoff: true,
    });
  });
});

describe('decorateAddressBar', () => {
  it('rewrites the address bar only for the same path', () => {
    const t = createTestWindow({ url: 'https://openart.ai/home' });
    opened.push(t);
    const w = t.window as unknown as { location: { href: string }; history: History };
    expect(decorateAddressBar(w, 'https://openart.ai/home?fbclid=F')).toBe(true);
    expect(t.window.location.href).toBe('https://openart.ai/home?fbclid=F');
    expect(decorateAddressBar(w, 'https://openart.ai/r/AbCdEfGhIjKlMnOpQrStUv')).toBe(false);
    expect(decorateAddressBar(w, 'https://evil.example/home')).toBe(false);
  });
});
