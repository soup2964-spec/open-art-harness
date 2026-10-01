/**
 * Node-only: loads every JSON Schema (canonical contracts in src/schemas/,
 * OpenArt source shapes in src/sources/) into one Ajv 2020-12 instance.
 *
 *   import { validateWithSchema, CANONICAL_SCHEMA_IDS } from '@openart-signal/contracts/schema-registry';
 *   const { valid, errors } = validateWithSchema(CANONICAL_SCHEMA_IDS.conversionLedgerEvent, row);
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const BASE = 'https://openart-signal.example';

export const CANONICAL_SCHEMA_IDS = {
  common: `${BASE}/schemas/common.schema.json`,
  conversionLedgerEvent: `${BASE}/schemas/conversion-ledger-event.schema.json`,
  clickIdStoreRecord: `${BASE}/schemas/click-id-store-record.schema.json`,
  clickIdStoreRecordExtended: `${BASE}/schemas/click-id-store-record-extended.schema.json`,
  predictedProfit: `${BASE}/schemas/predicted-profit.schema.json`,
  purchaseValueScore: `${BASE}/schemas/purchase-value-score.schema.json`,
  experimentExposure: `${BASE}/schemas/experiment-exposure.schema.json`,
  audienceMember: `${BASE}/schemas/audience-member.schema.json`,
  platformEventMapping: `${BASE}/schemas/platform-event-mapping.schema.json`,
} as const;

export const SOURCE_SCHEMA_IDS = {
  stripeEvent: `${BASE}/sources/stripe-event.schema.json`,
  creditLedgerEntry: `${BASE}/sources/credit-ledger-entry.schema.json`,
  creditLedgerLogsResponse: `${BASE}/sources/credit-ledger-logs-response.schema.json`,
  amplitudeExportRow: `${BASE}/sources/amplitude-export-row.schema.json`,
  hubspotFormSubmission: `${BASE}/sources/hubspot-form-submission.schema.json`,
  hubspotContactPropertyChange: `${BASE}/sources/hubspot-contact-property-change.schema.json`,
  oaAdClidsStore: `${BASE}/sources/oa-ad-clids-store.schema.json`,
  invoiceLookupResponse: `${BASE}/sources/invoice-lookup-response.schema.json`,
  appUser: `${BASE}/sources/app-user.schema.json`,
} as const;

const HERE = fileURLToPath(new URL('.', import.meta.url));

function loadDir(dir: string): object[] {
  const full = join(HERE, dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(full, f), 'utf8')) as object);
}

let ajvInstance: Ajv2020 | undefined;

/** Shared Ajv instance with every schema registered (strict about unknown keywords). */
export function getAjv(): Ajv2020 {
  if (ajvInstance) return ajvInstance;
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const schema of [...loadDir('schemas'), ...loadDir('sources')]) ajv.addSchema(schema);
  ajvInstance = ajv;
  return ajv;
}

export function getValidator(schemaId: string): ValidateFunction {
  const fn = getAjv().getSchema(schemaId);
  if (!fn) throw new Error(`schema not registered: ${schemaId}`);
  return fn;
}

export interface ValidationResult {
  valid: boolean;
  /** Human-readable "instancePath message" strings; empty when valid. */
  errors: string[];
}

export function validateWithSchema(schemaId: string, data: unknown): ValidationResult {
  const fn = getValidator(schemaId);
  const valid = fn(data) as boolean;
  const errors = valid
    ? []
    : (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`);
  return { valid, errors };
}
