// Scenarios run through BOTH the Worker code path (captureAttribution) and the built
// dist/edge-sim.js; test/node/edge-sim.test.ts asserts byte-identical Set-Cookie output.
import { DAY, T0, UA, navHeaders } from "./helpers.js";
import { uboStrip } from "./ubo.js";

export interface Scenario {
  name: string;
  url: string;
  headers: Record<string, string>;
  /** null = no request.cf (unknown geo); the sim needs country: null to match. */
  country?: string | null;
  now: number;
}

const shimCookie = encodeURIComponent(JSON.stringify({ gbraid: { v: "GB0", ts: T0 - DAY } }));
const consentGranted = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "granted" }))}`;

export const SCENARIOS: Scenario[] = [
  {
    name: "paid landing, US, every managed cookie",
    url: "https://openart.ai/?gclid=G1&fbclid=F1&ttclid=T1&oppref=O1&utm_source=google&utm_medium=cpc",
    headers: navHeaders({ referer: "https://www.google.com/" }),
    country: "US",
    now: T0,
  },
  {
    name: "uBO-stripped landing",
    url: uboStrip(
      "https://openart.ai/?utm_source=kj_audit&utm_medium=test&gclid=KJAUDIT_G&fbclid=KJAUDIT_F&li_fat_id=KJAUDIT_L&rdt_cid=KJAUDIT_R&oppref=KJAUDIT_O",
    ),
    headers: navHeaders(),
    country: "US",
    now: T0,
  },
  {
    name: "EEA without consent",
    url: "https://openart.ai/?gclid=G1&utm_source=google",
    headers: navHeaders(),
    country: "DE",
    now: T0,
  },
  {
    name: "EEA with ad_storage granted",
    url: "https://openart.ai/?gclid=G1&utm_source=google",
    headers: navHeaders({ cookie: consentGranted }),
    country: "DE",
    now: T0,
  },
  {
    name: "app landing merging the Astro shim's oa_ad_clids",
    url: "https://openart.ai/home?fbclid=F2",
    headers: navHeaders({ cookie: `oa_ad_clids=${shimCookie}; oa_device_id=51e60b80-46f8-48c2-9780-f92e903bf8f8` }),
    country: "US",
    now: T0,
  },
  {
    name: "Instagram webview landing",
    url: "https://openart.ai/suite/video?fbclid=KJAUDIT_F&ttclid=KJAUDIT_T&utm_source=kj_audit",
    headers: navHeaders({}, UA.instagram),
    country: "US",
    now: T0,
  },
  {
    name: "referral from chatgpt.com",
    url: "https://openart.ai/blog/what-is-openart/",
    headers: navHeaders({ referer: "https://chatgpt.com/" }),
    country: "GB",
    now: T0,
  },
  {
    name: "US with a sale/sharing opt-out (IAB usprivacy 1YYN) and an ad_storage grant",
    url: "https://openart.ai/?gclid=G1&fbclid=F1&utm_source=google",
    headers: navHeaders({ cookie: `usprivacy=1YYN; ${consentGranted}` }),
    country: "US",
    now: T0,
  },
  {
    name: "Canary Islands (IC, contracts CONSENT_REQUIRED_REGIONS) without consent",
    url: "https://openart.ai/?gclid=G1&utm_source=google",
    headers: navHeaders(),
    country: "IC",
    now: T0,
  },
  {
    name: "unknown geo (no request.cf): fails closed to utm-only",
    url: "https://openart.ai/?gclid=G1&utm_source=google",
    headers: navHeaders(),
    country: null,
    now: T0,
  },
  {
    name: "bot (skipped)",
    url: "https://openart.ai/?gclid=G1",
    headers: navHeaders({}, "AdsBot-Google (+http://www.google.com/adsbot.html)"),
    country: "US",
    now: T0,
  },
  {
    name: "asset (skipped)",
    url: "https://openart.ai/_next/static/chunks/main.js?gclid=G1",
    headers: navHeaders(),
    country: "US",
    now: T0,
  },
  {
    name: "prerender (skipped)",
    url: "https://openart.ai/?gclid=G1",
    headers: navHeaders({ "sec-purpose": "prefetch;prerender" }),
    country: "US",
    now: T0,
  },
];
