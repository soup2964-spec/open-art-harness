/**
 * Builds gtm/import/openart-gtm-fixpack.json: a GTM container export (exportFormatVersion 2) that
 * contains only the new items of the fix pack. Import it into a new workspace with
 * Admin -> Import Container -> Merge -> "Rename conflicting tags, triggers, and variables".
 * Nothing in it conflicts by name: every item is prefixed "OA-FIX" and lives in the
 * "OA-FIX openart-signal" folder.
 *
 * Existing tags are never edited by the import (their workspace names are unknown); CHANGES.md
 * lists the manual edits: pause the replaced originals, template field changes, trigger swaps.
 */
import { createHash } from 'node:crypto';
import { TEMPLATE_DISPLAY_NAME, renderConsentTemplate, DEFAULT_CONFIG as CONSENT_CONFIG } from '../../consent/src/consent-defaults';
import {
  BUILTIN_TRIGGERS,
  FIX_ID_BASE,
  IDS,
  PREFIX,
  TAGS,
  TRIGGERS,
  VARIABLES,
  type AwctTagDef,
  type Condition,
  type HtmlTagDef,
  type TagDef,
  type VariableDef,
} from './fixpack';

export const EXPORT_TIME = '2026-09-29 00:00:00';
/** Import files carry the source container's ids; GTM re-maps them on import. */
export const EXPORT_ACCOUNT_ID = '6000000000';
export const FOLDER_NAME = `${PREFIX} openart-signal`;
/** Export ids: FIX_ID_BASE + position + 1, the same numbers the proof uses as compiled tag_id. */
const fixId = (i: number): string => String(FIX_ID_BASE + i + 1);
export const FOLDER_ID = fixId(0);

export interface GtmParameter {
  type: 'TEMPLATE' | 'BOOLEAN' | 'INTEGER' | 'LIST' | 'MAP' | 'TAG_REFERENCE' | 'TRIGGER_REFERENCE';
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
}

const t = (key: string, value: string): GtmParameter => ({ type: 'TEMPLATE', key, value });
const b = (key: string, value: boolean): GtmParameter => ({ type: 'BOOLEAN', key, value: String(value) });
const ref = (name: string): string => `{{${name}}}`;

function fingerprint(obj: unknown): string {
  // Deterministic, numeric-looking fingerprint derived from content (GTM uses epoch-ms strings).
  const hex = createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
  return String(1_700_000_000_000 + (parseInt(hex, 16) % 100_000_000_000));
}

function variableJson(def: VariableDef, id: string, base: Record<string, string>): Record<string, unknown> {
  let body: Record<string, unknown>;
  if (def.kind === 'dlv') {
    body = {
      name: def.name,
      type: 'v',
      notes: def.note,
      parameter: [{ type: 'INTEGER', key: 'dataLayerVersion', value: '2' }, b('setDefaultValue', false), t('name', def.key)],
      formatValue: {},
    };
  } else if (def.kind === 'cookie') {
    body = {
      name: def.name,
      type: 'k',
      notes: def.note,
      parameter: [b('decodeCookie', def.decode), t('name', def.cookie)],
      formatValue: {},
    };
  } else if (def.kind === 'jsm') {
    body = { name: def.name, type: 'jsm', notes: def.note, parameter: [t('javascript', def.body(ref))], formatValue: {} };
  } else {
    body = {
      name: def.name,
      type: 'awec',
      notes: def.note,
      parameter: [t('mode', 'MANUAL'), t('email', ref(def.emailVariable))],
      formatValue: {},
    };
  }
  return { ...base, variableId: id, ...body, parentFolderId: FOLDER_ID, fingerprint: fingerprint(body) };
}

function condition(c: Condition): Record<string, unknown> {
  return { type: c.op, parameter: [t('arg0', ref(c.variable)), t('arg1', c.value)] };
}

function consentSettings(types: readonly string[]): Record<string, unknown> {
  if (!types.length) return { consentStatus: 'NOT_SET' };
  return { consentStatus: 'NEEDED', consentType: { type: 'LIST', list: types.map((v) => ({ type: 'TEMPLATE', value: v })) } };
}

function awctParameters(def: AwctTagDef): GtmParameter[] {
  const params: GtmParameter[] = [b('enableNewCustomerReporting', false), b('enableConversionLinker', true)];
  if (def.orderIdVariable) params.push(t('orderId', ref(def.orderIdVariable)));
  params.push(b('enableProductReporting', false));
  if (def.valueVariable) params.push(t('conversionValue', ref(def.valueVariable)));
  params.push(b('enableEnhancedConversion', !!def.updVariable));
  if (def.updVariable) params.push(t('cssProvidedEnhancedConversionValue', ref(def.updVariable)));
  params.push(t('conversionCookiePrefix', '_gcl'), b('enableShippingData', false), t('conversionId', def.conversionId));
  if (def.currencyVariable) params.push(t('currencyCode', ref(def.currencyVariable)));
  params.push(
    t('conversionLabel', def.conversionLabel),
    b('rdp', false),
    b('enableProductReportingCheckbox', true),
    b('enableNewCustomerReportingCheckbox', true),
    b('enableEnhancedConversionsCheckbox', !!def.updVariable),
    b('enableRdpCheckbox', true),
    b('enableTransportUrl', false),
    b('enableCustomParams', false),
    b('enableEventParameters', true),
  );
  return params;
}

