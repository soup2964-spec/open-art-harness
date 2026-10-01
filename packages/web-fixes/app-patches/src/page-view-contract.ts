/**
 * Page-view contract: exactly one `virtual_page_view` per settled route change.
 *
 * Why a settle window: on the Suite, one click can produce several history updates.
 * crawl/loggedin/pages/P07_spa_suite.json (navLog) shows /suite/create-image/gpt-image-2-5
 * -> /suite/create-image (+296 ms) -> /suite/create-image/gpt-image-2-5 (+135 ms) -> same URL
 * (+55 ms). Meta's history hook fires one PageView per URL change (3 here) and so does UET's
 * auto-SPA tracking; Google, Reddit, LinkedIn and X fire none (P07_spa_suite.spa.json).
 * The contract waits for a 500 ms quiet period (> the largest observed gap, 296 ms), then emits
 * once if the route key (pathname by default) differs from the last one emitted.
 *
 * Consumers:
 *  - GTM: trigger "OA-FIX CE - virtual_page_view" fires the Google Ads, Reddit, LinkedIn, X,
 *    UET and TikTok page-view tags (gtm/CHANGES.md B10).
 *  - Meta: sent here, with an eventID, when the inline pixel snippet sets
 *    `fbq.disablePushState = true` (see patchMetaPixelSnippet). Verified in the captured
 *    fbevents.js: module signalsFBEventsSPANavigationUtil only wraps pushState/replaceState
 *    when `t.fbq.disablePushState!==!0`, and manual PageViews after the first one are dropped
 *    unless `allowDuplicatePageViews` is set on the calling fbq object
 *    (`we={PageView:new X,…}` / `C=c.allowDuplicatePageViews||C`).
 *
 * The contract sets `window.__oaPageViewContract = 'app'`; the GTM route settler stands down
 * when it sees that flag, so the two sources never double count.
 */

export const VIRTUAL_PAGE_VIEW_EVENT = 'virtual_page_view';
export const PAGE_VIEW_CONTRACT_FLAG = '__oaPageViewContract';
export const DEFAULT_SETTLE_MS = 500;
export const DEFAULT_MAX_WAIT_MS = 2000;

export type PageViewSource = 'app' | 'gtm_history';

export interface VirtualPageViewPush {
  event: typeof VIRTUAL_PAGE_VIEW_EVENT;
  page_view_id: string;
  page_location: string;
  page_path: string;
  page_title: string;
  page_referrer: string;
  page_view_source: PageViewSource;
}

export interface MetaFbq {
  (...args: unknown[]): void;
  disablePushState?: boolean;
  allowDuplicatePageViews?: boolean;
}

type TimerId = ReturnType<typeof setTimeout>;

export interface ContractWindow {
  location: { href: string; pathname: string; search: string };
  document: { title: string };
  dataLayer?: unknown[];
  fbq?: MetaFbq;
  setTimeout: (cb: () => void, ms: number) => TimerId;
  clearTimeout: (id: TimerId) => void;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
  crypto?: { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView>(a: T) => T };
  [PAGE_VIEW_CONTRACT_FLAG]?: string;
}

export interface PageViewContractOptions {
  settleMs?: number;
  maxWaitMs?: number;
  /** Route identity; default = pathname without trailing slash (query/hash changes are not page views). */
  routeKey?: (location: ContractWindow['location']) => string;
  generateId?: () => string;
  now?: () => number;
  /** Send Meta PageView (only happens when the pixel snippet disabled Meta's own history hook). */
  meta?: boolean;
  onEmit?: (push: VirtualPageViewPush) => void;
}

export interface PageViewContract {
  /** Call on every route change signal (pathname change, router event, history update). */
  notifyRouteChange: () => void;
  /** Emit a pending page view now (used on pagehide). */
  flush: () => void;
  dispose: () => void;
  emitted: () => number;
}

