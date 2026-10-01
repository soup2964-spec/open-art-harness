/**
 * Browser entry for hubspot/dist/openart-hubspot-fill.min.js. Place it inline ABOVE
 * <script src="https://js-na2.hsforms.net/forms/embed/244977254.js" defer> on /enterprise
 * (HubSpot: register hs-form-event:on-ready listeners before the embed code executes).
 */
import { installHubSpotFill, type FillWindow } from './hubspot-fill';

try {
  installHubSpotFill(window as unknown as FillWindow);
} catch {
  // never break the page
}