function htmlParameters(def: HtmlTagDef): GtmParameter[] {
  return [t('html', def.html(ref)), b('supportDocumentWrite', false)];
}

export const TEMPLATE_ID = fixId(0);

function consentTemplateParameters(): GtmParameter[] {
  return [
    t('regulatedRegions', CONSENT_CONFIG.regions.join(',')),
    t('waitForUpdateMs', String(CONSENT_CONFIG.waitForUpdateMs)),
    b('adsDataRedaction', CONSENT_CONFIG.adsDataRedaction),
    b('urlPassthrough', CONSENT_CONFIG.urlPassthrough),
    b('respectOptOut', CONSENT_CONFIG.respectOptOut),
  ];
}

export interface GtmExport {
  exportFormatVersion: 2;
  exportTime: string;
  containerVersion: Record<string, unknown> & {
    tag: Array<Record<string, unknown>>;
    trigger: Array<Record<string, unknown>>;
    variable: Array<Record<string, unknown>>;
    builtInVariable: Array<Record<string, unknown>>;
    customTemplate: Array<Record<string, unknown>>;
    folder: Array<Record<string, unknown>>;
  };
}

export function buildImport(): GtmExport {
  const containerId = IDS.containerId;
  const base = { accountId: EXPORT_ACCOUNT_ID, containerId };

  const variables = VARIABLES.map((v, i) => variableJson(v, fixId(i), base));

  const triggerIds = new Map<string, string>([
    [BUILTIN_TRIGGERS.allPages.name, BUILTIN_TRIGGERS.allPages.id],
    [BUILTIN_TRIGGERS.consentInit.name, BUILTIN_TRIGGERS.consentInit.id],
  ]);
  const triggers = TRIGGERS.map((def, i) => {
    const id = fixId(i);
    triggerIds.set(def.name, id);
    const body: Record<string, unknown> =
      def.kind === 'customEvent'
        ? {
            name: def.name,
            type: 'CUSTOM_EVENT',
            notes: def.note,
            customEventFilter: [{ type: 'EQUALS', parameter: [t('arg0', '{{_event}}'), t('arg1', def.event)] }],
            ...(def.filters.length ? { filter: def.filters.map(condition) } : {}),
          }
        : { name: def.name, type: 'HISTORY_CHANGE', notes: def.note };
    return { ...base, triggerId: id, ...body, parentFolderId: FOLDER_ID, fingerprint: fingerprint(body) };
  });

  const templateType = `cvt_${containerId}_${TEMPLATE_ID}`;
  const tags = TAGS.map((def: TagDef, i) => {
    const firingTriggerId = def.triggers.map((name) => {
      const id = triggerIds.get(name);
      if (!id) throw new Error(`unknown trigger ${name} on ${def.name}`);
      return id;
    });
    const type = def.kind === 'html' ? 'html' : def.kind === 'awct' ? 'awct' : templateType;
    const parameter =
      def.kind === 'html' ? htmlParameters(def) : def.kind === 'awct' ? awctParameters(def) : consentTemplateParameters();
    const notes = [def.note, def.replaces && !def.paused ? `Replaces compiled tag_id ${def.replaces.tagId} (${def.replaces.what}): pause the original.` : '']
      .filter(Boolean)
      .join(' ');
    const body = {
      name: def.name,
      type,
      parameter,
      firingTriggerId,
      tagFiringOption: def.firing,
      monitoringMetadata: { type: 'MAP' },
      consentSettings: consentSettings(def.consent),
      ...(def.paused ? { paused: true } : {}),
      notes,
    };
    return { ...base, tagId: fixId(i), ...body, parentFolderId: FOLDER_ID, fingerprint: fingerprint(body) };
  });

  const builtInVariable = [{ ...base, type: 'EVENT', name: 'Event' }];

  const templateData = renderConsentTemplate();
  const customTemplate = [
    {
      ...base,
      templateId: TEMPLATE_ID,
      name: TEMPLATE_DISPLAY_NAME,
      fingerprint: fingerprint(templateData),
      templateData,
    },
  ];

  const folder = [{ ...base, folderId: FOLDER_ID, name: FOLDER_NAME, fingerprint: fingerprint(FOLDER_NAME) }];

  const containerVersion = {
    path: `accounts/${EXPORT_ACCOUNT_ID}/containers/${containerId}/versions/0`,
    ...base,
    containerVersionId: '0',
    container: {
      path: `accounts/${EXPORT_ACCOUNT_ID}/containers/${containerId}`,
      ...base,
      name: 'openart.ai',
      publicId: IDS.gtmPublicId,
      usageContext: ['WEB'],
      fingerprint: fingerprint(IDS.gtmPublicId),
      tagManagerUrl: `https://tagmanager.google.com/#/container/accounts/${EXPORT_ACCOUNT_ID}/containers/${containerId}/workspaces?apiLink=container`,
      tagIds: [IDS.gtmPublicId],
    },
    tag: tags,
    trigger: triggers,
    variable: variables,
    folder,
    builtInVariable,
    customTemplate,
    fingerprint: fingerprint({ tags, triggers, variables }),
    tagManagerUrl: `https://tagmanager.google.com/#/versions/accounts/${EXPORT_ACCOUNT_ID}/containers/${containerId}/versions/0?apiLink=version`,
  };

  return { exportFormatVersion: 2, exportTime: EXPORT_TIME, containerVersion };
}

export function renderImportJson(): string {
  return `${JSON.stringify(buildImport(), null, 4)}\n`;
}
