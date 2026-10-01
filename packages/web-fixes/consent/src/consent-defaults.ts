/**
 * Consent Mode v2 defaults for OpenArt, in two equivalent forms:
 *  - `renderConsentTemplate()` — a GTM custom tag template (sandboxed JS: setDefaultConsentState +
 *    gtagSet) for the Consent Initialization trigger. This is what the import file ships.
 *  - `applyConsentDefaults()` — the same commands as on-page gtag() calls, for the edge (or the
 *    sealed proof) to run before the GTM snippet.
 *
 * Why not a Custom HTML tag: GTM appends dataLayer pushes made while it is processing an event to
 * the end of its queue, and it synthesises gtm.init_consent in front of gtm.init/gtm.js
 * (gtm_56CMP8K v25 runtime: `c.push=function(){…f.D.push.apply(f.D,m)…}` and
 * `a.D.unshift(p,d);c=k` in CE()). A gtag('consent','default') from Custom HTML is therefore
 * processed after the Google tag (gtm.init) and the Conversion Linker (gtm.js) have fired.
 * Template APIs apply synchronously, before those events.
 *
 * Regions: packages/contracts CONSENT_REQUIRED_REGIONS, the single list edge-attribution,
 * conversion-service and audience-sync also use: Google's EU user consent policy scope (EEA =
 * EU27 + IS, LI, NO; UK; CH) plus the EU territories geolocation reports under their own codes
 * (outermost regions, Åland, Canary Islands IC, Ceuta and Melilla EA).
 *
 * Browser opt-outs (./privacy-signals.ts): with `respectOptOut` (default), a stored ad_storage
 * denial, a US "do not sell or share" opt-out (`oa_consent.opt_out_sale_sharing`, IAB
 * `usprivacy`) or Global Privacy Control without an explicit grant makes the GLOBAL default deny
 * ad_storage, ad_user_data and ad_personalization too, in the same order the click-ID shim, the
 * HubSpot fill and edge-attribution apply.
 */
// The contracts module itself, not the package index: the index also loads the zod validators,
// which would end up in every browser bundle built from this file.
import { CONSENT_REQUIRED_REGIONS, consentCountry } from '../../../contracts/src/consent-regions';
import { CONSENT_COOKIE, US_PRIVACY_COOKIE, adConsentDecision, readPrivacySignals, type PrivacySignalWindow } from './privacy-signals';

/**
 * The contracts list, normalised to the ISO 3166-1 codes geolocation reports: the contracts'
 * input alias UK is GB here (Google matches ISO codes only).
 */
export const CONSENT_REGIONS: readonly string[] = [
  ...new Set([...CONSENT_REQUIRED_REGIONS].map((code) => consentCountry(code)).filter((code): code is string => code !== null)),
];

export type ConsentValue = 'granted' | 'denied';
export const CONSENT_TYPES = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
  'analytics_storage',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];
export type ConsentState = Record<ConsentType, ConsentValue>;

export interface ConsentDefaultsConfig {
  regions: readonly string[];
  /** Milliseconds tags wait for a CMP update in the regulated regions. */
  waitForUpdateMs: number;
  adsDataRedaction: boolean;
  urlPassthrough: boolean;
  /**
   * Deny the three ad signals in the global default when the browser opted out (GPC, a US
   * sale/sharing opt-out or a stored ad_storage denial, without an explicit grant over GPC).
   */
  respectOptOut: boolean;
}

export const DEFAULT_CONFIG: ConsentDefaultsConfig = {
  regions: CONSENT_REGIONS,
  waitForUpdateMs: 500,
  adsDataRedaction: true,
  urlPassthrough: true,
  respectOptOut: true,
};

/** Regulated regions: everything denied except security (strictly necessary). */
export const REGULATED_DEFAULT: ConsentState = {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'denied',
  personalization_storage: 'denied',
  security_storage: 'granted',
};

/**
 * Everywhere else: granted, explicitly. Same tag behaviour as today, but Consent Mode is now
 * "set" (gcd moves from `l` to `t`), which makes the setup auditable and lets a CMP update it.
 */
export const GLOBAL_DEFAULT: ConsentState = {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted',
  functionality_storage: 'granted',
  personalization_storage: 'granted',
  security_storage: 'granted',
};

/** Global default when the browser opted out of ad use: the ad signals denied, the rest as GLOBAL_DEFAULT. */
export const AD_OPT_OUT_GLOBAL_DEFAULT: ConsentState = {
  ...GLOBAL_DEFAULT,
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
};

