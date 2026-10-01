// In-app-browser handoff. Google blocks OAuth inside embedded webviews (01 §T11), so paid-social
// users often finish in the system browser, which starts with an empty cookie jar.
//   POST /api/attribution/handoff {path}  -> {token, url, expiresAt, path}   (token lives 30 min in KV)
//   GET  /r/:token                        -> restores the attribution cookies once, 302 to the same-origin path
// The KV entry holds the target PATH and the allow-listed attribution params (click ids, utm_*),
// consent-filtered, never the rest of the query string: a query can carry a magic-link code or a
// reset token, and the token is a bearer link. Tokens are single-use: the first real navigation
// deletes the entry before anything is restored; bots, link unfurlers and non-document requests
// get the redirect without consuming it.
import { consentContextFor, reportError, scheduleForget, schedulePersistence } from "./runtime.js";
import type { AttributionEnv, CaptureOptions, WaitUntilContext } from "./runtime.js";
import { bytesToBase64url, utf8 } from "./core/base64url.js";
import { isBotRequest } from "./core/classify.js";
import { decodeStatePayload, encodeStatePayload } from "./core/codec.js";
import { consentSnapshot, createDefaultConsentPolicy, minMode, normalizeDecision } from "./core/consent.js";
import { COOKIE, DEVICE_ID_RE, TTL } from "./core/constants.js";
import type { AttributionState, ConsentDecision, ConsentMode, ConsentSnapshot } from "./core/model.js";
import { resolveOptions } from "./core/options.js";
import { attributionParams, extractFacts, pathCarriesCredential } from "./core/parse.js";
import type { RequestLike } from "./core/parse.js";
import { finalizeSetCookies, planCapture } from "./core/plan.js";
import { readSecrets, signAttrState, verifyAttrCookie } from "./crypto.js";
import { resolvePersistence } from "./persistence.js";
import type { KVNamespaceLike } from "./persistence.js";

export interface HandoffOptions {
  /** Default "/api/attribution/handoff". */
  createPath?: string;
  /** Default "/r/". Only exact 22-character tokens are intercepted; other paths pass through. */
  redeemPrefix?: string;
  /** Token lifetime. Default 1800 (30 min). */
  ttlSeconds?: number;
  /** Where unknown tokens and rejected targets land. Default "/". */
  fallbackPath?: string;
}

interface ResolvedHandoff {
  createPath: string;
  redeemPrefix: string;
  ttlSeconds: number;
  fallbackPath: string;
}

interface HandoffEntry {
  v: 1;
  /** encodeStatePayload() of the (consent-filtered) state; KV is trusted storage, so unsigned. */
  state: string | null;
  /** Target pathname only. Entries written before `params` existed may still carry a query: re-sanitised on read. */
  target: string;
  /** Allow-listed attribution params (click ids, utm_*) for the redirect, consent-filtered. */
  params?: string;
  expiresAt: number;
  consent: ConsentSnapshot | null;
  deviceId: string | null;
}

/** A sanitised handoff target: a same-origin path and only its attribution params. */
export interface HandoffTarget {
  path: string;
  params: URLSearchParams;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_BODY_BYTES = 4096;
/** Cap on the target input and on the normalised (percent-encoded) path, the same at creation and redemption. */
const MAX_TARGET_LENGTH = 2048;
/** Cap on the stored (re-encoded) attribution params, the same at creation and redemption. */
const MAX_PARAMS_LENGTH = 4096;
const defaultPolicy = createDefaultConsentPolicy();

/**
 * Tokens this isolate consumed recently. KV has no atomic take and a delete needs time to reach
 * other readers, so a redemption racing the first one in this isolate (a double tap, a replayed
 * link) is refused here even if its KV read still returned the entry.
 */
const CONSUMED = new Map<string, number>();
const CONSUMED_MEMO_MS = 120_000;
const CONSUMED_MEMO_MAX = 1024;

/** True for the first caller per KV key (in this isolate). Never throws. */
function claimToken(key: string): boolean {
  const nowMs = Date.now();
  for (const [k, until] of CONSUMED) {
    if (until > nowMs && CONSUMED.size < CONSUMED_MEMO_MAX) break;
    CONSUMED.delete(k);
  }
  if (CONSUMED.has(key)) return false;
  CONSUMED.set(key, nowMs + CONSUMED_MEMO_MS);
  return true;
}

/** Which attribution params a consent mode allows in a URL: all, the utm_* only, or none. */
function paramsForMode(params: URLSearchParams, mode: ConsentMode): URLSearchParams {
  if (mode === "full") return new URLSearchParams(params);
  const out = new URLSearchParams();
  if (mode === "none") return out;
  for (const [k, v] of params) if (k.startsWith("utm_")) out.append(k, v);
  return out;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function resolveHandoff(o: HandoffOptions | undefined): ResolvedHandoff {
  return {
    createPath: o?.createPath ?? "/api/attribution/handoff",
    redeemPrefix: o?.redeemPrefix ?? "/r/",
    ttlSeconds: o?.ttlSeconds ?? TTL.handoffSeconds,
    fallbackPath: o?.fallbackPath ?? "/",
  };
}

/** KV key for a token: a SHA-256 digest, so stored keys cannot be replayed as tokens. */
export async function handoffKvKey(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(token)));
  return `handoff:${bytesToBase64url(digest)}`;
}

