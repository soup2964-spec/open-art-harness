/**
 * Browser entry for consent/dist/openart-consent-defaults.min.js: the Consent Mode v2 defaults as
 * on-page gtag() calls. Production uses the GTM Consent Initialization template instead (see
 * consent/CONSENT.md); this build exists for the edge/on-page option and for the sealed proof
 * (inject at document start, before the Google tag gateway snippet).
 */
import { applyConsentDefaults, type ConsentWindow } from './consent-defaults';

try {
  applyConsentDefaults(window as unknown as ConsentWindow);
} catch {
  // never break the page
}
