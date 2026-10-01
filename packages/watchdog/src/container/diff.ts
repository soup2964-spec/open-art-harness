// Human-readable, index-independent view of a compiled GTM resource and a diff between two.
// Tags are keyed by tag_id (stable across versions); variables (macros) by their function and
// identifying parameter; triggers (rules) by their resolved condition, with rules that share a
// condition merged (GTM fires all of them). Macro/tag references are resolved, so inserting a
// macro or tag does not show up as spurious changes elsewhere.
import { canonicalJson } from './parse.js';

export interface TagView {
  key: string;
  tagId: number | string;
  function: string;
  summary: string;
  params: Record<string, unknown>;
  flags: Record<string, unknown>;
}
export interface TriggerView {
  key: string;
  fires: string[];
  blocks: string[];
}
export interface VariableView {
  key: string;
  function: string;
  params: Record<string, unknown>;
}
export interface NormalizedResource {
  version: string | null;
  tags: Map<string, TagView>;
  triggers: Map<string, TriggerView>;
  variables: Map<string, VariableView>;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}
export interface EntityDiff<T> {
  added: T[];
  removed: T[];
  changed: Array<{ key: string; summary?: string; changes: FieldChange[] }>;
}
export interface ResourceDiff {
  identical: boolean;
  versionBefore: string | null;
  versionAfter: string | null;
  tags: EntityDiff<TagView>;
  triggers: EntityDiff<TriggerView>;
  variables: EntityDiff<VariableView>;
}

/** Tag names from research/02 §2.1 so the diff reads like the GTM UI. */
export const KNOWN_TAGS: Record<string, string> = {
  '10': 'Conversion Linker',
  '15': 'Google Ads purchase AW-11252321380/OfGcCJisoLQZEOSYw_Up',
  '17': 'Google Ads signup AW-11252321380/rVk2CJ7Ot8EZEOSYw_Up',
  '19': 'Google Ads purchase AW-16854695811/4Rf-CM6EhJMcEIP_-OQ-',
  '20': 'Google tag AW-11252321380',
  '34': 'Reddit PageVisit',
  '35': 'Reddit Purchase',
  '52': 'LinkedIn Insight base',
  '57': 'Reddit SignUp',
  '58': 'LinkedIn purchase 29290225',
  '72': 'LinkedIn signup 29290241',
  '38': 'Microsoft UET base',
  '74': 'X base pixel',
  '75': 'X purchase tw-qwghh-13vj24',
  '76': 'X signup tw-qwghh-13vj22',
  '77': 'TikTok base',
  '78': 'TikTok Purchase (first_purchase)',
  '79': 'TikTok CompleteRegistration',
};

function macroSig(m: any): string {
  const fn = String(m?.function ?? '?');
  const id = m?.vtp_name ?? m?.vtp_component ?? m?.vtp_varType ?? m?.vtp_mode ?? (m?.vtp_value !== undefined ? JSON.stringify(m.vtp_value) : undefined);
  if (id !== undefined) return `${fn}(${id})`;
  if (m?.vtp_javascript) return `${fn}(js:${canonicalJson(m.vtp_javascript).length}b)`;
  return fn;
}

