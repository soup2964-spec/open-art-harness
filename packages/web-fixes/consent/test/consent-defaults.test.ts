import { describe, expect, it } from 'vitest';
import { CONSENT_REQUIRED_REGIONS, consentCountry } from '../../../contracts/src/consent-regions';
import {
  AD_OPT_OUT_GLOBAL_DEFAULT,
  CONSENT_REGIONS,
  CONSENT_TYPES,
  DEFAULT_CONFIG,
  GLOBAL_DEFAULT,
  REGULATED_DEFAULT,
  applyConsentDefaults,
  consentDefaultCommands,
  parseTemplateSections,
  renderConsentTemplate,
  renderSandboxedJs,
} from '../src/consent-defaults';

describe('consentDefaultCommands', () => {
  it('denies everything but security storage in the regulated regions, with wait_for_update', () => {
    const [regional, global, ...sets] = consentDefaultCommands();
    expect(regional).toEqual(['consent', 'default', { ...REGULATED_DEFAULT, region: [...CONSENT_REGIONS], wait_for_update: 500 }]);
    expect(global).toEqual(['consent', 'default', GLOBAL_DEFAULT]);
    expect(sets).toEqual([
      ['set', 'ads_data_redaction', true],
      ['set', 'url_passthrough', true],
    ]);
  });

  it('is the contracts list (CONSENT_REQUIRED_REGIONS), normalised to the ISO codes geolocation reports', () => {
    const expected = new Set([...CONSENT_REQUIRED_REGIONS].map((c) => consentCountry(c)).filter((c): c is string => c !== null));
    expect(new Set(CONSENT_REGIONS)).toEqual(expected);
    expect(new Set(CONSENT_REGIONS).size).toBe(CONSENT_REGIONS.length);
    for (const code of ['DE', 'FR', 'IE', 'IS', 'LI', 'NO', 'GB', 'CH', 'RE', 'AX', 'IC', 'EA']) expect(CONSENT_REGIONS).toContain(code);
    for (const code of ['US', 'CA', 'BR', 'IN', 'JP', 'UK']) expect(CONSENT_REGIONS).not.toContain(code); // UK is the contracts alias of GB
  });

  it('denies the three ad signals everywhere when the browser opted out (GPC or a US sale/sharing opt-out)', () => {
    const [regional, global, ...sets] = consentDefaultCommands(DEFAULT_CONFIG, { adOptOut: true });
    expect(regional).toEqual(consentDefaultCommands()[0]);
    expect(global).toEqual(['consent', 'default', AD_OPT_OUT_GLOBAL_DEFAULT]);
    expect(AD_OPT_OUT_GLOBAL_DEFAULT).toEqual({ ...GLOBAL_DEFAULT, ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    expect(sets).toHaveLength(2);
    expect(consentDefaultCommands({ ...DEFAULT_CONFIG, respectOptOut: false }, { adOptOut: true })[1]).toEqual(['consent', 'default', GLOBAL_DEFAULT]);
  });

  it('rejects malformed region codes', () => {
    expect(() => consentDefaultCommands({ ...DEFAULT_CONFIG, regions: ['de'] })).toThrow();
    expect(() => consentDefaultCommands({ ...DEFAULT_CONFIG, regions: [] })).toThrow();
  });
});

describe('applyConsentDefaults', () => {
  const globalDefault = (win: { dataLayer?: unknown[] }) => Array.from(win.dataLayer![1] as ArrayLike<unknown>)[2];

  it('reads navigator.globalPrivacyControl and the US opt-out cookies from the page', () => {
    const cases: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{ navigator: { globalPrivacyControl: true }, document: { cookie: '' } }, AD_OPT_OUT_GLOBAL_DEFAULT],
      [{ navigator: {}, document: { cookie: 'usprivacy=1YYN' } }, AD_OPT_OUT_GLOBAL_DEFAULT],
      [{ navigator: {}, document: { cookie: `oa_consent=${encodeURIComponent(JSON.stringify({ opt_out_sale_sharing: true }))}` } }, AD_OPT_OUT_GLOBAL_DEFAULT],
      [{ navigator: {}, document: { cookie: `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: 'denied' }))}` } }, AD_OPT_OUT_GLOBAL_DEFAULT],
      // An explicit grant over GPC is the visitor opting back in (same order as the shim and the edge).
      [{ navigator: { globalPrivacyControl: true }, document: { cookie: `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: 'granted' }))}` } }, GLOBAL_DEFAULT],
      [{ navigator: {}, document: { cookie: 'usprivacy=1YNN' } }, GLOBAL_DEFAULT],
      [{}, GLOBAL_DEFAULT],
    ];
    for (const [page, expected] of cases) {
      const win: { dataLayer?: unknown[] } = { ...page };
      applyConsentDefaults(win);
      expect(globalDefault(win), JSON.stringify(page)).toEqual(expected);
    }
  });

  it('pushes real Arguments objects (GTM ignores plain arrays)', () => {
    const win: { dataLayer?: unknown[] } = { dataLayer: [{ event: 'gtm.js' }] };
    expect(applyConsentDefaults(win)).toBe(4);
    const pushed = win.dataLayer!.slice(1);
    for (const entry of pushed) expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    expect(Array.from(pushed[0] as ArrayLike<unknown>).slice(0, 2)).toEqual(['consent', 'default']);
  });
});

