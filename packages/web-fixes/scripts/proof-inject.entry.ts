/**
 * Combined --inject-script for the watchdog's sealed "patched" run (gtm/proof/inject_web_fixes.min.js).
 * Injected at the top of <head>, i.e. before the Google tag gateway snippet, in this order:
 *  1. Consent Mode v2 defaults (consent/src/consent-defaults.ts) — must precede GTM
 *  2. Click ID Shim v2 (shim/src/shim.ts) — the production drop-in
 *  3. PROOF-ONLY stand-ins for the app patches (app-patches/src/proof-simulations.ts)
 */
import { applyConsentDefaults, type ConsentWindow } from '../consent/src/consent-defaults';
import { runClickIdShim, type ShimWindow } from '../shim/src/shim';
import { installProofSimulations } from '../app-patches/src/proof-simulations';

try {
  applyConsentDefaults(window as unknown as ConsentWindow);
} catch {
  // never break the page
}
try {
  runClickIdShim(window as unknown as ShimWindow);
} catch {
  // never break the page
}
try {
  installProofSimulations(window);
} catch {
  // never break the page
}
