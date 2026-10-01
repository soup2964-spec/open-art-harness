// How OpenArt wraps its EXISTING Worker. Nothing about routing or the origin changes: the
// handler below stands in for their current fetch handler, which already passes requests
// through to the origin (Cloudflare Pages for Astro, the Next.js origin for Suite/Legacy).
//
//   before:  export default { fetch: existingFetch };
//   after:   export default { fetch: withAttribution(existingFetch, { cookieDomain: ".openart.ai" }) };
import { withAttribution } from "./index.js";
import type { AttributionEnv } from "./index.js";

export interface Env extends AttributionEnv {
  /** Local dev only: send the pass-through to a stub (e.g. http://127.0.0.1:8788), never a real origin. */
  ORIGIN_OVERRIDE?: string;
}

/** Stand-in for OpenArt's current handler: a plain pass-through to the origin. */
export async function existingFetch(request: Request, env: Env): Promise<Response> {
  if (env.ORIGIN_OVERRIDE) {
    const url = new URL(request.url);
    const target = new URL(env.ORIGIN_OVERRIDE); // set parts explicitly: "//host/x" must not become a new origin
    target.pathname = url.pathname;
    target.search = url.search;
    return fetch(new Request(target, request));
  }
  return fetch(request);
}

export default {
  fetch: withAttribution(existingFetch, {
    cookieDomain: ".openart.ai",
    // Persistence defaults to KV (ATTRIBUTION_KV). To also mirror records into the backend:
    // persistence: [kvPersistence(), originEndpointPersistence({ url: "https://<internal-host>/api/internal/attribution" })],
    // Map the CMP once it exists (08 §1.7; README "Consent"):
    // consentPolicy: createDefaultConsentPolicy({ cmpCookie: "CookieConsent", parseCmpCookie: parseCookiebotCookie }),
  }),
} satisfies ExportedHandler<Env>;
