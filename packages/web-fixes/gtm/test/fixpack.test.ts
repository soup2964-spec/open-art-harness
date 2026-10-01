// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestWindow, runClassicScript, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import { isFallbackTransactionId } from '../../app-patches/src/fallback-purchase';
import { findEs5Violations, scriptBodies } from '../src/es5';
import { neutraliseReferences } from '../src/export-schema';
import {
  IDS,
  TAGS,
  TIKTOK_BASE_ORIGINAL,
  UET_BASE_ORIGINAL,
  V,
  VARIABLES,
  X_BASE_ORIGINAL,
  tiktokBaseFixed,
  uetBaseFixed,
  xBaseFixed,
  type HtmlTagDef,
  type VariableDef,
} from '../src/fixpack';
import { evalCustomJs, renderRefs } from './helpers';

const CONTAINER = JSON.parse(readFixture(import.meta.url, './fixtures/gtm_56CMP8K.js.json')) as {
  resource: { tags: Array<Record<string, unknown> & { tag_id: number }> };
};

const exportRef = (n: string) => `{{${n}}}`;
const htmlTag = (namePart: string): HtmlTagDef => {
  const t = TAGS.find((x) => x.name.includes(namePart));
  if (!t || t.kind !== 'html') throw new Error(`no html tag ${namePart}`);
  return t;
};
const jsm = (name: string): Extract<VariableDef, { kind: 'jsm' }> => {
  const v = VARIABLES.find((x) => x.name === name);
  if (!v || v.kind !== 'jsm') throw new Error(`no jsm ${name}`);
  return v;
};

function compiledScript(tagId: number): string {
  const html = CONTAINER.resource.tags.find((t) => t.tag_id === tagId)!.vtp_html as string;
  return scriptBodies(html)[0]!.trim();
}

describe('originals the fix pack edits are byte-identical to GTM-56CMP8K v25', () => {
  it('X base (tag_id 74), UET base (tag_id 38) and TikTok base (tag_id 77)', () => {
    expect(compiledScript(74)).toBe(X_BASE_ORIGINAL);
    expect(compiledScript(38)).toBe(UET_BASE_ORIGINAL);
    expect(compiledScript(77)).toBe(TIKTOK_BASE_ORIGINAL);
  });

  it('the fixes change exactly one statement each', () => {
    expect(xBaseFixed()).toBe(X_BASE_ORIGINAL.replace('twq("config","qwghh");', 'twq("set","dataLayerTracking","false","qwghh");twq("config","qwghh");'));
    expect(uetBaseFixed()).toBe(UET_BASE_ORIGINAL.replace('enableAutoSpaTracking:!0', 'enableAutoSpaTracking:!1'));
    expect(tiktokBaseFixed()).toBe(TIKTOK_BASE_ORIGINAL.replace('a.load("D9QOQ5JC77U6RO6J21IG")', 'a.load("D9QOQ5JC77U6RO6J21IG",{historyObserver:!1})'));
  });
});

describe('ES5 only (Custom HTML / Custom JavaScript)', () => {
  it('every tag script and custom JS variable parses as ES5', () => {
    for (const t of TAGS) {
      if (t.kind !== 'html') continue;
      for (const body of scriptBodies(t.html(exportRef))) expect(findEs5Violations(neutraliseReferences(body)), t.name).toEqual([]);
    }
    for (const v of VARIABLES) if (v.kind === 'jsm') expect(findEs5Violations(`(${neutraliseReferences(v.body(exportRef))})`), v.name).toEqual([]);
  });

  it('the checker catches ES2015+', () => {
    expect(findEs5Violations('const a = () => `x${1}`;').map((v) => v.kind)).toEqual(expect.arrayContaining(['let/const', 'arrow function', 'template literal']));
    expect(findEs5Violations('var o = {...a}; var b = a?.c ?? 1;').map((v) => v.kind)).toEqual(expect.arrayContaining(['object spread', 'optional chaining', 'nullish coalescing']));
  });
});

