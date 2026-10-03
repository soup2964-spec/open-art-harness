// Shared data model. Live runs, the replay and the adapters for the saved 2026-09-29 captures all
// produce these shapes, and the contract evaluator only ever reads these shapes.

export type Platform =
  | 'google_ads'
  | 'ga4'
  | 'meta'
  | 'tiktok'
  | 'reddit'
  | 'linkedin'
  | 'x'
  | 'microsoft_uet'
  | 'openai_ads'
  | 'amplitude'
  | 'other';

export const AD_PLATFORMS: Platform[] = ['google_ads', 'meta', 'tiktok', 'reddit', 'linkedin', 'x', 'microsoft_uet', 'openai_ads'];

export const PLATFORM_LABEL: Record<Platform, string> = {
  google_ads: 'Google Ads',
  ga4: 'Google Analytics 4',
  meta: 'Meta',
  tiktok: 'TikTok',
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
  x: 'X',
  microsoft_uet: 'Microsoft Ads (UET)',
  openai_ads: 'OpenAI Ads',
  amplitude: 'Amplitude',
  other: 'Other',
};

/** What the collection/full seal did with a request. `observed` = legacy capture where nothing was blocked. */
export type RequestAction = 'allow' | 'fail' | 'fulfill' | 'redirect' | 'observed';

/** One request the browser attempted, as recorded at the CDP Fetch layer (or a legacy capture). */
export interface CapturedRequest {
  id: string;
  t: number;
  step: string;
  url: string;
  method: string;
  resourceType: string;
  postData?: string | null;
  postDataB64?: string[] | null;
  action: RequestAction;
  reason?: string;
  /** Matched a known measurement/collection endpoint rule. */
  collection: boolean;
  rule?: string;
  layer?: string;
  frameId?: string | null;
  networkId?: string | null;
  failResult?: string;
  referer?: string | null;
  /** How an allowed request left: through the first-party proxy tunnel, or fetched by the watchdog (third party). */
  via?: 'tunnel' | 'node';
  /** Status of a watchdog-fetched (third-party) response; fromCache when served from the per-session cache. */
  status?: number;
  fromCache?: boolean;
}

export type HitKind =
  | 'page_view'
  | 'conversion'
  | 'auto_conversion'
  | 'event'
  | 'remarketing'
  | 'conversion_user_data'
  | 'diagnostic'
  | 'sync'
  | 'enrich'
  | 'other';

/** A semantic decode of one attempted collection event (a request can carry several events). */
export interface DecodedHit {
  requestId: string;
  step: string;
  t: number;
  platform: Platform;
  vendor: string;
  endpoint: string;
  transport: string;
  kind: HitKind;
  eventName?: string;
  /** Collapses transport copies of one event (X's t.co + analytics.twitter.com pair, Meta /tr + CAPIG). */
  dedupeKey: string;
  /** Destination inside a platform (Google Ads account / tag id). */
  stream?: string;
  /** Page URL the hit reports (dl / url / page.url ...). */
  pageUrl?: string;
  /** Dedicated click-ID fields found on the hit, e.g. { gclaw: 'WD_TEST_GCLID_x' }. */
  clickIds: Record<string, string>;
  fields: Record<string, unknown>;
  consent?: ConsentSignals;
}

export type ConsentLetter = 'l' | 'm' | 'n' | 'p' | 'q' | 'r' | 't' | 'u' | 'v';

export interface ConsentSignalState {
  letter: string;
  default: 'granted' | 'denied' | 'not set' | 'unknown';
  update: 'granted' | 'denied' | 'none' | 'unknown';
  effective: 'granted' | 'denied' | 'not set' | 'unknown';
}

export interface ConsentSignals {
  gcd?: string;
  gcs?: string;
  dma?: string;
  npa?: string;
  decoded?: {
    ad_storage?: ConsentSignalState;
    analytics_storage?: ConsentSignalState;
    ad_user_data?: ConsentSignalState;
    ad_personalization?: ConsentSignalState;
    extra?: ConsentSignalState[];
  } | null;
  gcsDecoded?: { ad_storage: 'granted' | 'denied'; analytics_storage: 'granted' | 'denied' } | null;
}

export interface CookieLite {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  expires?: number;
  partitionKey?: unknown;
}

