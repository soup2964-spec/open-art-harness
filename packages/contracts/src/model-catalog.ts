/**
 * Default-model arms, their ledger businessTypes, and the model-cost seed format.
 */

import { CAPABILITY_IDS_IN_CODE, OBSERVED_LEDGER_BUSINESS_TYPES } from './capability-ids.js';

export { CAPABILITY_IDS_IN_CODE, OBSERVED_LEDGER_BUSINESS_TYPES };

/**
 * Arm value (LaunchDarkly flag variation / Amplitude ab_* value) -> the capability id a
 * default generation with that arm is billed under. GPT Image 2.5's default variant is
 * "flare" (`variant … .default("flare")` in the Suite form), so its capability id is
 * gpt-image-2-5-flare:text2image. INFERRED except where noted in OBSERVED_LEDGER_BUSINESS_TYPES.
 */
export const ARM_BUSINESS_TYPE: Readonly<Record<string, string>> = {
  'nano-banana-pro': 'nano-banana-pro:text2image',
  'gpt-image-2-5': 'gpt-image-2-5-flare:text2image',
  'nano-banana-2': 'nano-banana-2:text2image',
  'gpt-image-2': 'gpt-image-2:text2image',
  'byte-plus-seedance-2': 'byte-plus-seedance-2:text2video',
  'byte-plus-seedance-2-5': 'byte-plus-seedance-2-5:text2video',
  'wan3-0': 'wan3-0:text2video',
};

/** Model id part of a capability id; GPT Image 2.5 variants collapse to the form model id. */
export function modelIdFromBusinessType(businessType: string): string {
  const model = businessType.split(':')[0] ?? businessType;
  return model.replace(/^gpt-image-2-5-(flare|sunburst)$/, 'gpt-image-2-5');
}

/** Creation mode part of a capability id (text2image, text2video, image2video, …). */
export function modeFromBusinessType(businessType: string): string {
  return businessType.split(':')[1] ?? '';
}

/** One row of fixtures/seeds/model_costs.csv. */
export interface ModelCostRow {
  model_id: string;
  business_type: string;
  setting: string;
  credits: number;
  /** Vendor list price in USD for one generation at this setting (null = no public price). */
  list_cost_usd: number | null;
  /** list_cost_usd / credits (null when list cost unknown). */
  cost_per_credit_usd: number | null;
  source_url: string;
  /** Starts with [bt:observed] | [bt:code] (businessType evidence), then free text. */
  notes: string;
}

export const MODEL_COST_COLUMNS = [
  'model_id',
  'business_type',
  'setting',
  'credits',
  'list_cost_usd',
  'cost_per_credit_usd',
  'source_url',
  'notes',
] as const;

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, commas/newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse model_costs.csv text into typed rows (throws on a header mismatch). */
export function parseModelCostsCsv(text: string): ModelCostRow[] {
  const [header, ...body] = parseCsv(text).filter((r) => r.length > 1 || (r[0] ?? '') !== '');
  if (!header || header.join(',') !== MODEL_COST_COLUMNS.join(',')) {
    throw new Error(`model_costs.csv header must be ${MODEL_COST_COLUMNS.join(',')}`);
  }
  return body.map((cells) => {
    const get = (i: number) => cells[i] ?? '';
    const num = (s: string) => (s === '' ? null : Number(s));
    return {
      model_id: get(0),
      business_type: get(1),
      setting: get(2),
      credits: Number(get(3)),
      list_cost_usd: num(get(4)),
      cost_per_credit_usd: num(get(5)),
      source_url: get(6),
      notes: get(7),
    };
  });
}
