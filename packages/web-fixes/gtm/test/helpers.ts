/**
 * Test helpers that mimic what GTM does with {{Variable}} references, and a small evaluator for
 * compiled resources (macros / predicates / rules) to check which tags fire for an event.
 */
import type { GtmResource } from '../src/patch-container';

/**
 * Render an export-form code body the way GTM renders a bare {{Variable}} inside script code
 * (escape modes 8+16: the value is passed as a JS value, not as text).
 */
export function renderRefs(code: string, values: Record<string, unknown>): string {
  return code.replace(/\{\{([^}]+)\}\}/g, (_m, name: string) => {
    if (!(name in values)) throw new Error(`test did not provide {{${name}}}`);
    const v = values[name];
    return v === undefined ? 'undefined' : JSON.stringify(v);
  });
}

/** Evaluate a Custom JavaScript variable body `function() {…}` with the given variable values. */
export function evalCustomJs(body: string, values: Record<string, unknown>): unknown {
  return new Function(`return (${renderRefs(body, values)})();`)();
}

export interface EvalContext {
  event: string;
  /** GTM data model (dataLayer merged state), dotted keys resolved like __v v2. */
  data?: Record<string, unknown>;
  cookies?: Record<string, string>;
}

function lookup(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evalMacro(resource: GtmResource, index: number, ctx: EvalContext): unknown {
  const m = resource.macros[index];
  if (!m) throw new Error(`macro ${index} out of range`);
  switch (m.function) {
    case '__e':
      return ctx.event;
    case '__v':
      return lookup(ctx.data ?? {}, String(m.vtp_name));
    case '__k':
      return ctx.cookies?.[String(m.vtp_name)];
    case '__jsm': {
      const js = renderTemplate(resource, m.vtp_javascript, ctx);
      return new Function(`return ${js}`)();
    }
    case '__awec':
      return m.vtp_mode === 'MANUAL' ? { email: evalArg(resource, m.vtp_email, ctx) } : undefined;
    default:
      return undefined;
  }
}

export function evalArg(resource: GtmResource, arg: unknown, ctx: EvalContext): unknown {
  if (Array.isArray(arg) && arg[0] === 'macro') return evalMacro(resource, arg[1] as number, ctx);
  if (Array.isArray(arg) && arg[0] === 'template') return renderTemplate(resource, arg, ctx);
  return arg;
}

/** Expand a compiled template; escape 8+16 parts become JS literals of the macro value. */
export function renderTemplate(resource: GtmResource, template: unknown, ctx: EvalContext): string {
  if (typeof template === 'string') return template;
  if (!Array.isArray(template) || template[0] !== 'template') throw new Error('not a template');
  return template
    .slice(1)
    .map((part) => {
      if (typeof part === 'string') return part;
      if (Array.isArray(part) && part[0] === 'escape') {
        const v = evalArg(resource, part[1], ctx);
        return v === undefined ? 'undefined' : JSON.stringify(v);
      }
      throw new Error(`unsupported template part ${JSON.stringify(part)}`);
    })
    .join('');
}

function predicateHolds(resource: GtmResource, index: number, ctx: EvalContext): boolean {
  const p = resource.predicates[index];
  if (!p) throw new Error(`predicate ${index} out of range`);
  const a = evalArg(resource, p.arg0, ctx);
  const b = p.arg1 as string;
  switch (p.function) {
    case '_eq':
      return String(a) === String(b);
    case '_re':
      return new RegExp(b, p.ignore_case ? 'i' : '').test(String(a));
    case '_cn':
      return String(a).includes(String(b));
    case '_sw':
      return String(a).startsWith(String(b));
    default:
      throw new Error(`unsupported predicate ${p.function}`);
  }
}

/** Indices of the tags GTM would fire for this event (rules: all `if` true, no `unless` true). */
export function firedTagIndices(resource: GtmResource, ctx: EvalContext): number[] {
  const fired = new Set<number>();
  for (const rule of resource.rules) {
    const ifs = rule.filter((c) => c[0] === 'if').flatMap((c) => c.slice(1) as number[]);
    const unless = rule.filter((c) => c[0] === 'unless').flatMap((c) => c.slice(1) as number[]);
    if (!ifs.every((i) => predicateHolds(resource, i, ctx))) continue;
    if (unless.some((i) => predicateHolds(resource, i, ctx))) continue;
    for (const clause of rule) if (clause[0] === 'add') for (const t of clause.slice(1) as number[]) fired.add(t);
  }
  return [...fired].sort((x, y) => x - y);
}

export function firedTagIds(resource: GtmResource, ctx: EvalContext): number[] {
  return firedTagIndices(resource, ctx)
    .map((i) => resource.tags[i]!.tag_id)
    .sort((x, y) => x - y);
}