describe('OA-FIX CJS - reg event_id', () => {
  const body = jsm(V.regEventId).body(exportRef);
  const run = (userId: unknown, cookie: unknown) => evalCustomJs(body, { [V.userId]: userId, [V.signupCookie]: cookie });

  it('uses user_id from the signup push (app patch)', () => {
    expect(run('dOp6BlUh0AgkVu3ILV59', undefined)).toBe('reg_dOp6BlUh0AgkVu3ILV59');
  });
  it('falls back to the uid in oa_signup_uid while today’s push has no user_id', () => {
    expect(run(undefined, 'dOp6BlUh0AgkVu3ILV59:jane@example.com')).toBe('reg_dOp6BlUh0AgkVu3ILV59');
  });
  it('returns undefined rather than a wrong id', () => {
    expect(run(undefined, undefined)).toBeUndefined();
    expect(run('bad id', ':jane@example.com')).toBeUndefined();
    expect(run(42, 'no-separator')).toBeUndefined();
  });
});

describe('OA-FIX CJS - purchase order_id', () => {
  const body = jsm(V.purchaseOrderId).body(exportRef);
  const run = (t: unknown) => evalCustomJs(body, { [V.transactionId]: t });
  const NOW = 1790700000000;
  const vectors = [
    'sub_in_1QxYzAbCdEfGhIjKlMnOpQr',
    'sub_SEALTEST_1',
    'sub_WD_TEST_inv_0001',
    `sub_Essential_1000_u1_${NOW}`,
    `sub_tier_9999_unknown_${NOW}`,
    `sub_Infinite_3000_dOp6BlUh0AgkVu3ILV59_${NOW}`,
    'purchase_in_1Qx',
    'sub_',
    'sub_a b',
  ];

  it('passes sub_<invoiceId> through exactly when the id is invoice-derived (agrees with fallback-purchase.ts)', () => {
    for (const id of vectors) {
      const expected = /^sub_[A-Za-z0-9_-]{4,128}$/.test(id) && !isFallbackTransactionId(id) ? id : undefined;
      expect(run(id), id).toBe(expected);
    }
    expect(run('sub_in_1QxYzAbCdEfGhIjKlMnOpQr')).toBe('sub_in_1QxYzAbCdEfGhIjKlMnOpQr');
    expect(run(undefined)).toBeUndefined();
    expect(run(56)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* TikTok: verified against the captured SDK (main.MWU2MzIzODM0MQ.js)  */
/* ------------------------------------------------------------------ */

describe('TikTok automatic SPA page views (SDK HistoryObserver)', () => {
  const plugins = JSON.parse(readFixture(import.meta.url, './fixtures/tiktok-pixel-config-plugins.json')) as Record<string, unknown>;
  // fo() as shipped: the per-pixel gate every HistoryObserver path checks first.
  const fo = new Function(`var fe, aX;\n${readFixture(import.meta.url, './fixtures/tiktok-sdk-history-observer.js').replace(/^\/\*[\s\S]*?\*\/\s*/, '')}\nreturn fo;`)() as (t: {
    options: unknown;
    plugins: unknown;
  }) => unknown;
  const opened: TestWindow[] = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
  });
  function optionsAfter(baseCode: string): unknown {
    const t = createTestWindow({ url: 'https://openart.ai/home' });
    opened.push(t);
    t.window.document.head.appendChild(t.window.document.createElement('script'));
    runClassicScript(t.window, baseCode);
    return (t.window as unknown as { ttq: { _o: Record<string, unknown> } }).ttq._o[IDS.tiktokPixel];
  }

  it('OpenArt’s pixel config turns dynamic_web_pageview on', () => {
    expect(plugins.HistoryObserver).toEqual({ dynamic_web_pageview: true });
  });

  it('shipped base code: options {} -> the observer is active', () => {
    const options = optionsAfter(TIKTOK_BASE_ORIGINAL);
    expect(options).toEqual({});
    expect(fo({ options, plugins })).toBeTruthy();
  });

  it('fixed base code: options {historyObserver:false} -> no automatic page views', () => {
    const options = optionsAfter(tiktokBaseFixed());
    expect(options).toEqual({ historyObserver: false });
    expect(fo({ options, plugins })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* X: verified against uwt.js 2.4.11 modules 2345 / 510 / 9115         */
/* ------------------------------------------------------------------ */

type Tracked = { eventParams: { p: Record<string, unknown> } };

function loadUwt(win: Record<string, unknown>) {
  const tracked: Tracked[] = [];
  class Params {
    constructor(public p: Record<string, unknown>) {}
    get(): Record<string, unknown> {
      return this.p;
    }
    set(extra: Record<string, unknown>): void {
      Object.assign(this.p, extra);
    }
    getPixelId(): unknown {
      return this.p.txn_id;
    }
  }
  const noopPixel = { registerPixel: () => undefined, disableForPixel: () => undefined };
  const fakes: Record<number, unknown> = {
    2404: { ...noopPixel, isPlausibleName: () => false },
    7939: noopPixel,
    7686: noopPixel,
    2243: noopPixel,
    1952: {
      AccountParams: Params,
      EventParams: Params,
      NonEventParameterKeys: ['email_address', 'phone_number', 'event_id', 'event', 'events', 'twclid'],
      globalParams: { get: () => ({}), set: () => undefined, calledConfig: () => undefined },
    },
    3257: { init: () => undefined, track: (x: Tracked) => tracked.push(x) },
    4654: {
      utilities: {
        LogPrefix: 'Twitter Pixel',
        isObject: (o: unknown) => !!o && typeof o === 'object',
        splitObjectByPropNames: (o: Record<string, unknown>, keys: string[]) => {
          const a: Record<string, unknown> = {};
          const b: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(o)) (keys.includes(k) ? a : b)[k] = v;
          return [a, b];
        },
        EventCodeImpl: { UWT_TRACK: 'uwt', ONETAG_CONFIG: 'config', ONETAG_EVENT: 'event' },
        AdsApiVersion: { v0: 'v0', v1: 'v1' },
        enableExperimentOverrideForPixel: () => undefined,
        parseEventCodeId: (id: string) => [id.split('-')[1], id],
        logError: () => undefined,
      },
    },
    1454: { setDefaultAccountParams: () => undefined },
  };
  const cache: Record<number, { exports: Record<string, unknown> }> = {};
  const load = (file: string) =>
    new Function('window', 'setTimeout', `return ${readFixture(import.meta.url, `./fixtures/${file}`).replace(/^\/\*[\s\S]*?\*\/\s*/, '')}`)(win, setTimeout) as (
      this: unknown,
      m: unknown,
      e: unknown,
      r: unknown,
    ) => void;
  const req = (id: number): unknown => {
    if (cache[id]) return cache[id].exports;
    if (id === 6527) return { OneTag: req(510), UWT: { init: () => undefined, track: () => undefined } };
    const file = { 510: 'uwt-module-510.js', 9115: 'uwt-module-9115.js', 2345: 'uwt-module-2345.js' }[id];
    if (!file) return fakes[id];
    const module = { exports: {} as Record<string, unknown> };
    cache[id] = module;
    load(file).call(module.exports, module, module.exports, req);
    return module.exports;
  };
  return { tracked, req };
}

const autoPurchases = (tracked: Tracked[]) => tracked.filter((t) => String(t.eventParams.p.events ?? '').includes('gtm_purchase'));

describe('X: the automatic gtm_purchase (uwt.js module 9115) and how the fix stops it', () => {
  const opened: TestWindow[] = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
  });

  function runBase(snippet: string) {
    const t = createTestWindow({ url: 'https://openart.ai/pricing' });
    opened.push(t);
    t.window.document.head.appendChild(t.window.document.createElement('script'));
    const win = t.window as unknown as Record<string, unknown> & { dataLayer: unknown[] };
    win.dataLayer = [];
    runClassicScript(t.window, snippet); // GTM's base tag: creates the twq stub and queues commands
    const uwt = loadUwt(win);
    uwt.req(2345); // uwt.js loaded: dispatcher drains twq.queue in order
    // The app's purchase call (Suite module 114607): gtag('event','purchase', n)
    runClassicScript(
      t.window,
      "function gtag(){dataLayer.push(arguments);} gtag('event','purchase',{transaction_id:'sub_in_1QxYz',value:56,currency:'USD',items:[{item_id:'pro_monthly',quantity:1}]});",
    );
    return { uwt, win };
  }

  it('reproduces the second, automatic purchase with the shipped base code (research/11 §6.1)', () => {
    const { uwt } = runBase(X_BASE_ORIGINAL);
    const auto = autoPurchases(uwt.tracked);
    expect(auto).toHaveLength(1);
    expect(JSON.parse(String(auto[0]!.eventParams.p.events))[0][1]).toMatchObject({ value: 56, currency: 'USD', order_id: 'sub_in_1QxYz' });
    expect((uwt.req(9115) as { isEnabledForPixel: (p: string) => boolean }).isEnabledForPixel('qwghh')).toBe(true);
  });

  it('sends no automatic event once the base code opts out before config', () => {
    const { uwt } = runBase(xBaseFixed());
    expect(autoPurchases(uwt.tracked)).toEqual([]);
    expect((uwt.req(9115) as { isEnabledForPixel: (p: string) => boolean }).isEnabledForPixel('qwghh')).toBe(false);
  });

  it('opting out after config would be too late for events already in the dataLayer', () => {
    const t = createTestWindow({ url: 'https://openart.ai/pricing' });
    opened.push(t);
    const win = t.window as unknown as Record<string, unknown> & { dataLayer: unknown[] };
    win.dataLayer = [];
    runClassicScript(t.window, "function gtag(){dataLayer.push(arguments);} gtag('event','purchase',{transaction_id:'sub_in_A',value:1,currency:'USD'});");
    const uwt = loadUwt(win);
    const oneTag = uwt.req(510) as { config: (p: string) => void; set: (k: string, v: string, p: string) => void };
    oneTag.config('qwghh'); // the initial dataLayer is replayed at config time (module 9115 P())
    oneTag.set('dataLayerTracking', 'false', 'qwghh');
    expect(autoPurchases(uwt.tracked)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Other Custom HTML tags, executed with GTM-style variable rendering   */
/* ------------------------------------------------------------------ */

describe('tag behaviour', () => {
  const opened: TestWindow[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    while (opened.length) await opened.pop()!.close();
  });
  function page(url = 'https://openart.ai/suite/home'): TestWindow {
    const t = createTestWindow({ url });
    opened.push(t);
    return t;
  }
  function fire(t: TestWindow, tag: HtmlTagDef, values: Record<string, unknown>): void {
    for (const body of scriptBodies(renderRefs(tag.html(exportRef), values))) runClassicScript(t.window, body);
  }

  it('TikTok CompleteRegistration sends event_id reg_<uid>', () => {
    const t = page();
    const calls: unknown[][] = [];
    (t.window as unknown as Record<string, unknown>).ttq = {
      identify: (...a: unknown[]) => calls.push(['identify', ...a]),
      track: (...a: unknown[]) => calls.push(['track', ...a]),
    };
    fire(t, htmlTag('TikTok - CompleteRegistration'), { [V.email]: 'Jane@Example.com', [V.regEventId]: 'reg_u1' });
    expect(calls).toEqual([
      ['identify', { email: 'jane@example.com' }],
      ['track', 'CompleteRegistration', {}, { event_id: 'reg_u1' }],
    ]);
  });

  it('TikTok still tracks (without event_id) when the id cannot be derived, like today', () => {
    const t = page();
    const calls: unknown[][] = [];
    (t.window as unknown as Record<string, unknown>).ttq = { identify: () => undefined, track: (...a: unknown[]) => calls.push(a) };
    fire(t, htmlTag('TikTok - CompleteRegistration'), { [V.email]: undefined, [V.regEventId]: undefined });
    expect(calls).toEqual([['CompleteRegistration']]);
  });

  it('Google Ads page_view goes to both Ads destinations only (works without window.gtag)', () => {
    const t = page('https://openart.ai/suite/media');
    const win = t.window as unknown as Record<string, unknown> & { dataLayer: unknown[] };
    fire(t, htmlTag('Google Ads - page_view'), {
      [V.pageLocation]: 'https://openart.ai/suite/media',
      [V.pageReferrer]: 'https://openart.ai/suite/home',
      [V.pageTitle]: 'Media',
    });
    const pushed = win.dataLayer[0] as IArguments;
    expect(Object.prototype.toString.call(pushed)).toBe('[object Arguments]');
    expect(Array.from(pushed)).toEqual([
      'event',
      'page_view',
      {
        send_to: ['AW-11252321380', 'AW-16854695811'],
        page_location: 'https://openart.ai/suite/media',
        page_referrer: 'https://openart.ai/suite/home',
        page_title: 'Media',
      },
    ]);
  });

  it('TikTok page on route change calls ttq.page() once', () => {
    const t = page('https://openart.ai/suite/media');
    const calls: unknown[][] = [];
    (t.window as unknown as Record<string, unknown>).ttq = { page: (...a: unknown[]) => calls.push(a) };
    fire(t, htmlTag('TikTok - page on route change'), {});
    expect(calls).toEqual([[]]);
  });

  it('UET page_view uses the call bat.js makes for SPA routes', () => {
    const t = page('https://openart.ai/suite/brand-kit?x=1');
    fire(t, htmlTag('UET - page_view'), { [V.pageTitle]: 'Brand kit' });
    expect((t.window as unknown as { uetq: unknown[] }).uetq).toEqual(['event', 'page_view', { page_path: '/suite/brand-kit?x=1', page_title: 'Brand kit' }]);
  });

  it('LinkedIn option b tag (server-only) sends nothing when fired', () => {
    const t = page();
    const calls: unknown[][] = [];
    (t.window as unknown as Record<string, unknown>).lintrk = (...a: unknown[]) => calls.push(a);
    const tag = htmlTag('LinkedIn - server-only purchases');
    fire(t, tag, {});
    expect(calls).toEqual([]);
    expect(tag.paused).toBe(true);
    expect(tag.variant).toBe('linkedin-server-only');
    expect(tag.replaces?.tagId).toBe(58);
  });

  it('LinkedIn value variant sends lintrk with event_id and value, or the documented image pixel', () => {
    const t = page();
    const calls: unknown[][] = [];
    (t.window as unknown as Record<string, unknown>).lintrk = (...a: unknown[]) => calls.push(a);
    const tag = htmlTag('LinkedIn - purchase');
    fire(t, tag, { [V.purchaseOrderId]: 'sub_in_1', [V.value]: 56, [V.currency]: 'usd' });
    expect(calls).toEqual([['track', { conversion_id: 29290225, event_id: 'sub_in_1', conversion_value: 56, conversion_currency: 'USD' }]]);
    expect(tag.paused).toBe(true);
  });

  describe('route settler (History Change -> virtual_page_view)', () => {
    const settler = htmlTag('Route settler');
    function run(t: TestWindow, event: string): void {
      fire(t, settler, { Event: event });
    }
    function vpv(t: TestWindow): Array<Record<string, unknown>> {
      return (((t.window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []) as Array<Record<string, unknown>>).filter((e) => e.event === 'virtual_page_view');
    }
    function withFakeTimers(t: TestWindow): void {
      vi.useFakeTimers();
      const w = t.window as unknown as Record<string, unknown>;
      w.setTimeout = (cb: () => void, ms: number) => setTimeout(cb, ms);
      w.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    }

    it('emits exactly one virtual_page_view for the create-image bounce (P07 timings)', () => {
      const t = page('https://openart.ai/suite/home');
      withFakeTimers(t);
      run(t, 'gtm.js');
      const steps: Array<[string, number]> = [
        ['/suite/create-image/gpt-image-2-5', 296],
        ['/suite/create-image', 135],
        ['/suite/create-image/gpt-image-2-5', 55],
        ['/suite/create-image/gpt-image-2-5', 0],
      ];
      for (const [path, wait] of steps) {
        t.window.history.pushState({}, '', path);
        run(t, 'gtm.historyChange-v2');
        vi.advanceTimersByTime(wait);
      }
      vi.advanceTimersByTime(500);
      const events = vpv(t);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        page_path: '/suite/create-image/gpt-image-2-5',
        page_location: 'https://openart.ai/suite/create-image/gpt-image-2-5',
        page_referrer: 'https://openart.ai/suite/home',
        page_view_source: 'gtm_history',
      });
      expect(String(events[0]!.page_view_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('ignores the initial same-URL replaceState and query-only changes', () => {
      const t = page('https://openart.ai/suite/home');
      withFakeTimers(t);
      run(t, 'gtm.js');
      t.window.history.replaceState({ __NA: true }, '', '/suite/home');
      run(t, 'gtm.historyChange-v2');
      t.window.history.pushState({}, '', '/suite/home?creditLedger=nav_credit_display');
      run(t, 'gtm.historyChange-v2');
      vi.advanceTimersByTime(1000);
      expect(vpv(t)).toEqual([]);
    });

    it('stands down when the app contract is installed', () => {
      const t = page('https://openart.ai/suite/home');
      withFakeTimers(t);
      run(t, 'gtm.js');
      (t.window as unknown as Record<string, unknown>).__oaPageViewContract = 'app';
      t.window.history.pushState({}, '', '/suite/media');
      run(t, 'gtm.historyChange-v2');
      vi.advanceTimersByTime(1000);
      expect(vpv(t)).toEqual([]);
    });
  });
});