export type GtagCommand = ['consent', 'default', Record<string, unknown>] | ['set', string, unknown];

export interface BrowserOptOut {
  /** See browserAdOptOut(). */
  adOptOut: boolean;
}

/**
 * The page's ad opt-out, decided like the shim and the HubSpot fill (privacy-signals.ts
 * adConsentDecision): an explicit ad_storage denial or a recorded sale/sharing opt-out, or GPC
 * without an explicit grant.
 */
export function browserAdOptOut(win: PrivacySignalWindow): boolean {
  const decision = adConsentDecision(readPrivacySignals(win));
  return decision === 'denied' || decision === 'opt_out';
}

export function consentDefaultCommands(config: ConsentDefaultsConfig = DEFAULT_CONFIG, browser: BrowserOptOut = { adOptOut: false }): GtagCommand[] {
  if (!config.regions.length) throw new Error('at least one regulated region is required');
  for (const r of config.regions) if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(r)) throw new Error(`invalid ISO 3166 region: ${r}`);
  const global = config.respectOptOut && browser.adOptOut ? AD_OPT_OUT_GLOBAL_DEFAULT : GLOBAL_DEFAULT;
  const commands: GtagCommand[] = [
    ['consent', 'default', { ...REGULATED_DEFAULT, region: [...config.regions], wait_for_update: config.waitForUpdateMs }],
    ['consent', 'default', { ...global }],
  ];
  if (config.adsDataRedaction) commands.push(['set', 'ads_data_redaction', true]);
  if (config.urlPassthrough) commands.push(['set', 'url_passthrough', true]);
  return commands;
}

export interface ConsentWindow extends Partial<PrivacySignalWindow> {
  dataLayer?: unknown[];
}

/**
 * Push the defaults as real gtag() calls (Arguments objects — GTM ignores plain arrays).
 * Must run before the GTM / Google tag gateway snippet.
 */
export function applyConsentDefaults(win: ConsentWindow, config: ConsentDefaultsConfig = DEFAULT_CONFIG): number {
  const dataLayer = (win.dataLayer = win.dataLayer || []);
  function gtag(..._args: unknown[]): void {
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  }
  const adOptOut = config.respectOptOut && browserAdOptOut(win as PrivacySignalWindow);
  const commands = consentDefaultCommands(config, { adOptOut });
  for (const command of commands) gtag(...command);
  return commands.length;
}

/* ------------------------------------------------------------------ */
/* GTM custom template (.tpl)                                          */
/* ------------------------------------------------------------------ */

const TOS = `___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.`;

/**
 * Sandboxed JS (GTM template language: no `new`, `this` or regex literals). `data` is the tag's
 * field values; `require` exposes the sandboxed APIs.
 */