export function normalizeResource(resource: any, knownTags: Record<string, string> = KNOWN_TAGS): NormalizedResource {
  const macros: any[] = resource?.macros ?? [];
  const tags: any[] = resource?.tags ?? [];
  const preds: any[] = resource?.predicates ?? [];
  const rules: any[] = resource?.rules ?? [];

  const counts = new Map<string, number>();
  const macroKey = macros.map((m) => {
    const s = macroSig(m);
    const n = (counts.get(s) ?? 0) + 1;
    counts.set(s, n);
    return n === 1 ? s : `${s}#${n}`;
  });
  const tagKey = (i: number) => String(tags[i]?.tag_id ?? `index${i}`);

  const resolve = (v: any, depth = 0): unknown => {
    if (depth > 12) return '[deep]';
    if (Array.isArray(v)) {
      const head = v[0];
      if (head === 'macro' && typeof v[1] === 'number') return `{{${macroKey[v[1]] ?? 'macro' + v[1]}}}`;
      if (head === 'tag' && typeof v[1] === 'number') return `tag:${tagKey(v[1])}`;
      if (head === 'escape') return resolve(v[1], depth + 1);
      if (head === 'template') return v.slice(1).map((x) => (typeof x === 'string' ? x : String(resolve(x, depth + 1)))).join('');
      if (head === 'map') {
        const o: Record<string, unknown> = {};
        for (let i = 1; i + 1 < v.length; i += 2) o[String(resolve(v[i], depth + 1))] = resolve(v[i + 1], depth + 1);
        return o;
      }
      if (head === 'list') return v.slice(1).map((x) => resolve(x, depth + 1));
      return v.map((x) => resolve(x, depth + 1));
    }
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v)) o[k] = resolve(v[k], depth + 1);
      return o;
    }
    return v;
  };

  const variables = new Map<string, VariableView>();
  macros.forEach((m, i) => {
    const params: Record<string, unknown> = {};
    for (const k of Object.keys(m)) if (k !== 'function') params[k] = resolve(m[k]);
    variables.set(macroKey[i]!, { key: macroKey[i]!, function: String(m.function), params });
  });

  const tagViews = new Map<string, TagView>();
  tags.forEach((t, i) => {
    const params: Record<string, unknown> = {};
    const flags: Record<string, unknown> = {};
    for (const k of Object.keys(t)) {
      if (k === 'function' || k === 'tag_id') continue;
      if (k.startsWith('vtp_')) params[k] = resolve(t[k]);
      else flags[k] = resolve(t[k]);
    }
    const key = tagKey(i);
    tagViews.set(key, { key, tagId: t.tag_id ?? key, function: String(t.function), summary: `${t.function}${knownTags[key] ? ' — ' + knownTags[key] : ''}`, params, flags });
  });

  const predStr = (i: number) => {
    const p = preds[i] ?? {};
    const args = Object.keys(p).filter((k) => /^arg\d+$/.test(k)).sort().map((k) => JSON.stringify(resolve(p[k])).replace(/^"(\{\{.*\}\})"$/, '$1'));
    return `${p.function ?? '?'}(${args.join(', ')})${p.any ? '[any]' : ''}${p.ignore_case ? '[i]' : ''}${p.negate ? '[not]' : ''}`;
  };
  const triggers = new Map<string, TriggerView>();
  for (const rule of rules) {
    const ifs: string[] = [];
    const unless: string[] = [];
    const add: string[] = [];
    const block: string[] = [];
    for (const clause of rule as any[]) {
      const [kind, ...idx] = clause as [string, ...number[]];
      if (kind === 'if') ifs.push(...idx.map(predStr));
      else if (kind === 'unless') unless.push(...idx.map(predStr));
      else if (kind === 'add') add.push(...idx.map(tagKey));
      else if (kind === 'block') block.push(...idx.map(tagKey));
    }
    const key = ifs.sort().join(' && ') + (unless.length ? ' unless ' + unless.sort().join(' || ') : '');
    const prev = triggers.get(key);
    const fires = Array.from(new Set([...(prev?.fires ?? []), ...add])).sort();
    const blocks = Array.from(new Set([...(prev?.blocks ?? []), ...block])).sort();
    triggers.set(key, { key, fires, blocks });
  }
  return { version: resource?.version != null ? String(resource.version) : null, tags: tagViews, triggers, variables };
}

function diffMaps<T extends { key: string }>(a: Map<string, T>, b: Map<string, T>, fields: (x: T) => Record<string, unknown>, summary?: (x: T) => string): EntityDiff<T> {
  const out: EntityDiff<T> = { added: [], removed: [], changed: [] };
  for (const [k, v] of b) if (!a.has(k)) out.added.push(v);
  for (const [k, v] of a) if (!b.has(k)) out.removed.push(v);
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) continue;
    const fa = fields(va);
    const fb = fields(vb);
    const changes: FieldChange[] = [];
    for (const f of Array.from(new Set([...Object.keys(fa), ...Object.keys(fb)])).sort()) {
      if (canonicalJson(fa[f]) !== canonicalJson(fb[f])) changes.push({ field: f, before: fa[f], after: fb[f] });
    }
    if (changes.length) out.changed.push({ key: k, summary: summary?.(vb), changes });
  }
  return out;
}

/** knownTags: human labels for GTM-56CMP8K v25 tag ids; pass {} for other resources (e.g. the gtag config). */
export function diffResources(before: any, after: any, knownTags: Record<string, string> = KNOWN_TAGS): ResourceDiff {
  const a = normalizeResource(before, knownTags);
  const b = normalizeResource(after, knownTags);
  const tags = diffMaps(a.tags, b.tags, (t) => ({ function: t.function, ...t.params, ...t.flags }), (t) => t.summary);
  const triggers = diffMaps(a.triggers, b.triggers, (t) => ({ fires: t.fires, blocks: t.blocks }));
  const variables = diffMaps(a.variables, b.variables, (v) => ({ function: v.function, ...v.params }));
  const identical = canonicalJson(before) === canonicalJson(after);
  return { identical, versionBefore: a.version, versionAfter: b.version, tags, triggers, variables };
}

export function diffSummaryLines(d: ResourceDiff): string[] {
  const lines: string[] = [];
  if (d.identical) return ['identical to baseline'];
  if (d.versionBefore !== d.versionAfter) lines.push(`version ${d.versionBefore} → ${d.versionAfter}`);
  for (const [name, e] of [['tag', d.tags], ['trigger', d.triggers], ['variable', d.variables]] as const) {
    for (const x of e.added as Array<{ key: string }>) lines.push(`+ ${name} ${x.key}`);
    for (const x of e.removed as Array<{ key: string }>) lines.push(`- ${name} ${x.key}`);
    for (const x of e.changed) lines.push(`~ ${name} ${x.key}${x.summary ? ' (' + x.summary + ')' : ''}: ${x.changes.map((c) => c.field).join(', ')}`);
  }
  return lines;
}