export function defaultRouteKey(location: { pathname: string }): string {
  const path = location.pathname || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

export function randomId(win?: Pick<ContractWindow, 'crypto'>): string {
  const c = win?.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createPageViewContract(win: ContractWindow, opts: PageViewContractOptions = {}): PageViewContract {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const routeKey = opts.routeKey ?? defaultRouteKey;
  const generateId = opts.generateId ?? (() => randomId(win));
  const now = opts.now ?? (() => Date.now());
  const sendMeta = opts.meta ?? true;

  // The hard-load page view is already sent by GTM (gtm.js tags) and the inline Meta snippet.
  let lastKey = routeKey(win.location);
  let lastHref = win.location.href;
  let timer: TimerId | null = null;
  let firstPendingAt = 0;
  let emittedCount = 0;
  let disposed = false;

  win[PAGE_VIEW_CONTRACT_FLAG] = 'app';

  function emit(): void {
    timer = null;
    firstPendingAt = 0;
    if (disposed) return;
    const key = routeKey(win.location);
    if (key === lastKey) return; // bounced back to the same route, or a query/hash-only change
    const push: VirtualPageViewPush = {
      event: VIRTUAL_PAGE_VIEW_EVENT,
      page_view_id: generateId(),
      page_location: win.location.href,
      page_path: key,
      page_title: win.document.title,
      page_referrer: lastHref,
      page_view_source: 'app',
    };
    lastKey = key;
    lastHref = win.location.href;
    emittedCount += 1;
    win.dataLayer = win.dataLayer || [];
    win.dataLayer.push(push);
    const fbq = win.fbq;
    if (sendMeta && typeof fbq === 'function' && fbq.disablePushState === true) {
      try {
        fbq('track', 'PageView', {}, { eventID: `pv_${push.page_view_id}` });
      } catch {
        // pixel blocked or broken: the dataLayer event already went out
      }
    }
    opts.onEmit?.(push);
  }

  function notifyRouteChange(): void {
    if (disposed) return;
    const t = now();
    if (!firstPendingAt) firstPendingAt = t;
    if (timer !== null) win.clearTimeout(timer);
    const wait = Math.max(0, Math.min(settleMs, firstPendingAt + maxWaitMs - t));
    timer = win.setTimeout(emit, wait);
  }

  function flush(): void {
    if (timer === null) return;
    win.clearTimeout(timer);
    emit();
  }

  const onPageHide = (): void => flush();
  win.addEventListener?.('pagehide', onPageHide);

  return {
    notifyRouteChange,
    flush,
    dispose: () => {
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      disposed = true;
      win.removeEventListener?.('pagehide', onPageHide);
      if (win[PAGE_VIEW_CONTRACT_FLAG] === 'app') delete win[PAGE_VIEW_CONTRACT_FLAG];
    },
    emitted: () => emittedCount,
  };
}

/* ------------------------------------------------------------------ */
/* Next.js wiring (hooks are injected so this module has no React dep) */
/* ------------------------------------------------------------------ */

export interface ReactHooks {
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
}

/**
 * App Router (Suite): `usePathname` from next/navigation.
 *
 *   'use client';
 *   import { useEffect, useRef } from 'react';
 *   import { usePathname } from 'next/navigation';
 *   export const usePageViewContract = makeUsePageViewContract({ useEffect, useRef }, { usePathname });
 *   export function PageViewContract() { usePageViewContract(); return null; }
 */
export function makeUsePageViewContract(
  react: ReactHooks,
  nav: { usePathname: () => string | null },
  opts: PageViewContractOptions & { getWindow?: () => ContractWindow } = {},
): () => void {
  return function usePageViewContract(): void {
    const ref = react.useRef<PageViewContract | null>(null);
    const pathname = nav.usePathname();
    react.useEffect(() => {
      const win = opts.getWindow ? opts.getWindow() : (globalThis as unknown as { window: ContractWindow }).window;
      const contract = createPageViewContract(win, opts);
      ref.current = contract;
      return () => {
        contract.dispose();
        ref.current = null;
      };
    }, []);
    react.useEffect(() => {
      ref.current?.notifyRouteChange();
    }, [pathname]);
  };
}

export interface LegacyRouter {
  events: {
    on: (event: 'routeChangeComplete', cb: () => void) => void;
    off: (event: 'routeChangeComplete', cb: () => void) => void;
  };
}

/** Pages Router (legacy): `useRouter` from next/router. */
export function makeUseLegacyPageViewContract(
  react: ReactHooks,
  nav: { useRouter: () => LegacyRouter },
  opts: PageViewContractOptions & { getWindow?: () => ContractWindow } = {},
): () => void {
  return function useLegacyPageViewContract(): void {
    const router = nav.useRouter();
    react.useEffect(() => {
      const win = opts.getWindow ? opts.getWindow() : (globalThis as unknown as { window: ContractWindow }).window;
      const contract = createPageViewContract(win, opts);
      const onComplete = (): void => contract.notifyRouteChange();
      router.events.on('routeChangeComplete', onComplete);
      return () => {
        router.events.off('routeChangeComplete', onComplete);
        contract.dispose();
      };
    }, [router.events]);
  };
}

/**
 * Framework-free wiring: wraps history.pushState/replaceState and listens to popstate.
 * Used by the injectable proof build and by pages without a router hook.
 */
export function attachToHistory(
  win: ContractWindow & { history: Pick<History, 'pushState' | 'replaceState'> },
  contract: PageViewContract,
): () => void {
  const history = win.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function pushState(this: History, ...args: Parameters<History['pushState']>) {
    const out = originalPush.apply(this, args);
    contract.notifyRouteChange();
    return out;
  } as History['pushState'];
  history.replaceState = function replaceState(this: History, ...args: Parameters<History['replaceState']>) {
    const out = originalReplace.apply(this, args);
    contract.notifyRouteChange();
    return out;
  } as History['replaceState'];
  const onPop = (): void => contract.notifyRouteChange();
  win.addEventListener?.('popstate', onPop);
  return () => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
    win.removeEventListener?.('popstate', onPop);
  };
}

/* ------------------------------------------------------------------ */
/* Meta inline snippet patch                                           */
/* ------------------------------------------------------------------ */

export const META_SPA_FLAGS = 'fbq.disablePushState=true;fbq.allowDuplicatePageViews=true;';

/**
 * Insert the two flags right before the first `fbq('init'` of the inline Meta base code
 * (Suite next/script id="meta-pixel-code", legacy script with the same body). They must be set
 * on the stub before fbevents.js fires its first event: setupSPANavigation runs once, on the
 * first `fired` event, and reads `fbq.disablePushState` at that moment.
 */
export function patchMetaPixelSnippet(snippet: string): string {
  if (snippet.includes('fbq.disablePushState')) return snippet;
  const at = snippet.search(/fbq\(\s*['"]init['"]/);
  if (at < 0) throw new Error("patchMetaPixelSnippet: no fbq('init', …) call found");
  return snippet.slice(0, at) + META_SPA_FLAGS + snippet.slice(at);
}
