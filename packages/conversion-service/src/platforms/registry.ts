import type { Platform } from '@openart-signal/contracts';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { OutboxAction } from '../types.js';
import { googleAds } from './google/index.js';
import { linkedin } from './linkedin/index.js';
import { meta } from './meta/index.js';
import { microsoft } from './microsoft/index.js';
import { reddit } from './reddit/index.js';
import { tiktok } from './tiktok/index.js';
import type { PlatformModule, PlatformRequest } from './types.js';
import { x } from './x/index.js';

export const PLATFORM_MODULES: Readonly<Record<Platform, PlatformModule>> = {
  google_ads: googleAds,
  meta,
  tiktok,
  reddit,
  linkedin,
  x,
  microsoft,
};

let ajv: Ajv2020 | undefined;
const validators = new Map<string, ValidateFunction>();

function validatorsFor(platform: Platform, action: OutboxAction): ValidateFunction[] {
  const declared = PLATFORM_MODULES[platform].requestSchemas[action];
  if (!declared) throw new Error(`no request schema for ${platform}:${action}`);
  const schemas = Array.isArray(declared) ? declared : [declared];
  return schemas.map((schema, i) => validatorFor(`${platform}:${action}:${i}`, schema));
}

function validatorFor(key: string, schema: object): ValidateFunction {
  let fn = validators.get(key);
  if (!fn) {
    if (!ajv) {
      // Same strictness as contracts/src/schema-registry.ts (required-in-if/then is legitimate JSON Schema).
      ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
      addFormats(ajv);
    }
    fn = ajv.compile(schema);
    validators.set(key, fn);
  }
  return fn;
}

export interface RequestValidation {
  valid: boolean;
  errors: string[];
}

/** Validate a built request body against the platform's documented request schema(s): valid if any shape matches. */
export function validateRequest(req: Pick<PlatformRequest, 'platform' | 'action' | 'body'>): RequestValidation {
  const errors: string[] = [];
  for (const fn of validatorsFor(req.platform, req.action)) {
    if (fn(req.body) as boolean) return { valid: true, errors: [] };
    errors.push(...(fn.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()));
  }
  return { valid: false, errors };
}
