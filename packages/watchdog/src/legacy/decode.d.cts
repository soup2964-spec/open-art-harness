export interface MarkerTables {
  EMAIL_MARKERS: Record<string, string>;
  TXN_MARKERS: Record<string, string>;
  TXN_SCENARIO: Record<string, string>;
}

export interface LegacyCapture {
  t?: number;
  iso?: string;
  scenario?: string;
  layer?: string;
  sess?: string;
  resourceType?: string;
  method?: string;
  url: string;
  postData?: string | null;
  postDataEntriesB64?: string[] | null;
  failRequest?: string;
}

export interface LegacyDecoded {
  i: number;
  t?: number;
  iso?: string;
  windowScenario?: string;
  markerScenarios: string[];
  layer?: string;
  sess?: string;
  vendor: string;
  adVendor: boolean;
  resourceType?: string;
  method?: string;
  hostPath: string;
  failRequest?: string;
  bodyEncoding: string | null;
  bodyBytes: number | null;
  emailHits: string[];
  txnHits: string[];
  fields: Record<string, unknown>;
  url: string;
  bodyText: string | null;
}

export function buildMarkers(o?: { email?: string; txnScenario?: Record<string, string> }): MarkerTables;
export function decodeCapture(c: LegacyCapture, i: number, markers?: MarkerTables): LegacyDecoded;
export function analyzeRun(run: unknown, opts?: { markers?: MarkerTables }): {
  summary: Record<string, unknown>;
  decoded: LegacyDecoded[];
  accounting: Array<{ t: number; scenario: string; sess: string; type: string; method: string; url: string; outcome: string; gotNetworkResponse: boolean }>;
  unaccounted: Array<Record<string, unknown>>;
  failErrors: Array<{ url: string; err: string }>;
  proxyPostSeal: Array<{ iso: string; kind: string; target: string; action: string; class: string }>;
  attribution: Array<{ i: number; vendor: string; hostPath: string; window: string; marker: string[]; agree: boolean }>;
  jsTrace: unknown[];
  timeline: unknown[];
  sealProbes: unknown[];
  markers: { EMAIL_MARKERS: Record<string, string>; TXN_MARKERS: Record<string, string> };
};
export function analyze(runFile: string, opts?: { markers?: MarkerTables }): { outFile: string; out: ReturnType<typeof analyzeRun> };
export function vendorOf(u: URL): string;
export const AD_VENDORS: Set<string>;
export const EMAIL_MARKERS: Record<string, string>;
export const TXN_MARKERS: Record<string, string>;
export const TXN_SCENARIO: Record<string, string>;
export function decodeBody(cap: { postData?: string | null; postDataEntriesB64?: string[] | null }): { raw: number | null; text: string | null; encoding: string | null };
export function parseParams(u: URL): Record<string, string | string[]>;
export function tryJSON(s: string): unknown;
export function formParse(s: string): Record<string, string> | null;
export function describeEme(eme: string | undefined): string;
export function extractFields(vendor: string, u: URL, p: Record<string, unknown>, bodyText: string | null): Record<string, unknown>;
export function classifyProxyTarget(t: string): string;
