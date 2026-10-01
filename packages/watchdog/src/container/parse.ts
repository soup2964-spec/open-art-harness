// Compiled GTM containers and Google tag configs embed their configuration as
//   var data = { "resource": {...}, "runtime": [...], "blob": {...}, ... };
// (research/02 §2, research/11 §7). The embedded object is valid JSON. blob["5"] is the container /
// tag id (GTM-56CMP8K for the container, AW-11252321380 for the Google tag config) and
// blob["30"]/["31"] are the visitor country/region Google (or the gateway) resolved for this load.
import { createHash } from 'node:crypto';

export interface ParsedContainer {
  data: any;
  resource: any;
  containerId: string | null;
  version: string | null;
  geo: { country: string | null; region: string | null };
  resourceSha256: string;
  start: number;
  end: number;
}

const MARK = 'var data = {';

/** Returns the JSON text of the embedded data object, or null. String/escape aware brace matcher. */
export function extractDataBlock(src: string): string | null {
  const range = dataRange(src);
  return range ? src.slice(range[0], range[1]) : null;
}

function dataRange(src: string): [number, number] | null {
  const i = src.indexOf(MARK);
  if (i < 0) return null;
  const start = i + MARK.length - 1;
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return [start, k + 1];
    }
  }
  return null;
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function resourceHash(resource: unknown): string {
  return createHash('sha256').update(canonicalJson(resource)).digest('hex');
}

export function parseContainerScript(src: string): ParsedContainer | null {
  const range = dataRange(src);
  if (!range) return null;
  let data: any;
  try {
    data = JSON.parse(src.slice(range[0], range[1]));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !data.resource) return null;
  const blob = data.blob || {};
  return {
    data,
    resource: data.resource,
    containerId: typeof blob['5'] === 'string' ? blob['5'] : null,
    version: data.resource.version != null ? String(data.resource.version) : null,
    geo: { country: blob['30'] ?? null, region: blob['31'] ?? null },
    resourceSha256: resourceHash(data.resource),
    start: range[0],
    end: range[1],
  };
}

function replaceData(src: string, parsed: ParsedContainer, data: unknown): string {
  return src.slice(0, parsed.start) + JSON.stringify(data) + src.slice(parsed.end);
}

/**
 * Serve `patch` in place of the live configuration while keeping the live runtime code.
 * `patch` may be a bare resource ({version, macros, tags, predicates, rules}) or a full data
 * object ({resource, runtime?, ...}); keys present in a full object replace the live ones.
 */
export function spliceResource(src: string, patch: any): string {
  const parsed = parseContainerScript(src);
  if (!parsed) throw new Error('no embedded container data block found');
  const next = { ...parsed.data };
  if (patch && typeof patch === 'object' && patch.resource) Object.assign(next, patch);
  else next.resource = patch;
  return replaceData(src, parsed, next);
}

export const EEA = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

/** Decode blob["22"]: base64 JSON {"0": country, "1": region, ..., "7": consent types}. */
export function decodeGeoBlob(src: string): Record<string, unknown> | null {
  const parsed = parseContainerScript(src);
  const v = parsed?.data?.blob?.['22'];
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Local-only geo simulation for the consent probes. The Google tag reads the visitor geo that
 * Google (or the gateway) resolved for this load from blob["22"] (base64 JSON; "0" country,
 * "1" region, other fields undocumented) — that is what region-scoped consent defaults are matched against
 * (Fk()/Gk() in the tag runtime) — and also embeds blob["30"]/["31"]. All are rewritten.
 */
export function rewriteGeo(src: string, country: string, region: string): string {
  const parsed = parseContainerScript(src);
  if (!parsed || !parsed.data.blob) return src;
  const blob = { ...parsed.data.blob, '30': country, '31': region };
  const geo = decodeGeoBlob(src);
  // Only country/region are rewritten; the other fields (e.g. "2") keep the served value because
  // their semantics are not documented (verified: region-scoped defaults match on "0"/"1").
  // Google serves this block as UNPADDED base64 and the tag's own decoder (tb) throws on '=', which
  // would silently empty the geo (the tag then applies every region's default) — so strip padding.
  if (geo) blob['22'] = Buffer.from(JSON.stringify({ ...geo, '0': country, '1': region }), 'utf8').toString('base64').replace(/=+$/, '');
  return replaceData(src, parsed, { ...parsed.data, blob });
}
