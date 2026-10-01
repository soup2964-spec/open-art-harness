// Public entry points for OpenArt's existing Worker:
//   withAttribution(handler, options)                 wrap the current fetch handler (one line)
//   captureAttribution(request, env, ctx, options)    lower level: compute cookies, then apply()
import { classifyRequest } from "./core/classify.js";
import type { SkipReason } from "./core/classify.js";
import { createDefaultConsentPolicy, normalizeDecision } from "./core/consent.js";
import { COOKIE, DEVICE_ID_RE } from "./core/constants.js";
import { findSetCookieValue } from "./core/cookies.js";
import type { AttributionRecord, ConsentDecision } from "./core/model.js";
import { resolveOptions } from "./core/options.js";
import { extractFacts } from "./core/parse.js";
import type { RequestLike } from "./core/parse.js";
import { finalizeSetCookies, planCapture } from "./core/plan.js";
import { readSecrets, signAttrState, verifyAttrCookie } from "./crypto.js";
import { handleHandoff } from "./handoff.js";
import { resolvePersistence } from "./persistence.js";
import { appendSetCookies, consentContextFor, reportError, responseSetCookies, scheduleForget, schedulePersistence } from "./runtime.js";
import type { AttributionEnv, CaptureOptions, WaitUntilContext } from "./runtime.js";

export type { AttributionEnv, CaptureOptions, WaitUntilContext } from "./runtime.js";

export type CaptureSkip = SkipReason | "misconfigured" | "error";

export interface CaptureResult {
  /** Why nothing was done, or null when the request was processed. */
  skipped: CaptureSkip | null;
  consent: ConsentDecision | null;
  /** The attribution record after this request (null when skipped or consent mode "none"). */
  record: AttributionRecord | null;
  /** Set-Cookie header values to add to the response. */
  setCookies: string[];
  /** Why things changed: first-touch, last-touch, click:<key>, fbc:set, cookie:<name>, purge:<name>, ... */
  changes: string[];
  persistence: "scheduled" | "awaiting-device-id" | "none";
  /**
   * The response with `setCookies` appended (cookies the response already sets win). If the
   * device id was minted by this very response, also persists under it and re-signs oa_attr
   * so the next request does not write again.
   */
  apply(response: Response): Promise<Response>;
}

const defaultPolicy = createDefaultConsentPolicy();

function passThrough(skipped: CaptureSkip): CaptureResult {
  return { skipped, consent: null, record: null, setCookies: [], changes: [], persistence: "none", apply: async (r) => r };
}

/**
 * Captures attribution for one request. Never throws: internal failures are reported via
 * `onError` and yield a pass-through result.
 */
export async function captureAttribution(
  request: RequestLike,
  env: object,
  ctx: WaitUntilContext,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  try {
    const opts = resolveOptions(options);
    const now = (options.now ?? Date.now)();
    const url = new URL(request.url);
    const skipped = classifyRequest(request, url, opts);
    if (skipped) return passThrough(skipped);

    const secrets = readSecrets(env as AttributionEnv);
    if (!secrets) {
      reportError(options, new Error("ATTRIBUTION_SECRET is missing or shorter than 32 characters"), "config");
      return passThrough("misconfigured");
    }

    const facts = extractFacts(request, opts, now);
    const { decision: consent, error: policyError } = normalizeDecision(await (options.consentPolicy ?? defaultPolicy)(consentContextFor(facts)));
    if (policyError) reportError(options, policyError, "consent");
    const raw = facts.cookies.get(COOKIE.attr);
    const existing = raw ? await verifyAttrCookie(raw, secrets, now) : null;
    const adapters = resolvePersistence(options.persistence, env);

    const plan = planCapture({
      facts,
      existing,
      existingInvalid: raw !== undefined && existing === null,
      consent,
      opts,
      persistenceEnabled: adapters.length > 0,
    });
    const signed = plan.emitAttr && plan.state ? await signAttrState(plan.state, secrets.current) : null;
    const setCookies = finalizeSetCookies(plan, signed, now);

    let persistence: CaptureResult["persistence"] = "none";
    if (plan.persist === "now" && plan.record && facts.deviceId) {
      schedulePersistence(ctx, adapters, plan.record, facts.deviceId, env, now, options);
      persistence = "scheduled";
    } else if (plan.persist === "awaiting-device-id") {
      persistence = "awaiting-device-id";
    }
    if (plan.forget && facts.deviceId) scheduleForget(ctx, adapters, facts.deviceId, env, now, options);

    const markPrivateCache = options.privateCacheOnSetCookie ?? true;
    const record = plan.record;
    return {
      skipped: null,
      consent,
      record,
      setCookies,
      changes: plan.changes,
      persistence,
      async apply(response: Response): Promise<Response> {
        try {
          let lines = setCookies;
          if (persistence === "awaiting-device-id" && record && plan.state) {
            // First visit: the origin (or OpenArt's Worker) mints oa_device_id on this very response.
            const minted = findSetCookieValue(responseSetCookies(response.headers), opts.deviceIdCookie);
            if (minted && DEVICE_ID_RE.test(minted)) {
              schedulePersistence(ctx, adapters, record, minted, env, now, options);
              // Remember it in the cookie (persisted-at + device binding), so the next request does not write again.
              const state = { ...plan.state, persistedAt: now, boundDevice: plan.state.boundDevice ?? minted };
              lines = finalizeSetCookies({ ...plan, state, emitAttr: true }, await signAttrState(state, secrets.current), now);
            }
          }
          return appendSetCookies(response, lines, markPrivateCache);
        } catch (err) {
          reportError(options, err, "apply");
          return response;
        }
      },
    };
  } catch (err) {
    reportError(options, err, "capture");
    return passThrough("error");
  }
}

type FetchHandler<E, C> = (request: Request, env: E, ctx: C) => Response | Promise<Response>;

/**
 * Wraps an existing Worker fetch handler. The handler receives the original request, runs
 * concurrently with capture, and its response is returned with the cookies added. Also
 * serves POST /api/attribution/handoff and GET /r/:token unless `handoff: false`.
 * Errors thrown by the handler itself propagate unchanged.
 */
export function withAttribution<E extends object, C extends WaitUntilContext>(
  handler: FetchHandler<E, C>,
  options: CaptureOptions = {},
): (request: Request, env: E, ctx: C) => Promise<Response> {
  return async (request, env, ctx) => {
    if (options.handoff !== false) {
      const handled = await handleHandoff(request, env, ctx, options).catch((err: unknown) => {
        reportError(options, err, "handoff");
        return null;
      });
      if (handled) return handled;
    }
    const capture = captureAttribution(request, env, ctx, options);
    const response = await handler(request, env, ctx);
    return (await capture).apply(response);
  };
}
