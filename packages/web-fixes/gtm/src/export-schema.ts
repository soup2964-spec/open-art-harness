/**
 * Structural validation of a GTM container export (exportFormatVersion 2), as produced by
 * Admin -> Export Container and accepted by Admin -> Import Container.
 *
 * Shape: {exportFormatVersion: 2, exportTime, containerVersion: {accountId, containerId, container,
 * tag[], trigger[], variable[], builtInVariable[], folder[], customTemplate[], …}}. Items carry
 * accountId/containerId, an id, a name and `parameter` lists of {type, key, value|list|map}.
 * Tags reference triggers by id (`firingTriggerId`), variables are referenced as {{Name}},
 * custom-template tags use type `cvt_<containerId>_<templateId>`.
 */
import { z } from 'zod';
import { findEs5Violations, scriptBodies } from './es5';

export interface GtmParameterShape {
  type: 'TEMPLATE' | 'BOOLEAN' | 'INTEGER' | 'LIST' | 'MAP' | 'TAG_REFERENCE' | 'TRIGGER_REFERENCE' | 'TYPE_UNSPECIFIED';
  key?: string;
  value?: string;
  list?: GtmParameterShape[];
  map?: GtmParameterShape[];
}

export const ParameterSchema: z.ZodType<GtmParameterShape> = z.lazy(() =>
  z
    .object({
      type: z.enum(['TEMPLATE', 'BOOLEAN', 'INTEGER', 'LIST', 'MAP', 'TAG_REFERENCE', 'TRIGGER_REFERENCE', 'TYPE_UNSPECIFIED']),
      key: z.string().optional(),
      value: z.string().optional(),
      list: z.array(ParameterSchema).optional(),
      map: z.array(ParameterSchema).optional(),
    })
    .strict()
    .superRefine((p, ctx) => {
      if (p.type === 'BOOLEAN' && p.value !== 'true' && p.value !== 'false') ctx.addIssue({ code: 'custom', message: 'BOOLEAN value must be "true" or "false"' });
      if (p.type === 'INTEGER' && !/^-?\d+$/.test(p.value ?? '')) ctx.addIssue({ code: 'custom', message: 'INTEGER value must be digits' });
      if (p.type === 'LIST' && !p.list) ctx.addIssue({ code: 'custom', message: 'LIST needs list' });
      if (p.type === 'MAP' && !p.map) ctx.addIssue({ code: 'custom', message: 'MAP needs map' });
    }),
);

const Id = z.string().regex(/^\d+$/);
const Fingerprint = z.string().regex(/^\d+$/);

