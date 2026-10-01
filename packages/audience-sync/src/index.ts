/**
 * @openart-signal/audience-sync: consent-filtered, per-platform hashed audience lists built from
 * predicted profit, as dry-run upload requests for Google (Data Manager API Customer Match),
 * Meta (customer-list Custom Audiences) and TikTok (customer files). Never sends anything.
 */

export * from './types.js';
export * from './consent.js';
export * from './identifiers.js';
export * from './build.js';
export * from './diff.js';
export * from './plan.js';
export * from './client.js';
export * from './warehouse-candidates.js';
export * from './platforms/common.js';
export * from './platforms/google.js';
export * from './platforms/meta.js';
export * from './platforms/tiktok.js';
export { candidatesFromCohort, loadFixtureCohort, COHORT_COUNTRY_ISO2, ILLUSTRATIVE_CONSENT_RATES, type ConsentScenario } from './cohort-candidates.js';
