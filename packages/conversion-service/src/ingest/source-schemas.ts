/**
 * Validators for OpenArt's SOURCE shapes, compiled from the contracts package's JSON
 * Schemas (imported as JSON so the bundled Cloud Run build carries them; the contracts
 * schema-registry reads them from disk, which a bundle cannot do). Same Ajv settings as
 * contracts/src/schema-registry.ts.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import amplitudeExportRow from '@openart-signal/contracts/sources/amplitude-export-row.schema.json' with { type: 'json' };
import creditLedgerEntry from '@openart-signal/contracts/sources/credit-ledger-entry.schema.json' with { type: 'json' };
import hubspotContactPropertyChange from '@openart-signal/contracts/sources/hubspot-contact-property-change.schema.json' with { type: 'json' };
import hubspotFormSubmission from '@openart-signal/contracts/sources/hubspot-form-submission.schema.json' with { type: 'json' };
import stripeEvent from '@openart-signal/contracts/sources/stripe-event.schema.json' with { type: 'json' };

export const SOURCE_SCHEMAS = {
  stripeEvent,
  creditLedgerEntry,
  amplitudeExportRow,
  hubspotFormSubmission,
  hubspotContactPropertyChange,
} as const;

export type SourceSchemaName = keyof typeof SOURCE_SCHEMAS;

let ajv: Ajv2020 | undefined;
const compiled = new Map<SourceSchemaName, ValidateFunction>();

function instance(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
  }
  return ajv;
}

export interface SourceValidation {
  valid: boolean;
  errors: string[];
}

export function validateSource(name: SourceSchemaName, data: unknown): SourceValidation {
  let fn = compiled.get(name);
  if (!fn) {
    fn = instance().compile(SOURCE_SCHEMAS[name] as object);
    compiled.set(name, fn);
  }
  const valid = fn(data) as boolean;
  return {
    valid,
    errors: valid ? [] : (fn.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()),
  };
}
