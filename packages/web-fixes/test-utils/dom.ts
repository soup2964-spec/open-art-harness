/**
 * happy-dom windows for tests, with two safety properties:
 *  1. document.cookie is backed by a browser-like CookieJar (attribute assertions).
 *  2. Nothing can reach the network: external script/CSS/iframe loading is disabled and
 *     window.fetch / XMLHttpRequest / sendBeacon throw unless a test installs a stub.
 *     (Hard rule for this repo: never send anything to OpenArt or an ad platform.)
 */
import { Window } from 'happy-dom';
import { CookieJar } from './cookie-jar';

export interface TestWindowOptions {
  url: string;
  userAgent?: string;
}

export interface TestWindow {
  window: Window;
  jar: CookieJar;
  /** Navigate within the same window (keeps cookies and localStorage). */
  navigate: (url: string) => void;
  close: () => Promise<void>;
}

function blockedNetwork(name: string): () => never {
  return () => {
    throw new Error(`${name} is disabled in tests (no network)`);
  };
}

export function createTestWindow(opts: TestWindowOptions): TestWindow {
  const window = new Window({
    url: opts.url,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
      ...(opts.userAgent ? { navigator: { userAgent: opts.userAgent } } : {}),
    },
  });
  const url = new URL(opts.url);
  const jar = new CookieJar(url.hostname, url.protocol === 'https:');
  Object.defineProperty(window.document, 'cookie', {
    configurable: true,
    get: () => jar.get(),
    set: (value: string) => jar.set(String(value)),
  });
  const w = window as unknown as Record<string, unknown>;
  w.fetch = blockedNetwork('fetch');
  w.XMLHttpRequest = blockedNetwork('XMLHttpRequest');
  if (window.navigator) {
    Object.defineProperty(window.navigator, 'sendBeacon', { configurable: true, value: blockedNetwork('sendBeacon') });
  }
  return {
    window,
    jar,
    navigate: (next: string) => {
      const u = new URL(next);
      jar.setHost(u.hostname, u.protocol === 'https:');
      window.happyDOM.setURL(next);
    },
    close: async () => {
      await window.happyDOM.close();
    },
  };
}

/**
 * Run a classic (non-module) script as if it were a page script of `win`: bare identifiers
 * (`window`, `document`, `fbq`, `dataLayer`, …) resolve against the window object, like
 * browser globals do. `extraGlobals` shadow window properties (e.g. a console spy).
 */
export function runClassicScript(win: Window, code: string, extraGlobals: Record<string, unknown> = {}): unknown {
  // Sloppy-mode `with` is the closest emulation of the browser's global object lookup.
  const fn = new Function('__win', '__extra', `with (__win) { with (__extra) {\n${code}\n} }`);
  return fn(win, extraGlobals);
}
