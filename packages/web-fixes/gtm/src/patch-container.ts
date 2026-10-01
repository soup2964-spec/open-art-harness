/**
 * Applies the fix pack to the compiled `resource` of GTM-56CMP8K v25 (macros / tags / predicates /
 * rules), producing gtm/proof/patched_resource.json for the sealed replay.
 *
 * It uses only function types whose runtime code is already inside the v25 container
 * (__v, __e, __u, __jsm, __awec, __html, __awct, __cvt_PBGZL, __cvt_TB7ZX), so the patched
 * resource runs on the original runtime unchanged: splice it back with
 * spliceResourceIntoContainerJs(). Two parts of the fix pack need runtime code v25 does not ship
 * and are therefore not in the proof (they are in the import file):
 *  - the Consent Mode template (sandboxed template)  -> proof injects consent/dist/…defaults.min.js
 *  - the History Change trigger listener (__hl)        -> proof pushes virtual_page_view directly
 *
 * What the proof represents: the state after the import + CHANGES.md manual steps. Replaced
 * originals are "paused" (removed from every rule); gallery-template edits are applied in place.
 */
import {
  BUILTIN_TRIGGERS,
  BUILTIN_TRIGGER_SWAPS,
  FIX_ID_BASE,
  GALLERY_EDITS,
  TAGS,
  TRIGGERS,
  VARIABLES,
  type AwctTagDef,
  type Condition,
  type HtmlTagDef,
  type ProofVariant,
  type Replaces,
  type TagDef,
  type VariableDef,
} from './fixpack';

export type Macro = Record<string, unknown> & { function: string };
export type CompiledTag = Record<string, unknown> & { function: string; tag_id: number };
export type Predicate = Record<string, unknown> & { function: string };
export type RuleClause = [string, ...number[]];
export type Rule = RuleClause[];

export interface GtmResource {
  version: string;
  macros: Macro[];
  tags: CompiledTag[];
  predicates: Predicate[];
  rules: Rule[];
  [key: string]: unknown;
}

export interface PatchReport {
  addedMacros: Array<{ index: number; for: string }>;
  reusedMacros: Array<{ index: number; for: string }>;
  addedPredicates: number[];
  addedTags: Array<{ index: number; tag_id: number; name: string }>;
  paused: Array<{ index: number; tag_id: number; what: string; replacedBy: string }>;
  edited: Array<{ index: number; tag_id: number; what: string; changes: string[] }>;
  skippedNotInProof: string[];
  addedRules: number;
  droppedEmptyRules: number;
}

/** Compiled tag_id of new tags = the export tagId (FIX_ID_BASE + position in TAGS + 1). */
export const NEW_TAG_ID_BASE = FIX_ID_BASE;
const REF_OPEN = '\u0000REF:';
const REF_CLOSE = '\u0000';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertResource(resource: unknown): asserts resource is GtmResource {
  const r = resource as Partial<GtmResource>;
  if (!r || !Array.isArray(r.macros) || !Array.isArray(r.tags) || !Array.isArray(r.predicates) || !Array.isArray(r.rules)) {
    throw new Error('not a compiled GTM resource (expected macros/tags/predicates/rules arrays)');
  }
}

export interface PatchOptions {
  /** Compile an optional variant instead of the default (e.g. LinkedIn purchase via lintrk with value). */
  variant?: ProofVariant;
}