export function renderSandboxedJs(): string {
  const regulated = JSON.stringify(REGULATED_DEFAULT, null, 2).replace(/\n/g, '\n  ');
  const global = JSON.stringify(GLOBAL_DEFAULT, null, 2).replace(/\n/g, '\n  ');
  const optedOut = JSON.stringify(AD_OPT_OUT_GLOBAL_DEFAULT, null, 2).replace(/\n/g, '\n    ');
  return `const setDefaultConsentState = require('setDefaultConsentState');
const gtagSet = require('gtagSet');
const makeNumber = require('makeNumber');
const copyFromWindow = require('copyFromWindow');
const getCookieValues = require('getCookieValues');
const JSON = require('JSON');

// Regulated regions (EEA, UK, CH, EU outermost regions, Aland): denied until the CMP updates.
const raw = data.regulatedRegions ? data.regulatedRegions.split(',') : [];
const regions = [];
for (let i = 0; i < raw.length; i++) {
  const code = raw[i].trim();
  if (code) regions.push(code);
}
const waitMs = makeNumber(data.waitForUpdateMs);

const regulated = ${regulated};
regulated.region = regions;
regulated.wait_for_update = waitMs > 0 ? waitMs : 500;
setDefaultConsentState(regulated);

// Browser opt-out, decided in the order of consent/src/privacy-signals.ts adConsentDecision: an
// explicit ad_storage denial or a US "do not sell or share" opt-out (${CONSENT_COOKIE}
// opt_out_sale_sharing, IAB ${US_PRIVACY_COOKIE} 1?Y?), or Global Privacy Control without an
// explicit grant.
let adOptOut = false;
if (data.respectOptOut) {
  let stored = {};
  const consentCookie = getCookieValues('${CONSENT_COOKIE}');
  if (consentCookie && consentCookie.length) {
    const parsed = JSON.parse(consentCookie[0]);
    if (parsed && typeof parsed === 'object') {
      stored = parsed;
    }
  }
  let adStorage = copyFromWindow('__oaConsent.ad_storage');
  if (adStorage !== 'granted' && adStorage !== 'denied') {
    adStorage = stored.ad_storage;
  }
  let saleOptOut = stored.opt_out_sale_sharing === true;
  const usPrivacy = getCookieValues('${US_PRIVACY_COOKIE}');
  if (usPrivacy && usPrivacy.length && typeof usPrivacy[0] === 'string') {
    const usp = usPrivacy[0].trim().toUpperCase();
    const flags = 'YN-';
    if (usp.length === 4 && usp.charAt(0) === '1' && flags.indexOf(usp.charAt(1)) > -1 && flags.indexOf(usp.charAt(2)) > -1 && flags.indexOf(usp.charAt(3)) > -1 && usp.charAt(2) === 'Y') {
      saleOptOut = true;
    }
  }
  const gpc = copyFromWindow('navigator.globalPrivacyControl') === true;
  if (adStorage === 'denied' || saleOptOut) {
    adOptOut = true;
  } else if (adStorage !== 'granted' && gpc) {
    adOptOut = true;
  }
}

if (adOptOut) {
  // The browser opted out: the ad signals are denied everywhere until the CMP updates.
  setDefaultConsentState(${optedOut});
} else {
  // Everywhere else: granted (explicit, so Consent Mode reports a state instead of "not set").
  setDefaultConsentState(${global});
}

const settings = {};
let hasSettings = false;
if (data.adsDataRedaction) {
  settings.ads_data_redaction = true;
  hasSettings = true;
}
if (data.urlPassthrough) {
  settings.url_passthrough = true;
  hasSettings = true;
}
if (hasSettings) {
  gtagSet(settings);
}

data.gtmOnSuccess();
`;
}

export function templateParameters(config: ConsentDefaultsConfig = DEFAULT_CONFIG): unknown[] {
  return [
    {
      type: 'TEXT',
      name: 'regulatedRegions',
      displayName: 'Regions defaulting to denied (ISO 3166 codes, comma-separated)',
      simpleValueType: true,
      defaultValue: config.regions.join(','),
      valueValidators: [{ type: 'NON_EMPTY' }],
    },
    {
      type: 'TEXT',
      name: 'waitForUpdateMs',
      displayName: 'wait_for_update (ms) for the regulated regions',
      simpleValueType: true,
      defaultValue: String(config.waitForUpdateMs),
      valueValidators: [{ type: 'POSITIVE_NUMBER' }],
    },
    {
      type: 'CHECKBOX',
      name: 'adsDataRedaction',
      checkboxText: 'ads_data_redaction (redact ad click ids when ad_storage is denied)',
      simpleValueType: true,
      defaultValue: config.adsDataRedaction,
    },
    {
      type: 'CHECKBOX',
      name: 'urlPassthrough',
      checkboxText: 'url_passthrough (pass gclid/dclid/wbraid via links when storage is denied)',
      simpleValueType: true,
      defaultValue: config.urlPassthrough,
    },
    {
      type: 'CHECKBOX',
      name: 'respectOptOut',
      checkboxText:
        'Deny ad_storage, ad_user_data and ad_personalization everywhere when the browser sends Global Privacy Control, or oa_consent / usprivacy record a US sale/sharing opt-out or an ad_storage denial',
      simpleValueType: true,
      defaultValue: config.respectOptOut,
    },
  ];
}

function permissionConsentTypes(): unknown {
  return {
    type: 2,
    listItem: CONSENT_TYPES.map((t) => ({
      type: 3,
      mapKey: [
        { type: 1, string: 'consentType' },
        { type: 1, string: 'read' },
        { type: 1, string: 'write' },
      ],
      mapValue: [
        { type: 1, string: t },
        { type: 8, boolean: false },
        { type: 8, boolean: true },
      ],
    })),
  };
}

