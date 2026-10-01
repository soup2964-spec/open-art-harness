// Runtime plumbing shared by capture.ts and handoff.ts (kept separate to avoid an import cycle).
import type { ConsentContext, ConsentPolicy } from "./core/consent.js";
import { setCookieName } from "./core/cookies.js";
import type { AttributionRecord } from "./core/model.js";
import type { CoreOptions } from "./core/options.js";
import type { RequestFacts } from "./core/parse.js";
import type { HandoffOptions } from "./handoff.js";
import type { AttributionPersistence, KVNamespaceLike } from "./persistence.js";

/** Bindings read from the Worker env. */
export interface AttributionEnv {
  /** HMAC key for oa_attr (>= 32 chars). `wrangler secret put ATTRIBUTION_SECRET`. */
  ATTRIBUTION_SECRET?: string;
  /** Previous key, accepted for verification during rotation. */
  ATTRIBUTION_SECRET_PREVIOUS?: string;
  /** Device-keyed records (90 d) and handoff tokens (30 min). */
  ATTRIBUTION_KV?: KVNamespaceLike;
}

/** The only part of ExecutionContext used here. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CaptureOptions extends CoreOptions {
  /** Clock in ms. Default Date.now. */
  now?: () => number;
  /** Consent policy. Default: createDefaultConsentPolicy() (oa_consent cookie + request.cf.country). */
  consentPolicy?: ConsentPolicy;
  /** Default: KV when ATTRIBUTION_KV is bound. `false` disables persistence. */
  persistence?: AttributionPersistence | AttributionPersistence[] | false;
  /** When cookies are added, stop shared caches from storing the response (Cache-Control: private). Default true. */
  privateCacheOnSetCookie?: boolean;
  /** Handoff routes served by withAttribution; `false` disables them. */
  handoff?: HandoffOptions | false;
  /** Called for every internal error; errors never reach the response. Default: console.warn once per stage. */
  onError?: (error: unknown, stage: string) => void;
}

const warned = new Set<string>();

export function reportError(options: Pick<CaptureOptions, "onError">, error: unknown, stage: string): void {
  try {
    if (options.onError) {
      options.onError(error, stage);
      return;
    }
    const key = `${stage}:${error instanceof Error ? error.message : String(error)}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[edge-attribution] ${stage}:`, error);
    }
  } catch {
    /* reporting must never break the request */
  }
}

export function consentContextFor(facts: RequestFacts): ConsentContext {
  return { country: facts.country, isEUCountry: facts.isEUCountry, cookies: facts.cookies, headers: facts.headers, gpc: facts.gpc };
}

/** Hands every adapter's write to ctx.waitUntil (one promise); failures go to onError. */
export function schedulePersistence(
  ctx: WaitUntilContext,
  adapters: readonly AttributionPersistence[],
  record: AttributionRecord,
  deviceId: string,
  env: object,
  now: number,
  options: Pick<CaptureOptions, "onError">,
): void {
  const stored: AttributionRecord = { ...record, deviceId };
  const task = Promise.all(
    adapters.map((a) =>
      Promise.resolve()
        .then(() => a.persist({ record: stored, deviceId, env, now }))
        .catch((err: unknown) => reportError(options, err, `persist:${a.name}`)),
    ),
  );
  hand(ctx, task, options);
}

/** Explicit withdrawal: every adapter that can, deletes the device-keyed record (in waitUntil). */
export function scheduleForget(
  ctx: WaitUntilContext,
  adapters: readonly AttributionPersistence[],
  deviceId: string,
  env: object,
  now: number,
  options: Pick<CaptureOptions, "onError">,
): void {
  const task = Promise.all(
    adapters
      .filter((a) => typeof a.forget === "function")
      .map((a) =>
        Promise.resolve()
          .then(() => a.forget!({ deviceId, env, now }))
          .catch((err: unknown) => reportError(options, err, `forget:${a.name}`)),
      ),
  );
  hand(ctx, task, options);
}

/** A broken waitUntil must never cost the visitor their cookies. */
function hand(ctx: WaitUntilContext, task: Promise<unknown>, options: Pick<CaptureOptions, "onError">): void {
  try {
    ctx.waitUntil(task);
  } catch (err) {
    reportError(options, err, "persist");
  }
}

export function responseSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

/** Stops shared caches from storing a response that now carries per-visitor Set-Cookie headers. */
function markPrivate(headers: Headers): void {
  const cc = headers.get("cache-control");
  if (!cc) {
    headers.set("cache-control", "private");
    return;
  }
  const directives = cc
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (directives.some((d) => /^(private|no-store)$/i.test(d))) return;
  const kept = directives.filter((d) => !/^(public|s-maxage\s*=.*|proxy-revalidate)$/i.test(d));
  headers.set("cache-control", ["private", ...kept].join(", "));
}

/** Appends Set-Cookie lines without touching body or status; cookies the response already sets win. */
export function appendSetCookies(response: Response, lines: readonly string[], markPrivateCache: boolean): Response {
  if (lines.length === 0) return response;
  const already = new Set(responseSetCookies(response.headers).map(setCookieName));
  const add = lines.filter((l) => !already.has(setCookieName(l)));
  if (add.length === 0) return response;
  const out = new Response(response.body, response);
  for (const l of add) out.headers.append("set-cookie", l);
  if (markPrivateCache) markPrivate(out.headers);
  return out;
}