describe('GTM custom template', () => {
  const tpl = renderConsentTemplate();
  const sections = parseTemplateSections(tpl);

  it('has every section GTM expects, with valid JSON', () => {
    expect(Object.keys(sections)).toEqual([
      'TERMS_OF_SERVICE',
      'INFO',
      'TEMPLATE_PARAMETERS',
      'SANDBOXED_JS_FOR_WEB_TEMPLATE',
      'WEB_PERMISSIONS',
      'TESTS',
      'NOTES',
    ]);
    const info = JSON.parse(sections.INFO!);
    expect(info).toMatchObject({ type: 'TAG', containerContexts: ['WEB'], version: 1 });
    expect(JSON.parse(sections.TEMPLATE_PARAMETERS!).map((p: { name: string }) => p.name)).toEqual([
      'regulatedRegions',
      'waitForUpdateMs',
      'adsDataRedaction',
      'urlPassthrough',
      'respectOptOut',
    ]);
    const perms = JSON.parse(sections.WEB_PERMISSIONS!) as Array<{ instance: { key: { publicId: string } } }>;
    expect(perms.map((p) => p.instance.key.publicId)).toEqual(['access_consent', 'write_data_layer', 'access_globals', 'get_cookies']);
  });

  it('grants write permission for every consent type the code sets', () => {
    const perms = JSON.parse(sections.WEB_PERMISSIONS!) as Array<{
      instance: { key: { publicId: string }; param: Array<{ value: { listItem: Array<{ mapValue: Array<{ string?: string; boolean?: boolean }> }> } }> };
    }>;
    const consent = perms[0]!.instance.param[0]!.value.listItem.map((i) => [i.mapValue[0]!.string, i.mapValue[2]!.boolean]);
    expect(consent).toEqual(CONSENT_TYPES.map((t) => [t, true]));
  });

  /** The sandbox APIs the template uses, backed by a fake page (window globals + cookies). */
  function runSandboxed(data: Record<string, unknown>, page: { globals?: Record<string, unknown>; cookies?: Record<string, string> } = {}) {
    const calls: Array<[string, unknown]> = [];
    const reads: string[] = [];
    let succeeded = false;
    const apis: Record<string, unknown> = {
      setDefaultConsentState: (s: unknown) => calls.push(['setDefaultConsentState', JSON.parse(JSON.stringify(s))]),
      gtagSet: (s: unknown) => calls.push(['gtagSet', JSON.parse(JSON.stringify(s))]),
      makeNumber: (v: unknown) => {
        const n = Number(v);
        return Number.isNaN(n) ? undefined : n;
      },
      copyFromWindow: (key: string) => {
        reads.push(`global:${key}`);
        return page.globals?.[key];
      },
      getCookieValues: (name: string) => {
        reads.push(`cookie:${name}`);
        return page.cookies && name in page.cookies ? [page.cookies[name]] : [];
      },
      // Sandboxed JSON.parse returns undefined instead of throwing.
      JSON: {
        parse: (text: string) => {
          try {
            return JSON.parse(text);
          } catch {
            return undefined;
          }
        },
        stringify: JSON.stringify,
      },
    };
    const requireFn = (name: string) => {
      if (!apis[name]) throw new Error(`template requires an API it did not declare: ${name}`);
      return apis[name];
    };
    new Function('require', 'data', `"use strict";\n${sections.SANDBOXED_JS_FOR_WEB_TEMPLATE}`)(requireFn, {
      ...data,
      gtmOnSuccess: () => {
        succeeded = true;
      },
    });
    return { calls, succeeded, reads };
  }

  const defaults = (): Record<string, unknown> => {
    const params = JSON.parse(sections.TEMPLATE_PARAMETERS!) as Array<{ name: string; defaultValue: unknown }>;
    return Object.fromEntries(params.map((p) => [p.name, p.defaultValue]));
  };

  it('executes like the on-page commands with the default field values', () => {
    const { calls, succeeded } = runSandboxed(defaults());
    expect(succeeded).toBe(true);
    const [regional, global, ...sets] = consentDefaultCommands();
    expect(calls).toEqual([
      ['setDefaultConsentState', regional![2]],
      ['setDefaultConsentState', global![2]],
      ['gtagSet', Object.fromEntries(sets.map((s) => [s[1], s[2]]))],
    ]);
  });

  it('applies the same GPC / US opt-out decision as the on-page form', () => {
    const oa = (o: unknown) => JSON.stringify(o);
    const pages: Array<{ globals?: Record<string, unknown>; cookies?: Record<string, string> }> = [
      { globals: { 'navigator.globalPrivacyControl': true } },
      { cookies: { usprivacy: '1YYN' } },
      { cookies: { oa_consent: oa({ opt_out_sale_sharing: true }) } },
      { cookies: { oa_consent: oa({ ad_storage: 'granted', opt_out_sale_sharing: true }) } },
      { cookies: { oa_consent: oa({ ad_storage: 'denied' }) } },
      { globals: { 'navigator.globalPrivacyControl': true }, cookies: { oa_consent: oa({ ad_storage: 'granted' }) } },
      { cookies: { usprivacy: '1YNN', oa_consent: '{not json' } },
      { globals: { 'navigator.globalPrivacyControl': 'true' } },
      { globals: { '__oaConsent.ad_storage': 'denied' } },
      { globals: { 'navigator.globalPrivacyControl': true, '__oaConsent.ad_storage': 'granted' }, cookies: { oa_consent: oa({ ad_storage: 'denied' }) } },
      { cookies: { usprivacy: ' 1nyn ' } },
      { cookies: { usprivacy: '1Y' } },
      {},
    ];
    for (const page of pages) {
      const onPage = { dataLayer: [] as unknown[], __oaConsent: { ad_storage: page.globals?.['__oaConsent.ad_storage'] }, navigator: { globalPrivacyControl: page.globals?.['navigator.globalPrivacyControl'] }, document: { cookie: Object.entries(page.cookies ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') } };
      applyConsentDefaults(onPage);
      const expected = onPage.dataLayer.map((a) => Array.from(a as ArrayLike<unknown>));
      const { calls } = runSandboxed(defaults(), page);
      expect(calls.slice(0, 2), JSON.stringify(page)).toEqual([
        ['setDefaultConsentState', expected[0]![2]],
        ['setDefaultConsentState', expected[1]![2]],
      ]);
    }
  });

  it('reads no global or cookie when respectOptOut is off', () => {
    const { calls, reads } = runSandboxed({ ...defaults(), respectOptOut: false }, { globals: { 'navigator.globalPrivacyControl': true } });
    expect(reads).toEqual([]);
    expect(calls[1]).toEqual(['setDefaultConsentState', GLOBAL_DEFAULT]);
  });

  it('declares read access to exactly the global and cookies it reads', () => {
    const perms = JSON.parse(sections.WEB_PERMISSIONS!) as Array<{ instance: { key: { publicId: string }; param: unknown[] } }>;
    const text = JSON.stringify(perms);
    expect(text).toContain('navigator.globalPrivacyControl');
    expect(text).toContain('__oaConsent.ad_storage');
    for (const cookie of ['oa_consent', 'usprivacy']) expect(text).toContain(`"${cookie}"`);
  });

  it('skips gtagSet when both checkboxes are off and falls back to 500 ms', () => {
    const { calls } = runSandboxed({ regulatedRegions: 'DE, FR', waitForUpdateMs: 'abc', adsDataRedaction: false, urlPassthrough: false });
    expect(calls.map((c) => c[0])).toEqual(['setDefaultConsentState', 'setDefaultConsentState']);
    expect(calls[0]![1]).toMatchObject({ region: ['DE', 'FR'], wait_for_update: 500 });
  });

  it('stays inside the sandboxed-JS subset', () => {
    const js = renderSandboxedJs();
    expect(js).not.toMatch(/\bnew\s+[A-Z]/);
    expect(js).not.toMatch(/\bthis\b/);
    expect(js).not.toMatch(/[=(,]\s*\/[^/*]/); // regex literal
    expect([...js.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])).toEqual([
      'setDefaultConsentState',
      'gtagSet',
      'makeNumber',
      'copyFromWindow',
      'getCookieValues',
      'JSON',
    ]);
  });
});
