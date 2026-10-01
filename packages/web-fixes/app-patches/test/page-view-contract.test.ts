// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestWindow, runClassicScript, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import {
  DEFAULT_SETTLE_MS,
  PAGE_VIEW_CONTRACT_FLAG,
  attachToHistory,
  createPageViewContract,
  defaultRouteKey,
  makeUseLegacyPageViewContract,
  makeUsePageViewContract,
  patchMetaPixelSnippet,
  randomId,
  type ContractWindow,
  type LegacyRouter,
  type MetaFbq,
  type VirtualPageViewPush,
} from '../src/page-view-contract';

const ORIGIN = 'https://openart.ai';

interface FakeWin extends ContractWindow {
  go: (path: string) => void;
  listeners: Record<string, Array<() => void>>;
}

function fakeWindow(path: string, extra: Partial<ContractWindow> = {}): FakeWin {
  const listeners: Record<string, Array<() => void>> = {};
  const loc = { href: ORIGIN + path, pathname: path.split('?')[0]!, search: path.includes('?') ? path.slice(path.indexOf('?')) : '' };
  const win: FakeWin = {
    location: loc,
    document: { title: 'OpenArt' },
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: (type, cb) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: (type, cb) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb);
    },
    listeners,
    go: (next: string) => {
      loc.href = ORIGIN + next;
      loc.pathname = next.split('?')[0]!;
      loc.search = next.includes('?') ? next.slice(next.indexOf('?')) : '';
    },
    ...extra,
  };
  return win;
}

function pushes(win: ContractWindow): VirtualPageViewPush[] {
  return (win.dataLayer ?? []) as VirtualPageViewPush[];
}

