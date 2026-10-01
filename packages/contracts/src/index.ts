/**
 * @openart-signal/contracts: the shared language of every openart-signal package.
 *
 * Runtime-agnostic (Node, Cloudflare Workers, browser). Node-only helpers live in
 * subpath exports: `@openart-signal/contracts/schema-registry` (ajv + JSON Schemas)
 * and `@openart-signal/contracts/cohort` (synthetic cohort generator).
 */

export * from './constants.js';
export * from './sha256.js';
export * from './event-ids.js';
export * from './normalization.js';
export * from './canonical-helpers.js';
export * from './consent-regions.js';
export type * from './types.js';
export * from './validators.js';
export * from './model-catalog.js';
export * from './stripe-catalog.js';
export * from './platform-event-mapping.js';