/** access_globals: read-only access to the keys copyFromWindow() reads. */
function permissionGlobalKeys(keys: readonly string[]): unknown {
  return {
    type: 2,
    listItem: keys.map((key) => ({
      type: 3,
      mapKey: [
        { type: 1, string: 'key' },
        { type: 1, string: 'read' },
        { type: 1, string: 'write' },
        { type: 1, string: 'execute' },
      ],
      mapValue: [
        { type: 1, string: key },
        { type: 8, boolean: true },
        { type: 8, boolean: false },
        { type: 8, boolean: false },
      ],
    })),
  };
}

export const TEMPLATE_GLOBAL_READS = ['navigator.globalPrivacyControl', '__oaConsent.ad_storage'] as const;
export const TEMPLATE_COOKIE_READS = [CONSENT_COOKIE, US_PRIVACY_COOKIE] as const;

export function templatePermissions(): unknown[] {
  return [
    {
      instance: {
        key: { publicId: 'access_consent', versionId: '1' },
        param: [{ key: 'consentTypes', value: permissionConsentTypes() }],
      },
      clientAnnotations: { isEditedByUser: true },
      isRequired: true,
    },
    {
      instance: {
        key: { publicId: 'write_data_layer', versionId: '1' },
        param: [
          {
            key: 'keyPatterns',
            value: { type: 2, listItem: [{ type: 1, string: 'ads_data_redaction' }, { type: 1, string: 'url_passthrough' }] },
          },
        ],
      },
      clientAnnotations: { isEditedByUser: true },
      isRequired: true,
    },
    {
      instance: {
        key: { publicId: 'access_globals', versionId: '1' },
        param: [{ key: 'keys', value: permissionGlobalKeys(TEMPLATE_GLOBAL_READS) }],
      },
      clientAnnotations: { isEditedByUser: true },
      isRequired: true,
    },
    {
      instance: {
        key: { publicId: 'get_cookies', versionId: '1' },
        param: [
          { key: 'cookieAccess', value: { type: 1, string: 'specific' } },
          { key: 'cookieNames', value: { type: 2, listItem: TEMPLATE_COOKIE_READS.map((name) => ({ type: 1, string: name })) } },
        ],
      },
      clientAnnotations: { isEditedByUser: true },
      isRequired: true,
    },
  ];
}

export const TEMPLATE_DISPLAY_NAME = 'OA-FIX Consent Mode v2 defaults (region-scoped)';

export function renderConsentTemplate(config: ConsentDefaultsConfig = DEFAULT_CONFIG): string {
  const info = {
    type: 'TAG',
    id: 'cvt_temp_public_id',
    version: 1,
    securityGroups: [],
    displayName: TEMPLATE_DISPLAY_NAME,
    categories: ['UTILITY'],
    brand: { id: 'brand_dummy', displayName: '' },
    description:
      'Consent Mode v2 defaults for OpenArt: denied in the EEA, UK, CH and the EU territories geolocated separately (packages/contracts CONSENT_REQUIRED_REGIONS) with wait_for_update, granted elsewhere; ad signals denied everywhere when the browser sends Global Privacy Control or a US sale/sharing opt-out is recorded; ads_data_redaction and url_passthrough. Fire on Consent Initialization - All Pages. A certified CMP then calls consent update.',
    containerContexts: ['WEB'],
  };
  return [
    TOS,
    '',
    '',
    '___INFO___',
    '',
    JSON.stringify(info, null, 2),
    '',
    '',
    '___TEMPLATE_PARAMETERS___',
    '',
    JSON.stringify(templateParameters(config), null, 2),
    '',
    '',
    '___SANDBOXED_JS_FOR_WEB_TEMPLATE___',
    '',
    renderSandboxedJs(),
    '',
    '___WEB_PERMISSIONS___',
    '',
    JSON.stringify(templatePermissions(), null, 2),
    '',
    '',
    '___TESTS___',
    '',
    'scenarios: []',
    '',
    '',
    '___NOTES___',
    '',
    'Generated by openart-signal/packages/web-fixes (consent/src/consent-defaults.ts).',
    '',
  ].join('\n');
}

/** Split a .tpl into its sections (used by tests and by the import builder). */
export function parseTemplateSections(tpl: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^___([A-Z_]+)___$/gm;
  const marks: Array<{ name: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) marks.push({ name: m[1]!, start: m.index, end: m.index + m[0].length });
  marks.forEach((mark, i) => {
    const next = marks[i + 1];
    out[mark.name] = tpl.slice(mark.end, next ? next.start : undefined).trim();
  });
  return out;
}
