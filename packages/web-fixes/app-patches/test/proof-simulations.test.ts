// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestWindow, runClassicScript, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import { parseClickIdStore, readCookie } from '../src/click-id-keys';
import type { MetaFbq } from '../src/page-view-contract';
import {
  installClickIdMergeGuard,
  installHandoffDecoration,
  installPageViewContract,
  mergeOaAdClids,
  trapMetaStub,
  type HandoffDecorationWindow,
  type MergeGuardWindow,
} from '../src/proof-simulations';

const opened: TestWindow[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (opened.length) await opened.pop()!.close();
});
function open(url: string, userAgent?: string): TestWindow {
  const t = createTestWindow({ url, userAgent });
  opened.push(t);
  return t;
}

describe('trapMetaStub (stand-in for patchMetaPixelSnippet)', () => {
  it('sets both flags on the stub the unmodified Suite snippet creates', () => {
    const t = open('https://openart.ai/suite/home');
    t.window.document.head.appendChild(t.window.document.createElement('script'));
    expect(trapMetaStub(t.window)).toBe(true);
    runClassicScript(t.window, readFixture(import.meta.url, './fixtures/suite-meta-pixel-code.js'));
    const fbq = (t.window as unknown as { fbq: MetaFbq & { queue: unknown[] } }).fbq;
    expect(fbq.disablePushState).toBe(true);
    expect(fbq.allowDuplicatePageViews).toBe(true);
    expect(fbq.queue).toHaveLength(2);
  });
});

describe('installClickIdMergeGuard (stand-in for click-id-keys captureAdClickIds)', () => {
  it('the shipped Suite writer no longer deletes a stored gbraid (T2c)', () => {
    const t = open('https://openart.ai/home?fbclid=KJAUDIT_F2');
    const stored = JSON.stringify({ gbraid: { v: 'KJAUDIT_GB', ts: 100 } });
    // Install first: happy-dom's Storage proxy caches the method on first access (browsers do not).
    installClickIdMergeGuard(t.window as unknown as MergeGuardWindow);
    t.jar.seed('oa_ad_clids', encodeURIComponent(stored));
    t.window.localStorage.setItem('oa_ad_clids', stored);

    // Run the shipped module 162070 captureAdClickIds() unchanged.
    const factory = new Function('window', 'document', 'URLSearchParams', `return (${readFixture(import.meta.url, './fixtures/suite-module-162070.js').trim()})`)(
      t.window,
      t.window.document,
      t.window.URLSearchParams,
    ) as (e: unknown) => void;
    const exports: Record<string, () => unknown> = {};
    factory({
      i: (id: number) => (id === 358207 ? { publicEnv: { isLocalDev: false } } : {}),
      s: (pairs: unknown[]) => {
        for (let k = 0; k < pairs.length; k += 2) exports[pairs[k] as string] = pairs[k + 1] as () => unknown;
      },
    });
    (exports.captureAdClickIds!() as () => void)();

    const cookieStore = parseClickIdStore(readCookie(t.window.document.cookie, 'oa_ad_clids'));
    const lsStore = parseClickIdStore(t.window.localStorage.getItem('oa_ad_clids'));
    for (const store of [cookieStore, lsStore]) {
      expect(store.gbraid).toEqual({ v: 'KJAUDIT_GB', ts: 100 });
      expect(store.fbclid?.v).toBe('KJAUDIT_F2');
    }
    // Attributes written by the shipped code are preserved.
    expect(t.jar.find('oa_ad_clids')?.raw).toContain('Max-Age=7776000; Path=/; Domain=.openart.ai; SameSite=Lax; Secure');
  });

  it('keeps the first-seen ts when the shipped writer re-stores a click id the store already has', () => {
    expect(JSON.parse(mergeOaAdClids(JSON.stringify({ fbclid: { v: 'F1', ts: 900 } }), { fbclid: { v: 'F1', ts: 100 }, gbraid: { v: 'GB', ts: 50 } }))).toEqual({
      gbraid: { v: 'GB', ts: 50 },
      fbclid: { v: 'F1', ts: 100 },
    });
    expect(JSON.parse(mergeOaAdClids(JSON.stringify({ fbclid: { v: 'F2', ts: 900 } }), { fbclid: { v: 'F1', ts: 100 } }))).toEqual({
      fbclid: { v: 'F2', ts: 900 },
    });
  });

  it('leaves every other cookie and storage key alone', () => {
    const t = open('https://openart.ai/home');
    installClickIdMergeGuard(t.window as unknown as MergeGuardWindow);
    t.window.document.cookie = 'other=1; path=/';
    t.window.localStorage.setItem('x', 'y');
    expect(readCookie(t.window.document.cookie, 'other')).toBe('1');
    expect(t.window.localStorage.getItem('x')).toBe('y');
  });
});

describe('installPageViewContract (stand-in for the App Router hook)', () => {
  it('turns the History API calls of one navigation into one virtual_page_view', () => {
    vi.useFakeTimers();
    const t = open('https://openart.ai/suite/home');
    const w = t.window as unknown as Record<string, unknown>;
    w.setTimeout = (cb: () => void, ms: number) => setTimeout(cb, ms);
    w.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    installPageViewContract(t.window as never);
    t.window.history.pushState({}, '', '/suite/create-video/byte-plus-seedance-2-mini');
    t.window.history.replaceState({}, '', '/suite/create-video');
    t.window.history.replaceState({}, '', '/suite/create-video/byte-plus-seedance-2-mini');
    vi.advanceTimersByTime(600);
    const events = ((w.dataLayer ?? []) as Array<Record<string, unknown>>).filter((e) => e.event === 'virtual_page_view');
    expect(events.map((e) => e.page_path)).toEqual(['/suite/create-video/byte-plus-seedance-2-mini']);
    expect(w.__oaPageViewContract).toBe('app');
  });
});

describe('installHandoffDecoration (stand-in for webview-handoff)', () => {
  const INSTAGRAM =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0';

  function withButton(t: TestWindow): HTMLElement {
    const button = t.window.document.createElement('button');
    button.innerHTML = '<span>Trouble redirecting?</span><span>Open page in your browser</span>';
    t.window.document.body.appendChild(button);
    return button.querySelector('span') as unknown as HTMLElement;
  }

  it('puts stored click ids and UTMs in the URL before the overlay reads location.href', () => {
    const t = open('https://openart.ai/home', INSTAGRAM);
    t.jar.seed('oa_ad_clids', encodeURIComponent(JSON.stringify({ fbclid: { v: 'KJAUDIT_F', ts: 1 } })));
    t.jar.seed('oa_utm', encodeURIComponent(JSON.stringify({ utm_source: 'ig', ts: 1 })));
    installHandoffDecoration(t.window as unknown as HandoffDecorationWindow);
    withButton(t).click();
    expect(t.window.location.href).toBe('https://openart.ai/home?fbclid=KJAUDIT_F&utm_source=ig');
  });

  it('does nothing outside in-app browsers', () => {
    const t = open('https://openart.ai/home', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36');
    t.jar.seed('oa_ad_clids', encodeURIComponent(JSON.stringify({ fbclid: { v: 'KJAUDIT_F', ts: 1 } })));
    installHandoffDecoration(t.window as unknown as HandoffDecorationWindow);
    withButton(t).click();
    expect(t.window.location.href).toBe('https://openart.ai/home');
  });
});
