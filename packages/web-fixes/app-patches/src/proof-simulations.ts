/**
 * PROOF ONLY — stand-ins for the Suite/legacy app patches, so the sealed replay (watchdog
 * `--inject-script`) can observe their effect on the live site without a deploy. Each one
 * reproduces the behaviour of a real patch in this folder; none of them is meant for production.
 *
 *  - trapMetaStub            = patchMetaPixelSnippet(): flags set on the fbq stub at creation
 *  - installClickIdMergeGuard = click-id-keys captureAdClickIds(): writes of `oa_ad_clids` by the
 *                               shipped 4-key Suite code are merged instead of replacing stored keys
 *  - installPageViewContract  = makeUsePageViewContract(): wired to the History API
 *  - installHandoffDecoration = webview-handoff: in an in-app browser, the "Trouble redirecting?"
 *                               overlay shows a URL that carries stored click ids and UTMs
 */
import { readAttributionSnapshot } from './attribution-snapshot';
import {
  AD_CLICK_ID_KEYS,
  OA_AD_CLIDS_KEY,
  parseClickIdStore,
  readAdClickIds,
  serializeClickIdStore,
  withIncomingClickId,
  type ClickIdStore,
} from './click-id-keys';
import { attachToHistory, createPageViewContract, type ContractWindow, type MetaFbq, type PageViewContract } from './page-view-contract';
import { buildParamHandoffUrl, decorateAddressBar, isInAppBrowser } from './webview-handoff';

/** Set the Meta SPA flags on the fbq stub the moment the page's base code creates it. */
export function trapMetaStub(win: object): boolean {
  const w = win as Record<string, unknown>;
  if (w.fbq) {
    const existing = w.fbq as MetaFbq;
    // Too late for disablePushState to matter if fbevents already fired; set anyway for consistency.
    existing.disablePushState = true;
    existing.allowDuplicatePageViews = true;
    return false;
  }
  Object.defineProperty(w, 'fbq', {
    configurable: true,
    enumerable: true,
    get: () => undefined,
    set: (stub: unknown) => {
      if (typeof stub === 'function') {
        (stub as MetaFbq).disablePushState = true;
        (stub as MetaFbq).allowDuplicatePageViews = true;
      }
      Object.defineProperty(w, 'fbq', { value: stub, writable: true, configurable: true, enumerable: true });
    },
  });
  return true;
}

function findCookieDescriptor(doc: object): PropertyDescriptor | undefined {
  let proto: object | null = doc;
  while (proto) {
    const d = Object.getOwnPropertyDescriptor(proto, 'cookie');
    if (d && (d.get || d.set)) return d;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

/**
 * Merge an `oa_ad_clids` value being written with what is already stored (all canonical keys),
 * with captureAdClickIds()'s first-seen rule: a click id re-written with the same value keeps its
 * stored `ts`.
 */
export function mergeOaAdClids(incomingJson: string, existing: ClickIdStore): string {
  const incoming = parseClickIdStore(incomingJson);
  const next: ClickIdStore = { ...existing };
  for (const key of AD_CLICK_ID_KEYS) {
    const entry = incoming[key];
    if (entry) next[key] = withIncomingClickId(existing[key], entry);
  }
  return serializeClickIdStore(next);
}

export interface MergeGuardWindow {
  document: object & { cookie: string };
  localStorage?: Storage | null;
  Storage?: { prototype: Storage };
}

export function installClickIdMergeGuard(win: MergeGuardWindow): () => void {
  const doc = win.document;
  const descriptor = findCookieDescriptor(doc);
  const storage = win.localStorage ?? null;
  const read = (): ClickIdStore => readAdClickIds({ cookie: descriptor?.get ? String(descriptor.get.call(doc)) : '', localStorage: storage });

  let restoreCookie = (): void => undefined;
  if (descriptor?.get && descriptor.set) {
    const get = descriptor.get;
    const set = descriptor.set;
    Object.defineProperty(doc, 'cookie', {
      configurable: true,
      enumerable: true,
      get: () => get.call(doc),
      set: (value: string) => {
        const m = /^\s*oa_ad_clids=([^;]*)(.*)$/s.exec(String(value));
        if (!m) {
          set.call(doc, value);
          return;
        }
        let decoded = m[1] ?? '';
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          // keep raw
        }
        set.call(doc, `${OA_AD_CLIDS_KEY}=${encodeURIComponent(mergeOaAdClids(decoded, read()))}${m[2] ?? ''}`);
      },
    });
    restoreCookie = () => {
      delete (doc as Record<string, unknown>).cookie;
    };
  }

  let restoreStorage = (): void => undefined;
  const proto = win.Storage?.prototype;
  if (proto && storage) {
    const original = proto.setItem;
    // Keyed on the name only: `this` may be a proxy target (happy-dom) rather than window.localStorage,
    // and nothing writes oa_ad_clids to sessionStorage.
    proto.setItem = function setItem(this: Storage, key: string, value: string): void {
      if (key === OA_AD_CLIDS_KEY) {
        original.call(this, key, mergeOaAdClids(String(value), read()));
        return;
      }
      original.call(this, key, value);
    };
    restoreStorage = () => {
      proto.setItem = original;
    };
  }
  return () => {
    restoreCookie();
    restoreStorage();
  };
}

export function installPageViewContract(win: ContractWindow & { history: History }): PageViewContract {
  const contract = createPageViewContract(win);
  attachToHistory(win, contract);
  return contract;
}

export interface HandoffDecorationWindow {
  navigator: { userAgent: string };
  document: { cookie: string; addEventListener: (t: string, l: (e: Event) => void, capture: boolean) => void; removeEventListener: (t: string, l: (e: Event) => void, capture: boolean) => void };
  location: { href: string };
  history: Pick<History, 'replaceState' | 'state'>;
  localStorage?: Storage | null;
}

/** When the handoff button is tapped in an in-app browser, put the attribution URL in place first. */
export function installHandoffDecoration(win: HandoffDecorationWindow): () => void {
  if (!isInAppBrowser(win.navigator.userAgent)) return () => undefined;
  const onClick = (event: Event): void => {
    const target = event.target as { closest?: (s: string) => { textContent?: string | null } | null } | null;
    const button = target?.closest?.('button');
    if (!button || !/Trouble redirecting/i.test(button.textContent ?? '')) return;
    const snapshot = readAttributionSnapshot({ cookie: win.document.cookie, localStorage: win.localStorage ?? null });
    const { url } = buildParamHandoffUrl(win.location.href, snapshot);
    decorateAddressBar(win, url);
  };
  win.document.addEventListener('click', onClick, true);
  return () => win.document.removeEventListener('click', onClick, true);
}

export function installProofSimulations(win: Window): void {
  const w = win as unknown as MergeGuardWindow & ContractWindow & { history: History } & HandoffDecorationWindow;
  trapMetaStub(win);
  installClickIdMergeGuard(w);
  const start = (): void => {
    installPageViewContract(w);
    installHandoffDecoration(w);
  };
  if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