/**
 * Open-redirect guard: accepts only same-origin paths ("/..."), never "//host", backslashes,
 * control characters or whitespace, and never the handoff routes themselves. Returns the pathname
 * and, from the query, only the attribution params (attributionParams); the rest of the query and
 * the fragment are dropped. Refused as well (null): a path that carries a credential (an invite,
 * reset or magic-link segment, a token-shaped segment: the token is a bearer link and the target
 * is redirected to for bots and expired hits too), a normalised path or a param string over the
 * caps (checked here, so creation never issues a token redemption could not use).
 */
export function sanitizeHandoffTarget(input: unknown, origin: string, handoff?: HandoffOptions): HandoffTarget | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_TARGET_LENGTH) return null;
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001F\u007F]/.test(input)) return null;
  let u: URL;
  try {
    u = new URL(input, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const path = u.pathname;
  if (path.startsWith("//") || path.length > MAX_TARGET_LENGTH) return null;
  const cfg = resolveHandoff(handoff);
  if (path === cfg.createPath || path.startsWith(cfg.redeemPrefix)) return null;
  if (pathCarriesCredential(path)) return null;
  const params = attributionParams(u.searchParams);
  if (params.toString().length > MAX_PARAMS_LENGTH) return null;
  return { path, params };
}

/** Best-effort removal of an entry this Worker cannot use; failures are reported, never thrown. */
async function discardEntry(kv: KVNamespaceLike, key: string, options: CaptureOptions): Promise<void> {
  try {
    if (typeof kv.delete === "function") await kv.delete(key);
  } catch (err) {
    reportError(options, err, "handoff");
  }
}

/** The pathname sanitizeHandoffTarget() accepts (no query), or null. */
export function sanitizeTargetPath(input: unknown, origin: string, handoff?: HandoffOptions): string | null {
  return sanitizeHandoffTarget(input, origin, handoff)?.path ?? null;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function redirect(location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/** Same-origin check for the token-minting POST (CSRF): Origin and/or Sec-Fetch-Site must say so. */
function sameOriginPost(request: RequestLike, selfOrigin: string): boolean {
  const origin = request.headers.get("origin")?.trim();
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!origin && !site) return false;
  if (origin && origin !== selfOrigin) return false;
  if (site && site !== "same-origin") return false;
  return true;
}

/** Reads at most MAX_BODY_BYTES, streaming, so an oversized or endless body is never buffered. */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function randomToken(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Handles the two handoff routes; returns null for every other request. */
export async function handleHandoff(request: Request, env: object, ctx: WaitUntilContext, options: CaptureOptions): Promise<Response | null> {
  if (options.handoff === false) return null;
  const cfg = resolveHandoff(options.handoff);
  const url = new URL(request.url);
  if (url.pathname === cfg.createPath) return createHandoff(request, url, env, options, cfg);
  if (request.method === "GET" && url.pathname.startsWith(cfg.redeemPrefix)) {
    const token = url.pathname.slice(cfg.redeemPrefix.length);
    if (TOKEN_RE.test(token)) return redeemHandoff(request, url, token, env, ctx, options, cfg);
  }
  return null;
}

async function createHandoff(request: Request, url: URL, env: object, options: CaptureOptions, cfg: ResolvedHandoff): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  if (!sameOriginPost(request, url.origin)) return json(403, { error: "forbidden" });

  const text = await readBody(request);
  if (text === null) return json(400, { error: "invalid_body" });
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return json(400, { error: "invalid_body" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid_body" });
  const rawPath = (body as { path?: unknown }).path ?? cfg.fallbackPath;
  const target = sanitizeHandoffTarget(rawPath, url.origin, options.handoff || undefined);
  if (!target) return json(400, { error: "invalid_path" });

  const opts = resolveOptions(options);
  const now = (options.now ?? Date.now)();
  const facts = extractFacts(request, opts, now);
  const { decision: consent, error: policyError } = normalizeDecision(await (options.consentPolicy ?? defaultPolicy)(consentContextFor(facts)));
  if (policyError) reportError(options, policyError, "consent");
  const plainPath = withQuery(target.path, paramsForMode(target.params, consent.mode));
  const plain = { token: null, url: `${url.origin}${plainPath}`, expiresAt: null, path: plainPath };
  const kv = (env as AttributionEnv).ATTRIBUTION_KV;
  const secrets = readSecrets(env as AttributionEnv);
  if (!kv || !secrets) return json(200, plain);

  const raw = facts.cookies.get(COOKIE.attr);
  const verified = raw ? await verifyAttrCookie(raw, secrets, now) : null;
  if (!verified || consent.mode === "none") return json(200, plain);

  const full = consent.mode === "full" && verified.state.consentMode === "full";
  // Lineage only for the device the SIGNED cookie is bound to: a forged Cookie header cannot
  // name someone else's device and inherit its record at signup.
  const lineage = full && facts.deviceId !== null && verified.state.boundDevice === facts.deviceId ? facts.deviceId : null;
  const state: AttributionState = {
    ...verified.state,
    clickIds: full ? verified.state.clickIds : {},
    consentMode: full ? "full" : "utm-only",
    persistedAt: null,
    handoffFrom: lineage,
    boundDevice: null,
  };
  // Click ids travel in the redirect only under full consent, like the state itself.
  const params = paramsForMode(target.params, full ? "full" : "utm-only");
  const token = randomToken();
  const expiresAt = now + cfg.ttlSeconds * 1000;
  const entry: HandoffEntry = {
    v: 1,
    state: encodeStatePayload(state),
    target: target.path,
    params: params.toString(),
    expiresAt,
    // The decision itself (not the content mode): the external browser applies it if it has none of its own.
    consent: consentSnapshot(consent),
    deviceId: lineage,
  };
  // Awaited on purpose: the link must work the moment the user pastes it.
  await (kv as KVNamespaceLike).put(await handoffKvKey(token), JSON.stringify(entry), { expirationTtl: cfg.ttlSeconds });
  return json(200, { token, url: `${url.origin}${cfg.redeemPrefix}${token}`, expiresAt, path: withQuery(target.path, params) });
}

function validSnapshot(c: unknown): c is ConsentSnapshot {
  if (!c || typeof c !== "object") return false;
  const o = c as Partial<ConsentSnapshot>;
  return (
    (o.mode === "full" || o.mode === "utm-only" || o.mode === "none") &&
    typeof o.explicit === "boolean" &&
    typeof o.gpc === "boolean" &&
    (o.optOutSaleSharing === undefined || typeof o.optOutSaleSharing === "boolean") &&
    (o.region === "regulated" || o.region === "unregulated" || o.region === "unknown") &&
    !!o.signals &&
    typeof o.signals === "object"
  );
}

function parseEntry(raw: string): HandoffEntry | null {
  try {
    const e = JSON.parse(raw) as Partial<HandoffEntry>;
    if (e.v !== 1 || typeof e.target !== "string" || typeof e.expiresAt !== "number") return null;
    if (e.params !== undefined && (typeof e.params !== "string" || e.params.length > MAX_PARAMS_LENGTH)) return null;
    if (e.state !== null && typeof e.state !== "string") return null;
    if (e.deviceId !== null && (typeof e.deviceId !== "string" || !DEVICE_ID_RE.test(e.deviceId))) return null;
    if (e.consent !== null && !validSnapshot(e.consent)) return null; // fail closed on anything unexpected
    return e as HandoffEntry;
  } catch {
    return null;
  }
}

/**
 * The token is a bearer link, so a consent choice must not travel with it to whoever opens it:
 * the external browser's own explicit choice wins, and otherwise the carried decision can
 * only NARROW the redeemer's own (a webview refusal carries over, a webview grant does not).
 */
function effectiveConsent(local: ConsentDecision, carried: ConsentSnapshot | null): ConsentDecision {
  if (local.explicit || !carried) return local;
  const mode = minMode(local.mode, carried.mode);
  // A sale/sharing opt-out made in the webview is the same person's choice: it is recorded here too.
  const optOutSaleSharing = local.optOutSaleSharing === true || carried.optOutSaleSharing === true;
  if (mode === local.mode && optOutSaleSharing === (local.optOutSaleSharing === true)) return local;
  return { ...local, mode, optOutSaleSharing, reason: mode === local.mode ? local.reason : "handoff:carried-narrower" };
}

async function redeemHandoff(
  request: Request,
  url: URL,
  token: string,
  env: object,
  ctx: WaitUntilContext,
  options: CaptureOptions,
  cfg: ResolvedHandoff,
): Promise<Response> {
  const fallback = cfg.fallbackPath;
  const kv = (env as AttributionEnv).ATTRIBUTION_KV;
  if (!kv) return redirect(fallback);
  const key = await handoffKvKey(token);
  const raw = await kv.get(key);
  if (!raw) return redirect(fallback);
  const entry = parseEntry(raw);
  const target = entry ? sanitizeHandoffTarget(entry.target, url.origin, options.handoff || undefined) : null;
  if (!entry || !target) {
    // Corrupt, or a target this Worker no longer accepts (a credential in its path, over the caps,
    // off-origin): discarded, never redirected to.
    await discardEntry(kv as KVNamespaceLike, key, options);
    return redirect(fallback);
  }
  // Stored params are re-validated; an entry from before they were stored separately keeps the
  // attribution params of its target's query and nothing else.
  const stored = entry.params !== undefined ? attributionParams(new URLSearchParams(entry.params)) : target.params;

  // Redirects that restore nothing carry the path only.
  const opts = resolveOptions(options);
  const now = (options.now ?? Date.now)();
  if (now > entry.expiresAt) return redirect(target.path);
  // Link unfurlers and crawlers get the redirect but no cookies, and do not consume the token.
  // Prefetch/prerender is NOT skipped: a prerendered /r/ link that is later activated must restore.
  if (isBotRequest(request, opts)) return redirect(target.path);
  // Only a top-level navigation restores: an <img>, iframe or fetch() pointed at /r/ gets nothing.
  const dest = request.headers.get("sec-fetch-dest")?.trim().toLowerCase();
  if (dest && dest !== "document") return redirect(target.path);
  const secrets = readSecrets(env as AttributionEnv);
  if (!secrets || !entry.state) return redirect(target.path);
  const incoming = decodeStatePayload(entry.state, now);
  if (!incoming) return redirect(target.path);

  // Single use. The claim refuses a second redemption racing this one in the isolate; the KV
  // delete (before anything is restored) retires the token everywhere else. Without a working
  // delete nothing is restored (fail closed).
  if (!claimToken(key)) return redirect(target.path);
  try {
    if (typeof kv.delete !== "function") throw new Error("ATTRIBUTION_KV cannot delete: handoff tokens would be reusable");
    await kv.delete(key);
  } catch (err) {
    reportError(options, err, "handoff");
    return redirect(target.path);
  }

  const facts = extractFacts(request, opts, now);
  const { decision: local, error: policyError } = normalizeDecision(await (options.consentPolicy ?? defaultPolicy)(consentContextFor(facts)));
  if (policyError) reportError(options, policyError, "consent");
  const consent = effectiveConsent(local, entry.consent);
  const location = withQuery(target.path, paramsForMode(stored, consent.mode));
  const rawAttr = facts.cookies.get(COOKIE.attr);
  const existing = rawAttr ? await verifyAttrCookie(rawAttr, secrets, now) : null;
  const adapters = resolvePersistence(options.persistence, env);
  const plan = planCapture({
    facts,
    existing,
    existingInvalid: rawAttr !== undefined && existing === null,
    consent,
    opts,
    persistenceEnabled: adapters.length > 0,
    incoming,
    noTouch: true,
  });
  const signed = plan.emitAttr && plan.state ? await signAttrState(plan.state, secrets.current) : null;
  if (plan.persist === "now" && plan.record && facts.deviceId) {
    schedulePersistence(ctx, adapters, plan.record, facts.deviceId, env, now, options);
  }
  if (plan.forget && facts.deviceId) scheduleForget(ctx, adapters, facts.deviceId, env, now, options);
  try {
    return redirect(location, finalizeSetCookies(plan, signed, now));
  } catch (err) {
    reportError(options, err, "handoff");
    return redirect(location);
  }
}