export interface StepSnapshot {
  step: string;
  href: string;
  referrer?: string;
  cookies: CookieLite[];
  localStorage: Record<string, string>;
  dataLayerEvents?: string[];
  consentCommands?: unknown[];
  googleConsentState?: unknown;
  fbq?: unknown;
  /** Sentinel set by an --inject-script block that actually executed (null: not injected or blocked, e.g. by a CSP). */
  injectSentinel?: string | null;
  extra?: Record<string, unknown>;
}

export interface RouteChange {
  step: string;
  from: string;
  to: string;
  method: 'mouse' | 'dom-click' | 'none';
  historyEvents: string[];
  ok: boolean;
  note?: string;
}

export interface HandoffObservation {
  hintFound: boolean;
  overlayOpened: boolean;
  /** URL shown/copied by the handoff overlay (Option 2). */
  overlayUrl: string | null;
  /** location.href while the hint was shown (by code, Option 2 copies this). */
  locationHref: string | null;
  source: 'observed-overlay' | 'inferred-location' | 'none';
  note?: string;
}

export interface GenerationObservation {
  attempted: boolean;
  page: string | null;
  typed: boolean;
  clicked: boolean;
  note?: string;
}

export interface JourneyObservation {
  id: string;
  title: string;
  landingUrl: string;
  /** Synthetic click-ID values put on the ad URL(s), by URL parameter name. */
  clickIds: Record<string, string>;
  /** Steps whose page is the app (where signup/purchase conversions would later fire). */
  appSteps: string[];
  finalStep: string;
  stepsOrder: string[];
  requests: CapturedRequest[];
  hits: DecodedHit[];
  snapshots: StepSnapshot[];
  routeChanges?: RouteChange[];
  hardLoadStep?: string;
  generation?: GenerationObservation;
  handoff?: HandoffObservation;
  blocker?: { engine: string; blocked: number; strippedParams: string[] };
  pageLoads: number;
  /** Journey step failures (CTA not found, navigation failed, crash): checks on this journey become ERROR. */
  errors: string[];
  /** Harness-level errors (CDP command failures, rejected edge-sim cookies): evidence only. */
  harnessErrors?: string[];
  notes: string[];
}

export interface ReplayScenarioContext {
  uid?: string;
  email?: string;
  transaction_id?: string;
  invoice_id?: string;
}

export interface ReplayScenarioObservation {
  id: string;
  desc: string;
  code: string;
  context: ReplayScenarioContext;
  start?: string;
  end?: string;
  /** Independent page state when scenarios run together in isolated browsers. */
  loadStatus?: string;
  readiness?: Record<string, unknown> | null;
  /** The scenario code threw in the page (it did not run to completion). */
  error?: string;
}

export interface ReplayObservation {
  page: string;
  scenarios: ReplayScenarioObservation[];
  requests: CapturedRequest[];
  hits: DecodedHit[];
  source: string;
  /** Page load outcome ('load' = loaded) and the tag-readiness probe (READY_EXPR) taken before the seal. */
  loadStatus?: string;
  readiness?: Record<string, unknown> | null;
}

export interface ConsentProbeObservation {
  region: string;
  country: string;
  subdivision: string;
  page: string;
  hits: DecodedHit[];
  consentCommands: unknown[];
  googleConsentState?: unknown;
  geoRewrites: number;
  /** The tag fell back to fetching https://www.google.com/ccm/geo (probe invalid: geo unknown). */
  geoFetchAttempted?: boolean;
  errors: string[];
}

export interface ContainerSnapshot {
  url: string;
  status: number | null;
  bytes: number;
  containerId: string | null;
  version: string | null;
  resourceSha256: string | null;
  error?: string;
}

export interface Observations {
  replay?: ReplayObservation;
  journeys: JourneyObservation[];
  consentProbes: ConsentProbeObservation[];
}

export type CheckStatus = 'PASS' | 'FAIL' | 'ERROR' | 'SKIP';

export interface Evidence {
  label: string;
  detail: string;
  /** Pointer into results.json / raw capture (e.g. "journeys.meta_multi_hop.hits[12]"). */
  ref?: string;
}

export interface CheckResult {
  id: string;
  title: string;
  claim?: string;
  platform?: Platform | string;
  status: CheckStatus;
  expected: string;
  observed: string;
  evidence: Evidence[];
  confidence: 'observed' | 'inferred';
}