export function patchContainerResource(input: unknown, opts: PatchOptions = {}): { resource: GtmResource; report: PatchReport } {
  assertResource(input);
  if (input.tags.some((t) => typeof t.tag_id === 'number' && t.tag_id > NEW_TAG_ID_BASE)) {
    throw new Error('resource already contains fix-pack tags (tag_id > 1000): patch the original container');
  }
  const resource = clone(input);
  const report: PatchReport = {
    addedMacros: [],
    reusedMacros: [],
    addedPredicates: [],
    addedTags: [],
    paused: [],
    edited: [],
    skippedNotInProof: [],
    addedRules: 0,
    droppedEmptyRules: 0,
  };

  /* ---------- locate originals (fail loudly if the container changed) ---------- */
  function findTag(tagId: number, fn: string, guard: [string, string], what: string): number {
    const index = resource.tags.findIndex((t) => t.tag_id === tagId);
    if (index < 0) throw new Error(`tag_id ${tagId} (${what}) not found: container changed, review the fix pack`);
    const tag = resource.tags[index]!;
    if (tag.function !== fn) throw new Error(`tag_id ${tagId} is ${tag.function}, expected ${fn} (${what})`);
    const [field, expected] = guard;
    const actual = JSON.stringify(tag[field] ?? '');
    if (!actual.includes(expected.replace(/"/g, '\\"')) && !actual.includes(expected)) {
      throw new Error(`tag_id ${tagId} ${field} does not contain ${expected} (${what})`);
    }
    return index;
  }

  /* ---------- macros ---------- */
  const macroIndexByCanonical = new Map<string, number>();
  resource.macros.forEach((m, i) => {
    const key = canonical(m);
    if (!macroIndexByCanonical.has(key)) macroIndexByCanonical.set(key, i);
  });
  function internMacro(macro: Macro, label: string): number {
    const key = canonical(macro);
    const existing = macroIndexByCanonical.get(key);
    if (existing !== undefined) {
      report.reusedMacros.push({ index: existing, for: label });
      return existing;
    }
    resource.macros.push(macro);
    const index = resource.macros.length - 1;
    macroIndexByCanonical.set(key, index);
    report.addedMacros.push({ index, for: label });
    return index;
  }

  const variableDefs = new Map<string, VariableDef>(VARIABLES.map((v) => [v.name, v]));
  const variableMacro = new Map<string, number>();
  const placeholder = (name: string): string => `${REF_OPEN}${name}${REF_CLOSE}`;

  function toTemplate(text: string): string | unknown[] {
    if (!text.includes(REF_OPEN)) return text;
    const parts: unknown[] = ['template'];
    let rest = text;
    while (rest.length) {
      const at = rest.indexOf(REF_OPEN);
      if (at < 0) {
        parts.push(rest);
        break;
      }
      if (at > 0) parts.push(rest.slice(0, at));
      const close = rest.indexOf(REF_CLOSE, at + REF_OPEN.length);
      const name = rest.slice(at + REF_OPEN.length, close);
      // Bare {{Variable}} in script code compiles to escape modes 8+16 (value passed by reference).
      parts.push(['escape', ['macro', macroFor(name)], 8, 16]);
      rest = rest.slice(close + REF_CLOSE.length);
    }
    return parts;
  }

  function macroFor(name: string): number {
    const cached = variableMacro.get(name);
    if (cached !== undefined) return cached;
    let index: number;
    if (name === 'Event') {
      index = internMacro({ function: '__e' }, name);
    } else {
      const def = variableDefs.get(name);
      if (!def) throw new Error(`unknown variable ${name}`);
      if (def.kind === 'dlv') {
        index = internMacro({ function: '__v', vtp_dataLayerVersion: 2, vtp_setDefaultValue: false, vtp_name: def.key }, name);
      } else if (def.kind === 'cookie') {
        index = internMacro({ function: '__k', vtp_decodeCookie: def.decode, vtp_name: def.cookie }, name);
      } else if (def.kind === 'jsm') {
        index = internMacro({ function: '__jsm', vtp_javascript: toTemplate(`(${def.body(placeholder)})();`) }, name);
      } else {
        index = internMacro({ function: '__awec', vtp_mode: 'MANUAL', vtp_email: ['macro', macroFor(def.emailVariable)] }, name);
      }
    }
    variableMacro.set(name, index);
    return index;
  }

  /* ---------- predicates & rules ---------- */
  const predicateIndexByCanonical = new Map<string, number>();
  resource.predicates.forEach((p, i) => predicateIndexByCanonical.set(canonical(p), i));
  function internPredicate(p: Predicate): number {
    const key = canonical(p);
    const existing = predicateIndexByCanonical.get(key);
    if (existing !== undefined) return existing;
    resource.predicates.push(p);
    const index = resource.predicates.length - 1;
    predicateIndexByCanonical.set(key, index);
    report.addedPredicates.push(index);
    return index;
  }
  const eventMacro = macroFor('Event');
  const eventPredicate = (event: string): number => internPredicate({ function: '_eq', arg0: ['macro', eventMacro], arg1: event });
  const conditionPredicate = (c: Condition): number => internPredicate({ function: '_re', arg0: ['macro', macroFor(c.variable)], arg1: c.value });

  /** Rule index per trigger name (one rule per trigger, like GTM compiles them). */
  const ruleForTrigger = new Map<string, number>();
  const gtmJsPredicate = eventPredicate(BUILTIN_TRIGGERS.allPages.event);
  const allPagesRule = resource.rules.findIndex((r) => r.length === 2 && r[0]![0] === 'if' && r[0]!.length === 2 && r[0]![1] === gtmJsPredicate);
  if (allPagesRule < 0) throw new Error('All Pages (gtm.js) rule not found');
  ruleForTrigger.set(BUILTIN_TRIGGERS.allPages.name, allPagesRule);

  function ruleFor(triggerName: string): number {
    const existing = ruleForTrigger.get(triggerName);
    if (existing !== undefined) return existing;
    const def = TRIGGERS.find((t) => t.name === triggerName);
    if (!def) throw new Error(`unknown trigger ${triggerName}`);
    if (def.kind !== 'customEvent') throw new Error(`trigger ${triggerName} cannot be compiled on the v25 runtime`);
    const conditions = [eventPredicate(def.event), ...def.filters.map(conditionPredicate)];
    resource.rules.push([['if', ...conditions], ['add']]);
    report.addedRules += 1;
    const index = resource.rules.length - 1;
    ruleForTrigger.set(triggerName, index);
    return index;
  }

  function addToRule(ruleIndex: number, tagIndex: number): void {
    const rule = resource.rules[ruleIndex]!;
    let add = rule.find((c) => c[0] === 'add');
    if (!add) {
      add = ['add'];
      rule.push(add);
    }
    if (!add.slice(1).includes(tagIndex)) add.push(tagIndex);
  }

  function removeFromAllRules(tagIndex: number): number {
    let removed = 0;
    for (const rule of resource.rules) {
      for (const clause of rule) {
        if (clause[0] !== 'add') continue;
        const before = clause.length;
        const kept = clause.slice(1).filter((i) => i !== tagIndex) as number[];
        clause.length = 1;
        clause.push(...kept);
        removed += before - clause.length;
      }
    }
    return removed;
  }

  function removeFromEventRules(tagIndex: number, event: string): void {
    const p = eventPredicate(event);
    for (const rule of resource.rules) {
      const cond = rule.find((c) => c[0] === 'if');
      if (!cond || cond.length !== 2 || cond[1] !== p) continue;
      const add = rule.find((c) => c[0] === 'add');
      if (!add) continue;
      const kept = add.slice(1).filter((i) => i !== tagIndex) as number[];
      add.length = 1;
      add.push(...kept);
    }
  }

  /* ---------- new tags ---------- */
  const urlMacro = (() => {
    const original = resource.tags.find((t) => t.tag_id === 15);
    const ref = original?.vtp_url as unknown[] | undefined;
    if (!Array.isArray(ref) || ref[0] !== 'macro') throw new Error('cannot find the page URL macro used by the Google Ads tags');
    return ref;
  })();

  function compileHtml(def: HtmlTagDef): string | unknown[] {
    const html = def.html(placeholder).replace(/<script>/g, '<script type="text/gtmscript">');
    return toTemplate(html);
  }

  function compileAwct(def: AwctTagDef, tagId: number): CompiledTag {
    const tag: CompiledTag = {
      function: '__awct',
      metadata: ['map'],
      once_per_event: true,
      vtp_enableNewCustomerReporting: false,
      vtp_enableConversionLinker: true,
      tag_id: tagId,
    };
    if (def.orderIdVariable) tag.vtp_orderId = ['macro', macroFor(def.orderIdVariable)];
    tag.vtp_enableProductReporting = false;
    if (def.valueVariable) tag.vtp_conversionValue = ['macro', macroFor(def.valueVariable)];
    tag.vtp_enableEnhancedConversion = !!def.updVariable;
    if (def.updVariable) tag.vtp_cssProvidedEnhancedConversionValue = ['macro', macroFor(def.updVariable)];
    tag.vtp_conversionCookiePrefix = '_gcl';
    tag.vtp_enableShippingData = false;
    tag.vtp_conversionId = def.conversionId;
    if (def.currencyVariable) tag.vtp_currencyCode = ['macro', macroFor(def.currencyVariable)];
    tag.vtp_conversionLabel = def.conversionLabel;
    tag.vtp_rdp = false;
    tag.vtp_url = urlMacro;
    tag.vtp_enableProductReportingCheckbox = true;
    tag.vtp_enableNewCustomerReportingCheckbox = true;
    tag.vtp_enableEnhancedConversionsCheckbox = !!def.updVariable;
    tag.vtp_enableRdpCheckbox = true;
    tag.vtp_enableTransportUrl = false;
    tag.vtp_enableCustomParams = false;
    tag.vtp_enableEventParameters = true;
    return tag;
  }

  function compileTag(def: TagDef, tagId: number): CompiledTag {
    if (def.kind === 'awct') return compileAwct(def, tagId);
    if (def.kind === 'html') {
      const tag: CompiledTag = { function: '__html', metadata: ['map'], tag_id: tagId };
      if (def.firing === 'ONCE_PER_EVENT') tag.once_per_event = true;
      tag.vtp_html = compileHtml(def);
      tag.vtp_supportDocumentWrite = false;
      tag.vtp_enableIframeMode = false;
      tag.vtp_enableEditJsMacroBehavior = false;
      return tag;
    }
    throw new Error(`${def.name} cannot be compiled on the v25 runtime`);
  }

  const pausedOriginals: Array<{ index: number; replaces: Replaces; by: string }> = [];
  const replacedByActiveVariant = new Set<number>();
  TAGS.forEach((def, i) => {
    const active = def.variant ? opts.variant === def.variant : def.inProof;
    if (!active) {
      report.skippedNotInProof.push(def.name);
      return;
    }
    if (def.replaces) {
      const index = findTag(def.replaces.tagId, def.replaces.function, def.replaces.guard, def.replaces.what);
      pausedOriginals.push({ index, replaces: def.replaces, by: def.name });
      if (def.variant) replacedByActiveVariant.add(def.replaces.tagId);
    }
    const tagId = NEW_TAG_ID_BASE + i + 1;
    resource.tags.push(compileTag(def, tagId));
    const index = resource.tags.length - 1;
    report.addedTags.push({ index, tag_id: tagId, name: def.name });
    for (const trigger of def.triggers) addToRule(ruleFor(trigger), index);
  });

  for (const p of pausedOriginals) {
    removeFromAllRules(p.index);
    report.paused.push({ index: p.index, tag_id: p.replaces.tagId, what: p.replaces.what, replacedBy: p.by });
  }

  /* ---------- gallery-template edits and trigger swaps ---------- */
  for (const edit of GALLERY_EDITS) {
    if (replacedByActiveVariant.has(edit.tagId)) continue; // the variant tag replaces this template tag
    const index = findTag(edit.tagId, edit.function, edit.guard, edit.what);
    const tag = resource.tags[index]!;
    const changes: string[] = [];
    for (const [field, value] of Object.entries(edit.fields ?? {})) {
      const ref = /^\{\{(.+)\}\}$/.exec(value);
      tag[`vtp_${field}`] = ref ? ['macro', macroFor(ref[1]!)] : value;
      changes.push(`${field} = ${value}`);
    }
    if (edit.firing === 'ONCE_PER_EVENT') {
      delete tag.once_per_load;
      tag.once_per_event = true;
      changes.push('firing: once per event');
    }
    for (const trigger of edit.addTriggers ?? []) {
      addToRule(ruleFor(trigger), index);
      changes.push(`+trigger ${trigger}`);
    }
    if (edit.replaceTrigger) {
      removeFromEventRules(index, edit.replaceTrigger.from);
      addToRule(ruleFor(edit.replaceTrigger.to), index);
      changes.push(`trigger ${edit.replaceTrigger.from} -> ${edit.replaceTrigger.to}`);
    }
    report.edited.push({ index, tag_id: edit.tagId, what: `${edit.template}: ${edit.what}`, changes });
  }
  for (const swap of BUILTIN_TRIGGER_SWAPS) {
    const index = findTag(swap.tagId, swap.function, swap.guard, swap.what);
    removeFromEventRules(index, swap.from);
    addToRule(ruleFor(swap.to), index);
    report.edited.push({ index, tag_id: swap.tagId, what: swap.what, changes: [`trigger ${swap.from} -> ${swap.to}`] });
  }

  /* ---------- drop rules left without tags ---------- */
  const before = resource.rules.length;
  resource.rules = resource.rules.filter((rule) => rule.some((c) => (c[0] === 'add' || c[0] === 'block') && c.length > 1));
  report.droppedEmptyRules = before - resource.rules.length;

  return { resource, report };
}