let seq = 0;
const ids = () => `id-${++seq}`;

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPageViewContract', () => {
  it('does not emit for the hard-load route and flags itself for the GTM settler', () => {
    const win = fakeWindow('/suite/home');
    const c = createPageViewContract(win, { generateId: ids });
    c.notifyRouteChange(); // Next.js initial replaceState of the same URL (P07 t=981)
    vi.advanceTimersByTime(5_000);
    expect(pushes(win)).toEqual([]);
    expect(win[PAGE_VIEW_CONTRACT_FLAG]).toBe('app');
  });

  it('emits exactly once for the observed create-image bounce (A -> B -> A -> A)', () => {
    const win = fakeWindow('/suite/home');
    const c = createPageViewContract(win, { generateId: ids });
    // Timings from crawl/loggedin/pages/P07_spa_suite.json navLog (t=13798, 14094, 14229, 14284).
    win.go('/suite/create-image/gpt-image-2-5');
    c.notifyRouteChange();
    vi.advanceTimersByTime(296);
    win.go('/suite/create-image');
    c.notifyRouteChange();
    vi.advanceTimersByTime(135);
    win.go('/suite/create-image/gpt-image-2-5');
    c.notifyRouteChange();
    vi.advanceTimersByTime(55);
    c.notifyRouteChange();
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(pushes(win)).toEqual([
      {
        event: 'virtual_page_view',
        page_view_id: 'id-1',
        page_location: 'https://openart.ai/suite/create-image/gpt-image-2-5',
        page_path: '/suite/create-image/gpt-image-2-5',
        page_title: 'OpenArt',
        page_referrer: 'https://openart.ai/suite/home',
        page_view_source: 'app',
      },
    ]);
  });

  it('emits one per distinct navigation and chains page_referrer', () => {
    const win = fakeWindow('/suite/home');
    const c = createPageViewContract(win, { generateId: ids });
    for (const path of ['/suite/media', '/suite/inspire/feed', '/suite/brand-kit', '/suite/home']) {
      win.go(path);
      c.notifyRouteChange();
      vi.advanceTimersByTime(9_000);
    }
    expect(pushes(win).map((p) => [p.page_path, p.page_referrer])).toEqual([
      ['/suite/media', 'https://openart.ai/suite/home'],
      ['/suite/inspire/feed', 'https://openart.ai/suite/media'],
      ['/suite/brand-kit', 'https://openart.ai/suite/inspire/feed'],
      ['/suite/home', 'https://openart.ai/suite/brand-kit'],
    ]);
  });

  it('treats a query-only change (P01 credit badge ?creditLedger=…) as the same page by default', () => {
    const win = fakeWindow('/suite/home');
    const c = createPageViewContract(win, { generateId: ids });
    win.go('/suite/home?creditLedger=nav_credit_display');
    c.notifyRouteChange();
    vi.advanceTimersByTime(56);
    c.notifyRouteChange();
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(pushes(win)).toEqual([]);

    const win2 = fakeWindow('/suite/home');
    const c2 = createPageViewContract(win2, { generateId: ids, routeKey: (l) => l.pathname + l.search });
    win2.go('/suite/home?creditLedger=nav_credit_display');
    c2.notifyRouteChange();
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(pushes(win2)).toHaveLength(1);
  });

  it('caps the wait under continuous URL churn (maxWait) and still emits the settled route', () => {
    const win = fakeWindow('/suite/home');
    const c = createPageViewContract(win, { generateId: ids, maxWaitMs: 2_000 });
    for (let i = 0; i < 30; i += 1) {
      win.go(i % 2 ? '/suite/a' : '/suite/b');
      c.notifyRouteChange();
      vi.advanceTimersByTime(100);
    }
    const duringBurst = pushes(win).length;
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(duringBurst).toBeGreaterThanOrEqual(1);
    expect(duringBurst).toBeLessThanOrEqual(2);
    expect(pushes(win).at(-1)!.page_path).toBe('/suite/a');
  });

  it('flushes a pending page view on pagehide', () => {
    const win = fakeWindow('/suite/home');
    createPageViewContract(win, { generateId: ids });
    const c = createPageViewContract(win, { generateId: ids });
    win.go('/suite/director/projects');
    c.notifyRouteChange();
    for (const cb of win.listeners.pagehide ?? []) cb();
    expect(pushes(win).filter((p) => p.page_path === '/suite/director/projects')).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(pushes(win).filter((p) => p.page_path === '/suite/director/projects')).toHaveLength(1);
  });

  it('sends Meta PageView with an eventID only when the pixel snippet disabled Meta history tracking', () => {
    const calls: unknown[][] = [];
    const fbq = ((...a: unknown[]) => calls.push(a)) as MetaFbq;
    const win = fakeWindow('/suite/home', { fbq });
    const c = createPageViewContract(win, { generateId: ids });
    win.go('/suite/media');
    c.notifyRouteChange();
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(calls).toEqual([]); // unpatched snippet: Meta's own hook already counts it

    fbq.disablePushState = true;
    fbq.allowDuplicatePageViews = true;
    win.go('/suite/brand-kit');
    c.notifyRouteChange();
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(calls).toEqual([['track', 'PageView', {}, { eventID: 'pv_id-2' }]]);
  });

  it('dispose stops emission and clears its flag', () => {
    const win = fakeWindow('/suite/home');
    const c = createPageViewContract(win, { generateId: ids });
    win.go('/suite/media');
    c.notifyRouteChange();
    c.dispose();
    vi.advanceTimersByTime(5_000);
    expect(pushes(win)).toEqual([]);
    expect(win[PAGE_VIEW_CONTRACT_FLAG]).toBeUndefined();
  });

  it('normalises trailing slashes and generates RFC 4122 v4 ids', () => {
    expect(defaultRouteKey({ pathname: '/suite/home/' })).toBe('/suite/home');
    expect(defaultRouteKey({ pathname: '/' })).toBe('/');
    expect(randomId({})).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('Next.js wiring (hooks injected)', () => {
  function fakeReact() {
    const refs: Array<{ current: unknown }> = [];
    const effects: Array<{ deps: readonly unknown[] | undefined; cleanup?: void | (() => void) }> = [];
    let refIdx = 0;
    let effIdx = 0;
    return {
      hooks: {
        useRef: <T>(initial: T) => {
          refs[refIdx] ??= { current: initial };
          return refs[refIdx++] as { current: T };
        },
        useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
          const prev = effects[effIdx];
          const changed = !prev || !deps || !prev.deps || deps.some((d, i) => d !== prev.deps![i]);
          if (changed) {
            if (prev && typeof prev.cleanup === 'function') prev.cleanup();
            effects[effIdx] = { deps, cleanup: effect() };
          }
          effIdx += 1;
        },
      },
      render: (fn: () => void) => {
        refIdx = 0;
        effIdx = 0;
        fn();
      },
    };
  }

  it('App Router hook emits once per pathname change', () => {
    const win = fakeWindow('/suite/home');
    const react = fakeReact();
    let pathname = '/suite/home';
    const usePageViewContract = makeUsePageViewContract(react.hooks, { usePathname: () => pathname }, { getWindow: () => win, generateId: ids });
    react.render(usePageViewContract);
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    for (const next of ['/suite/create-image/gpt-image-2-5', '/suite/create-image', '/suite/create-image/gpt-image-2-5']) {
      win.go(next);
      pathname = next;
      react.render(usePageViewContract);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(pushes(win).map((p) => p.page_path)).toEqual(['/suite/create-image/gpt-image-2-5']);
  });

  it('Pages Router hook listens to routeChangeComplete and unsubscribes', () => {
    const win = fakeWindow('/image');
    const handlers = new Set<() => void>();
    const router: LegacyRouter = {
      events: { on: (_e, cb) => handlers.add(cb), off: (_e, cb) => handlers.delete(cb) },
    };
    const react = fakeReact();
    const useLegacy = makeUseLegacyPageViewContract(react.hooks, { useRouter: () => router }, { getWindow: () => win, generateId: ids });
    react.render(useLegacy);
    expect(handlers.size).toBe(1);
    win.go('/video');
    for (const h of handlers) h();
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(pushes(win).map((p) => p.page_path)).toEqual(['/video']);
  });
});

describe('attachToHistory (framework-free)', () => {
  it('turns double history updates into one page view', () => {
    const t = createTestWindow({ url: 'https://openart.ai/suite/home' });
    const win = t.window as unknown as ContractWindow & { history: History };
    // happy-dom keeps its own timer queue; route timers through vitest's fake clock.
    win.setTimeout = (cb, ms) => setTimeout(cb, ms);
    win.clearTimeout = (id) => clearTimeout(id);
    const c = createPageViewContract(win, { generateId: ids });
    const detach = attachToHistory(win, c);
    win.history.pushState({}, '', '/suite/create-video/byte-plus-seedance-2-mini');
    win.history.replaceState({}, '', '/suite/create-video');
    win.history.replaceState({}, '', '/suite/create-video/byte-plus-seedance-2-mini');
    win.history.replaceState({ __NA: true }, '', '/suite/create-video/byte-plus-seedance-2-mini');
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS);
    expect(pushes(win).map((p) => p.page_path)).toEqual(['/suite/create-video/byte-plus-seedance-2-mini']);
    detach();
    void t.close();
  });
});

describe('Meta: verified against the captured fbevents.js', () => {
  // Module signalsFBEventsSPANavigationUtil, extracted verbatim from raw/static/fbevents.js.
  const MODULE = readFixture(import.meta.url, './fixtures/fbevents-spa-navigation-module.js');

  function runMetaHistoryHook(disablePushState: boolean, urls: string[]): number {
    let href = 'https://openart.ai/suite/home';
    const history: Record<string, (...a: unknown[]) => void> = {
      pushState: () => undefined,
      replaceState: () => undefined,
    };
    const win = { addEventListener: () => undefined };
    const loc = {
      get href() {
        return href;
      },
    };
    const factory = new Function(`return (${MODULE.slice(MODULE.indexOf('function'))})`)() as (
      e: unknown,
      t: unknown,
      n: unknown,
      r: unknown,
    ) => { setupSPANavigation: (cfg: unknown) => void };
    const { setupSPANavigation } = factory(win, { referrer: '' }, loc, history);
    let pageViews = 0;
    setupSPANavigation({
      fbq: { disablePushState },
      automaticPageView: { trigger: () => undefined },
      onPageChange: () => {
        pageViews += 1;
      },
      makeSafe: (fn: () => void) => fn,
      injectMethod: (obj: Record<string, (...a: unknown[]) => void>, name: string, hook: () => void) => {
        const original = obj[name]!;
        obj[name] = (...a: unknown[]) => {
          original(...a);
          hook();
        };
      },
    });
    const methods = ['pushState', 'replaceState', 'replaceState', 'replaceState'];
    urls.forEach((url, i) => {
      href = url;
      history[methods[i]!]!({}, '', url);
    });
    return pageViews;
  }

  const bounce = [
    'https://openart.ai/suite/create-image/gpt-image-2-5',
    'https://openart.ai/suite/create-image',
    'https://openart.ai/suite/create-image/gpt-image-2-5',
    'https://openart.ai/suite/create-image/gpt-image-2-5',
  ];

  it('reproduces the 3 PageViews seen live for one create-image navigation (P07)', () => {
    expect(runMetaHistoryHook(false, bounce)).toBe(3);
  });

  it('adds no history hook when fbq.disablePushState === true', () => {
    expect(runMetaHistoryHook(true, bounce)).toBe(0);
  });
});

describe('patchMetaPixelSnippet', () => {
  let t: TestWindow;
  afterEach(async () => {
    await t?.close();
  });

  for (const fixture of ['suite-meta-pixel-code.js', 'legacy-meta-pixel-code.js']) {
    it(`sets both flags on the stub before init in ${fixture}`, () => {
      const original = readFixture(import.meta.url, `./fixtures/${fixture}`);
      const patched = patchMetaPixelSnippet(original);
      expect(patchMetaPixelSnippet(patched)).toBe(patched); // idempotent
      t = createTestWindow({ url: 'https://openart.ai/suite/home' });
      // The base code inserts fbevents.js before the first <script>; a page always has one.
      t.window.document.head.appendChild(t.window.document.createElement('script'));
      runClassicScript(t.window, patched);
      const fbq = (t.window as unknown as { fbq: MetaFbq & { queue: unknown[][] } }).fbq;
      expect(fbq.disablePushState).toBe(true);
      expect(fbq.allowDuplicatePageViews).toBe(true);
      expect(fbq.queue.map((args) => Array.from(args))).toEqual([
        ['init', '843671884361709'],
        ['track', 'PageView'],
      ]);
    });
  }

  it('refuses a snippet without fbq init', () => {
    expect(() => patchMetaPixelSnippet('console.log(1)')).toThrow();
  });
});
