// edge-sim: what the edge WOULD set for a request, synchronously, in plain Node. Built to
// dist/edge-sim.js for the watchdog's --edge-sim option. It runs the exact same parse,
// classify, consent, plan and render code as the Worker; only the HMAC primitive differs
// (node:crypto instead of Web Crypto), and test/node/edge-sim.test.ts proves byte-identical
// output against the Worker code path.
import { createHmac, timingSafeEqual } from "node:crypto";
import { base64urlToBytes, bytesToBase64url } from "./core/base64url.js";
import { classifyRequest } from "./core/classify.js";
import type { SkipReason } from "./core/classify.js";
import { attrSigningInput, decodeStatePayload, encodeStatePayload, formatAttrCookieValue, splitAttrCookieValue } from "./core/codec.js";
import { createDefaultConsentPolicy, normalizeDecision } from "./core/consent.js";
import type { ConsentContext } from "./core/consent.js";
import { COOKIE } from "./core/constants.js";
import { isUsableSecret } from "./core/secrets.js";
import { parseCookieHeader, setCookieName } from "./core/cookies.js";
import type { AttributionRecord, ConsentDecision } from "./core/model.js";
import { resolveOptions } from "./core/options.js";
import type { CoreOptions } from "./core/options.js";
import { extractFacts } from "./core/parse.js";
import type { CfLike, RequestLike } from "./core/parse.js";
import { finalizeSetCookies, planCapture } from "./core/plan.js";
import type { VerifiedAttr } from "./core/plan.js";

/** Used when no secret is given: signatures are then only illustrative (cookie names, attributes and payloads are exact). */
export const EDGE_SIM_DEFAULT_SECRET = "edge-sim-not-a-secret-000000000000000";

export interface SimulateOptions extends CoreOptions {
  /** Clock in ms. Default Date.now(). */
  now?: number;
  /** request.cf.country. Default "US" (the teardown's vantage). null = unknown geo (treated as regulated). */
  country?: string | null;
  /** Full request.cf override (country, isEUCountry, botManagement). */
  cf?: CfLike;
  /** HMAC key; pass the real one only if you need verifiable oa_attr signatures. */
  secret?: string;
  previousSecret?: string;
  /** Synchronous consent policy. Default: the Worker's default policy. */
  consentPolicy?: (ctx: ConsentContext) => ConsentDecision;
  /** Simulate a KV-bound Worker (affects oa_attr's persisted-at bookkeeping). Default false. */
  persistence?: boolean;
}

export interface SimulateResult {
  setCookies: string[];
  /** Same reasons as the Worker; "misconfigured" = unusable secret. */
  skipped: SkipReason | "misconfigured" | null;
  record: AttributionRecord | null;
  consent: ConsentDecision | null;
  changes: string[];
}

type HeaderInput = Headers | Record<string, string> | ReadonlyArray<readonly [string, string]> | undefined;

function mac(secret: string, data: string): string {
  return bytesToBase64url(new Uint8Array(createHmac("sha256", secret).update(data, "utf8").digest()));
}

function verify(value: string | undefined, secrets: string[], now: number): VerifiedAttr | null {
  const parts = splitAttrCookieValue(value);
  if (!parts) return null;
  const tag = base64urlToBytes(parts.tag);
  if (!tag || tag.length !== 32) return null;
  const input = attrSigningInput(parts.payload);
  const index = secrets.findIndex((s) => {
    const expected = createHmac("sha256", s).update(input, "utf8").digest();
    return timingSafeEqual(expected, tag);
  });
  if (index === -1) return null;
  const state = decodeStatePayload(parts.payload, now);
  return state ? { state, needsResign: index > 0 } : null;
}

const defaultPolicy = createDefaultConsentPolicy();

/**
 * simulate(requestUrl, requestHeaders) => { setCookies } — synchronous.
 * requestHeaders may be a plain object, [name, value] tuples or a Headers instance; pass the
 * browser's Cookie header in it to simulate a returning visitor.
 */
export function simulate(requestUrl: string, requestHeaders?: HeaderInput, options: SimulateOptions = {}): SimulateResult {
  const opts = resolveOptions(options);
  const now = options.now ?? Date.now();
  const headers = new Headers(requestHeaders as ConstructorParameters<typeof Headers>[0]);
  const country = options.country === undefined ? "US" : options.country;
  const cf: CfLike | undefined = options.cf ?? (country ? { country } : undefined);
  const request: RequestLike = { url: requestUrl, method: "GET", headers, cf };
  const none = (skipped: SimulateResult["skipped"]): SimulateResult => ({ setCookies: [], skipped, record: null, consent: null, changes: [] });

  const skipped = classifyRequest(request, new URL(requestUrl), opts);
  if (skipped) return none(skipped);

  const secret = options.secret ?? EDGE_SIM_DEFAULT_SECRET;
  if (!isUsableSecret(secret)) return none("misconfigured"); // same rule as the Worker
  const secrets = isUsableSecret(options.previousSecret) ? [secret, options.previousSecret] : [secret];

  const facts = extractFacts(request, opts, now);
  const { decision: consent } = normalizeDecision(
    (options.consentPolicy ?? defaultPolicy)({
      country: facts.country,
      isEUCountry: facts.isEUCountry,
      cookies: facts.cookies,
      headers: facts.headers,
      gpc: facts.gpc,
    }),
  );
  const raw = facts.cookies.get(COOKIE.attr);
  const existing = verify(raw, secrets, now);
  const plan = planCapture({
    facts,
    existing,
    existingInvalid: raw !== undefined && existing === null,
    consent,
    opts,
    persistenceEnabled: options.persistence === true,
  });
  let signed: string | null = null;
  if (plan.emitAttr && plan.state) {
    const payload = encodeStatePayload(plan.state);
    signed = formatAttrCookieValue(payload, mac(secret, attrSigningInput(payload)));
  }
  return { setCookies: finalizeSetCookies(plan, signed, now), skipped: null, record: plan.record, consent, changes: plan.changes };
}

/**
 * Applies Set-Cookie lines to a Cookie request header (a minimal cookie jar keyed by name):
 * Max-Age<=0 deletes, anything else sets. Lets the watchdog chain multi-hop journeys.
 */
export function applySetCookies(cookieHeader: string, setCookies: readonly string[]): string {
  const jar = new Map(parseCookieHeader(cookieHeader));
  for (const line of setCookies) {
    const name = setCookieName(line);
    if (!name) continue;
    const first = line.split(";", 1)[0] ?? "";
    const value = first.slice(first.indexOf("=") + 1).trim();
    const maxAge = /;\s*max-age=(-?\d+)/i.exec(line)?.[1];
    if (maxAge !== undefined && Number(maxAge) <= 0) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