const ConditionSchema = z
  .object({
    type: z.enum(['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'MATCH_REGEX', 'GREATER', 'GREATER_OR_EQUALS', 'LESS', 'LESS_OR_EQUALS', 'CSS_SELECTOR', 'URL_MATCHES']),
    parameter: z.array(ParameterSchema).min(2),
  })
  .strict();

const ConsentSettingsSchema = z.union([
  z.object({ consentStatus: z.enum(['NOT_SET', 'NOT_NEEDED']) }).strict(),
  z
    .object({
      consentStatus: z.literal('NEEDED'),
      consentType: z
        .object({
          type: z.literal('LIST'),
          list: z
            .array(
              z
                .object({
                  type: z.literal('TEMPLATE'),
                  value: z.enum(['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization', 'functionality_storage', 'personalization_storage', 'security_storage']),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    })
    .strict(),
]);

const ItemBase = {
  accountId: Id,
  containerId: Id,
  name: z.string().min(1),
  fingerprint: Fingerprint,
  parentFolderId: Id.optional(),
  notes: z.string().optional(),
};

export const TagSchema = z
  .object({
    ...ItemBase,
    tagId: Id,
    type: z.string().min(1),
    parameter: z.array(ParameterSchema),
    firingTriggerId: z.array(Id).min(1),
    blockingTriggerId: z.array(Id).optional(),
    tagFiringOption: z.enum(['ONCE_PER_EVENT', 'ONCE_PER_LOAD', 'UNLIMITED']),
    monitoringMetadata: z.object({ type: z.literal('MAP') }).strict(),
    consentSettings: ConsentSettingsSchema,
    paused: z.boolean().optional(),
  })
  .strict();

export const TriggerSchema = z
  .object({
    ...ItemBase,
    triggerId: Id,
    type: z.enum([
      'PAGEVIEW',
      'DOM_READY',
      'WINDOW_LOADED',
      'CUSTOM_EVENT',
      'HISTORY_CHANGE',
      'CLICK',
      'LINK_CLICK',
      'FORM_SUBMISSION',
      'TIMER',
      'SCROLL_DEPTH',
      'ELEMENT_VISIBILITY',
      'JS_ERROR',
      'YOU_TUBE_VIDEO',
      'CONSENT_INIT',
      'INIT',
      'TRIGGER_GROUP',
    ]),
    customEventFilter: z.array(ConditionSchema).optional(),
    filter: z.array(ConditionSchema).optional(),
    autoEventFilter: z.array(ConditionSchema).optional(),
  })
  .strict();

export const VariableSchema = z
  .object({
    ...ItemBase,
    variableId: Id,
    type: z.string().min(1),
    parameter: z.array(ParameterSchema),
    formatValue: z.object({}).strict().optional(),
  })
  .strict();

export const BuiltInVariableSchema = z.object({ accountId: Id, containerId: Id, type: z.string().regex(/^[A-Z_]+$/), name: z.string().min(1) }).strict();

export const FolderSchema = z.object({ accountId: Id, containerId: Id, folderId: Id, name: z.string().min(1), fingerprint: Fingerprint }).strict();

export const CustomTemplateSchema = z
  .object({ accountId: Id, containerId: Id, templateId: Id, name: z.string().min(1), fingerprint: Fingerprint, templateData: z.string().min(1) })
  .strict();

export const GtmExportSchema = z
  .object({
    exportFormatVersion: z.literal(2),
    exportTime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    containerVersion: z
      .object({
        path: z.string(),
        accountId: Id,
        containerId: Id,
        containerVersionId: Id,
        container: z
          .object({
            path: z.string(),
            accountId: Id,
            containerId: Id,
            name: z.string(),
            publicId: z.string().regex(/^GTM-[A-Z0-9]+$/),
            usageContext: z.array(z.literal('WEB')).min(1),
            fingerprint: Fingerprint,
            tagManagerUrl: z.string().url(),
            tagIds: z.array(z.string()).optional(),
          })
          .strict(),
        tag: z.array(TagSchema),
        trigger: z.array(TriggerSchema),
        variable: z.array(VariableSchema),
        folder: z.array(FolderSchema).optional(),
        builtInVariable: z.array(BuiltInVariableSchema).optional(),
        customTemplate: z.array(CustomTemplateSchema).optional(),
        fingerprint: Fingerprint,
        tagManagerUrl: z.string().url(),
      })
      .strict(),
  })
  .strict();

export type GtmExportShape = z.infer<typeof GtmExportSchema>;

/** Built-in trigger ids that exports reference without defining them. */
export const BUILTIN_TRIGGER_IDS: Readonly<Record<string, string>> = {
  '2147479553': 'All Pages',
  '2147479572': 'Consent Initialization - All Pages',
  '2147479573': 'Initialization - All Pages',
};

/** Built-in variable names that are always available ({{_event}} is internal to custom-event filters). */
const ALWAYS_AVAILABLE_VARIABLES = new Set(['_event']);

const BUILTIN_TAG_TYPES = new Set(['html', 'awct', 'gclidw', 'googtag', 'sp', 'img', 'gaawe', 'flc', 'fls', 'baut', 'bzi', 'cegg', 'crto', 'hjtc', 'pntr', 'twitter_website_tag']);
const BUILTIN_VARIABLE_TYPES = new Set(['v', 'jsm', 'awec', 'c', 'k', 'u', 'f', 'e', 'smm', 'remm', 'd', 'j', 'aev', 'gtes', 'r', 'uv', 'cid', 'ctv', 'dbg', 'vis']);

function collectReferences(params: GtmParameterShape[] | undefined, out: Set<string>): void {
  for (const p of params ?? []) {
    for (const m of (p.value ?? '').matchAll(/\{\{([^}]+)\}\}/g)) out.add(m[1]!);
    collectReferences(p.list, out);
    collectReferences(p.map, out);
  }
}

function param(params: GtmParameterShape[], key: string): string | undefined {
  return params.find((p) => p.key === key)?.value;
}

/** Substitute {{Variable}} references with a JS literal so the code can be parsed. */
export function neutraliseReferences(code: string): string {
  return code.replace(/\{\{[^}]+\}\}/g, 'null');
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Schema + referential integrity + code checks. Returns [] when the export is valid. */
export function validateGtmExport(input: unknown, opts: { requirePrefix?: string } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parsed = GtmExportSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push({ path: i.path.join('.'), message: i.message });
    return issues;
  }
  const cv = parsed.data.containerVersion;
  const { accountId, containerId } = cv;

  const allItems: Array<{ path: string; accountId: string; containerId: string }> = [
    { ...cv.container, path: 'container' },
    ...cv.tag.map((x, i) => ({ path: `tag[${i}]`, ...x })),
    ...cv.trigger.map((x, i) => ({ path: `trigger[${i}]`, ...x })),
    ...cv.variable.map((x, i) => ({ path: `variable[${i}]`, ...x })),
    ...(cv.builtInVariable ?? []).map((x, i) => ({ path: `builtInVariable[${i}]`, ...x })),
    ...(cv.folder ?? []).map((x, i) => ({ path: `folder[${i}]`, ...x })),
    ...(cv.customTemplate ?? []).map((x, i) => ({ path: `customTemplate[${i}]`, ...x })),
  ];
  for (const item of allItems) {
    if (item.accountId !== accountId || item.containerId !== containerId) issues.push({ path: item.path, message: 'accountId/containerId differ from containerVersion' });
  }

  const uniq = (label: string, values: string[]): void => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) issues.push({ path: label, message: `duplicate ${label}: ${v}` });
      seen.add(v);
    }
  };
  uniq('tagId', cv.tag.map((x) => x.tagId));
  uniq('tag name', cv.tag.map((x) => x.name));
  uniq('triggerId', cv.trigger.map((x) => x.triggerId));
  uniq('trigger name', cv.trigger.map((x) => x.name));
  uniq('variableId', cv.variable.map((x) => x.variableId));
  uniq('variable name', cv.variable.map((x) => x.name));

  if (opts.requirePrefix) {
    for (const [label, list] of [
      ['tag', cv.tag],
      ['trigger', cv.trigger],
      ['variable', cv.variable],
    ] as const) {
      for (const item of list) if (!item.name.startsWith(opts.requirePrefix)) issues.push({ path: label, message: `name without ${opts.requirePrefix} prefix: ${item.name}` });
    }
  }

  const folderIds = new Set((cv.folder ?? []).map((f) => f.folderId));
  for (const item of [...cv.tag, ...cv.trigger, ...cv.variable]) {
    if (item.parentFolderId && !folderIds.has(item.parentFolderId)) issues.push({ path: item.name, message: `unknown folder ${item.parentFolderId}` });
  }

  const triggerIds = new Set([...cv.trigger.map((x) => x.triggerId), ...Object.keys(BUILTIN_TRIGGER_IDS)]);
  const variableNames = new Set([...cv.variable.map((v) => v.name), ...(cv.builtInVariable ?? []).map((v) => v.name), ...ALWAYS_AVAILABLE_VARIABLES]);
  const templateTypes = new Set((cv.customTemplate ?? []).map((ct) => `cvt_${containerId}_${ct.templateId}`));

  for (const tag of cv.tag) {
    for (const id of [...tag.firingTriggerId, ...(tag.blockingTriggerId ?? [])]) {
      if (!triggerIds.has(id)) issues.push({ path: tag.name, message: `unknown trigger id ${id}` });
    }
    if (!BUILTIN_TAG_TYPES.has(tag.type) && !templateTypes.has(tag.type)) issues.push({ path: tag.name, message: `unknown tag type ${tag.type}` });
    const refs = new Set<string>();
    collectReferences(tag.parameter, refs);
    for (const r of refs) if (!variableNames.has(r)) issues.push({ path: tag.name, message: `unresolved variable {{${r}}}` });

    if (tag.type === 'html') {
      const html = param(tag.parameter, 'html');
      if (!html) issues.push({ path: tag.name, message: 'html tag without html' });
      for (const body of scriptBodies(html ?? '')) {
        for (const v of findEs5Violations(neutraliseReferences(body))) issues.push({ path: tag.name, message: `not ES5: ${v.kind} (${v.text})` });
      }
    }
    if (tag.type === 'awct') {
      if (!/^\d+$/.test(param(tag.parameter, 'conversionId') ?? '')) issues.push({ path: tag.name, message: 'awct without numeric conversionId' });
      if (!param(tag.parameter, 'conversionLabel')) issues.push({ path: tag.name, message: 'awct without conversionLabel' });
      if (param(tag.parameter, 'enableEnhancedConversion') === 'true' && !param(tag.parameter, 'cssProvidedEnhancedConversionValue')) {
        issues.push({ path: tag.name, message: 'enhanced conversions on without a user-provided data variable' });
      }
    }
  }

  for (const trigger of cv.trigger) {
    const refs = new Set<string>();
    for (const c of [...(trigger.customEventFilter ?? []), ...(trigger.filter ?? []), ...(trigger.autoEventFilter ?? [])]) collectReferences(c.parameter, refs);
    for (const r of refs) if (!variableNames.has(r)) issues.push({ path: trigger.name, message: `unresolved variable {{${r}}}` });
    if (trigger.type === 'CUSTOM_EVENT') {
      const f = trigger.customEventFilter?.[0];
      if (!f || f.type !== 'EQUALS' || param(f.parameter, 'arg0') !== '{{_event}}' || !param(f.parameter, 'arg1')) {
        issues.push({ path: trigger.name, message: 'CUSTOM_EVENT needs customEventFilter EQUALS {{_event}} <name>' });
      }
    }
    for (const c of trigger.filter ?? []) {
      if (c.type === 'MATCH_REGEX') {
        try {
          new RegExp(param(c.parameter, 'arg1') ?? '');
        } catch {
          issues.push({ path: trigger.name, message: 'invalid regex in filter' });
        }
      }
    }
  }

  for (const v of cv.variable) {
    if (!BUILTIN_VARIABLE_TYPES.has(v.type)) issues.push({ path: v.name, message: `unknown variable type ${v.type}` });
    const refs = new Set<string>();
    collectReferences(v.parameter, refs);
    for (const r of refs) {
      if (r === v.name) issues.push({ path: v.name, message: 'variable references itself' });
      else if (!variableNames.has(r)) issues.push({ path: v.name, message: `unresolved variable {{${r}}}` });
    }
    if (v.type === 'jsm') {
      const js = param(v.parameter, 'javascript') ?? '';
      if (!/^\s*function\s*\(\s*\)\s*\{[\s\S]*\}\s*$/.test(js)) issues.push({ path: v.name, message: 'Custom JavaScript must be a single function() { … }' });
      for (const x of findEs5Violations(`(${neutraliseReferences(js)})`)) issues.push({ path: v.name, message: `not ES5: ${x.kind} (${x.text})` });
    }
    if (v.type === 'awec' && param(v.parameter, 'mode') === 'MANUAL' && !param(v.parameter, 'email') && !param(v.parameter, 'phone_number')) {
      issues.push({ path: v.name, message: 'manual user-provided data without email/phone' });
    }
    if (v.type === 'v' && !param(v.parameter, 'name')) issues.push({ path: v.name, message: 'data layer variable without name' });
  }

  for (const ct of cv.customTemplate ?? []) {
    for (const section of ['___INFO___', '___TEMPLATE_PARAMETERS___', '___SANDBOXED_JS_FOR_WEB_TEMPLATE___', '___WEB_PERMISSIONS___']) {
      if (!ct.templateData.includes(section)) issues.push({ path: ct.name, message: `template missing ${section}` });
    }
  }
  return issues;
}
