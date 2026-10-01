/**
 * Browser entry for dist/openart-click-id-shim.min.js.
 * Paste the built file inline where the Astro layout renders the original
 * "OpenArt Click ID Shim" <script>, or inject it at document start.
 */
import { runClickIdShim, type ShimWindow } from './shim';

try {
  runClickIdShim(window as unknown as ShimWindow);
} catch {
  // The shim must never break the page (same contract as the original try/catch).
}
