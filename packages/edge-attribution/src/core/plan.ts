// The pure decision function shared by the Worker (capture.ts, handoff.ts) and the edge-sim:
// given request facts, the verified cookie state and a consent decision, decide the new
// state, which cookies to set or expire, and whether to persist or forget. Crypto happens
// outside. "Changed" is always decided by comparing the final state with the stored one, so
// intermediate steps (re-imports, trimming) can never cause a write loop.
import { utf8Length } from "./base64url.js";
import {
  RANK,
  buildAdClidsCookie,
  formatTtclidCookie,
  isMetaFbclid,
  packFbc,
  parseAdClidsCookie,
  parseTtclidCookie,
  resolveClickIds,
  sameAdClids,
  unpackFbc,
  vaultCandidates,
} from "./clicks.js";
import type { ClickCandidate } from "./clicks.js";
import { encodeStatePayload } from "./codec.js";
import { consentFingerprint, consentSnapshot } from "./consent.js";
import { ATTR_PAIR_BUDGET, CLICK_KEYS, COOKIE, JAR_BUDGET_BYTES, TTL, UTM_FIELDS } from "./constants.js";
import type { ClickKey } from "./constants.js";
import { serializeSetCookie } from "./cookies.js";
import type { AttributionRecord, AttributionState, ClickIds, ConsentDecision, Touch, Utm } from "./model.js";
import { hostInDomain } from "./options.js";
import type { ResolvedCoreOptions } from "./options.js";
import type { RequestFacts } from "./parse.js";
import { toRecord } from "./record.js";

export interface VerifiedAttr {
  state: AttributionState;
  /** Verified with the previous secret: re-sign with the current one. */
  needsResign: boolean;
}

export interface PlanInput {
  facts: RequestFacts;
  existing: VerifiedAttr | null;
  /** An oa_attr cookie was present but failed verification (ignored). */
  existingInvalid: boolean;
  consent: ConsentDecision;
  opts: ResolvedCoreOptions;
  persistenceEnabled: boolean;
  /** Handoff redemption: a state to merge before anything else. */
  incoming?: AttributionState | null;
  /** Handoff redemption: the request itself is not a touch. */
  noTouch?: boolean;
}

export interface Plan {
  state: AttributionState | null;
  /** oa_attr must be (re)signed and set. */
  emitAttr: boolean;
  /** oa_attr must be deleted (consent mode "none"). */
  expireAttr: boolean;
  /** Set-Cookie lines other than oa_attr: purges first, then oa_ad_clids, _fbc, ttclid, __oppref. */
  cookies: string[];
  persist: "now" | "awaiting-device-id" | "no";
  /** Explicit withdrawal: delete the device-keyed record. */
  forget: boolean;
  record: AttributionRecord | null;
  /** Human-readable reasons, for logs and tests. */
  changes: string[];
  cookieDomain: string | null;
}

const PROJECTION_COOKIES = [COOKIE.adClids, COOKIE.fbc, COOKIE.ttclid, COOKIE.oppref] as const;
/** When the jar budget binds, skip the least important projections first. */
const JAR_DROP_ORDER = [COOKIE.oppref, COOKIE.ttclid, COOKIE.adClids, COOKIE.fbc] as const;

/** Keys evicted first when oa_attr would exceed its size budget. */
const EVICTION_ORDER: readonly ClickKey[] = [
  "epik", "sccid", "irclickid", "dclid", "twclid", "li_fat_id", "rdt_cid", "oppref",
  "wbraid", "gbraid", "msclkid", "ttclid", "fbclid", "gclid",
];

/** Room kept for fields that apply() may add once the origin mints a device id (pa, bd). */
const LATE_FIELDS_RESERVE = 96;

/** Bytes of the "oa_attr=1.<payload>.<43-char tag>" pair. */
export function attrPairBytes(payloadLength: number): number {
  return `${COOKIE.attr}=`.length + 2 + payloadLength + 1 + 43;
}

const ATTR_PAYLOAD_BUDGET = ATTR_PAIR_BUDGET - attrPairBytes(0) - LATE_FIELDS_RESERVE;

export function cookieDomainFor(host: string, opts: ResolvedCoreOptions): string | null {
  return hostInDomain(host, opts.cookieDomainRoot) ? opts.cookieDomain : null;
}

function expireCookie(name: string, domain: string | null, httpOnly = false): string {
  return serializeSetCookie(name, "", { domain, maxAgeSeconds: 0, httpOnly });
}

export function cloneState(s: AttributionState): AttributionState {
  return {
    ...s,
    firstTouch: cloneTouch(s.firstTouch),
    lastTouch: s.lastTouch ? cloneTouch(s.lastTouch) : null,
    clickIds: Object.fromEntries(Object.entries(s.clickIds).map(([k, e]) => [k, { ...e }])) as ClickIds,
  };
}

function cloneTouch(t: Touch): Touch {
  return { ...t, utm: t.utm ? { ...t.utm } : null, clickKeys: [...t.clickKeys] };
}

function hasAny(o: object): boolean {
  return Object.keys(o).length > 0;
}

/** Everything but persistedAt: what "changed" means. */
function contentKey(s: AttributionState): string {
  return encodeStatePayload({ ...s, persistedAt: null });
}

function touchKey(t: Touch | null): string {
  if (!t) return "null";
  const utm = t.utm ? UTM_FIELDS.map((f) => t.utm![f] ?? null) : null;
  return JSON.stringify([t.at, t.type, t.landingPath, t.referrerHost, t.inAppBrowser, t.seenBefore, t.recovered, t.clickKeys, utm]);
}

export function buildTouch(facts: RequestFacts, isFirst: boolean): Touch {
  let clicks = facts.clicks;
  let utm = facts.utm;
  let path = facts.path;
  let referrerHost = facts.referrer.kind === "external" ? facts.referrer.host : null;
  let recovered = false;
  if (!hasAny(clicks) && !utm && facts.recovered) {
    clicks = facts.recovered.clicks;
    utm = facts.recovered.utm;
    path = facts.recovered.path;
    referrerHost = null; // the original Referer of the landing is not knowable here
    recovered = true;
  }
  const clickKeys = CLICK_KEYS.filter((k) => clicks[k] !== undefined);
  const type = clickKeys.length ? "paid" : utm ? "campaign" : referrerHost ? "referral" : "direct";
  return {
    at: facts.now,
    type,
    utm: utm ? { ...utm } : null,
    clickKeys,
    referrerHost,
    landingPath: path,
    inAppBrowser: facts.inAppBrowser,
    seenBefore: isFirst && facts.deviceId !== null,
    recovered,
  };
}

function utmEqual(a: Utm | null, b: Utm | null): boolean {
  if (!a || !b) return a === b;
  return UTM_FIELDS.every((f) => a[f] === b[f]);
}

function sameTouch(a: Touch, b: Touch, ignoreReferrer: boolean): boolean {
  return (
    a.type === b.type &&
    a.landingPath === b.landingPath &&
    a.clickKeys.join(",") === b.clickKeys.join(",") &&
    utmEqual(a.utm, b.utm) &&
    (ignoreReferrer || a.referrerHost === b.referrerHost)
  );
}

/**
 * Whether this arrival becomes the last touch.
 * - A touch rebuilt from the Referer is a later page view of an earlier landing: it only
 *   counts when it matches neither the first nor the last touch (i.e. the landing was missed).
 * - A different arrival always counts; the same one (reload, back/forward) counts again only
 *   with a new click-id value or after 30 minutes.
 */
function replacesLastTouch(state: AttributionState, touch: Touch, now: number, newClickValue: boolean): boolean {
  const last = state.lastTouch;
  if (touch.recovered) {
    return !(last && sameTouch(last, touch, true)) && !sameTouch(state.firstTouch, touch, true);
  }
  if (!last || !sameTouch(last, touch, false)) return true;
  return newClickValue || now - last.at >= TTL.touchDedupeMs;
}

/**
 * Union of two states (handoff): earliest first touch, latest last touch, click ids resolved
 * over both. The device binding stays with `a` (the browser the result lives in).
 */
export function mergeStates(a: AttributionState, b: AttributionState, now: number): AttributionState {
  const firstTouch = b.firstTouch.at < a.firstTouch.at ? b.firstTouch : a.firstTouch;
  const lasts = [a.lastTouch, b.lastTouch].filter((t): t is Touch => t !== null);
  const lastTouch = lasts.length ? lasts.reduce((x, y) => (y.at > x.at ? y : x)) : null;
  return cloneState({
    createdAt: Math.min(a.createdAt, b.createdAt),
    firstTouch,
    lastTouch,
    clickIds: resolveClickIds([...vaultCandidates(a.clickIds, RANK.vault), ...vaultCandidates(b.clickIds, RANK.vault)], now),
    consentMode: a.consentMode === "full" && b.consentMode === "full" ? "full" : "utm-only",
    persistedAt: null,
    handoffFrom: b.handoffFrom ?? a.handoffFrom,
    boundDevice: a.boundDevice ?? null,
    consentKey: a.consentKey ?? null,
  });
}

/** Click ids already sitting in the browser's own cookies (OpenArt's JS vault and the vendor cookies). */
function cookieCandidates(facts: RequestFacts): ClickCandidate[] {
  const out: ClickCandidate[] = [];
  const parsed = parseAdClidsCookie(facts.cookies.get(COOKIE.adClids));
  if (parsed) for (const k of CLICK_KEYS) if (parsed.known[k]) out.push({ key: k, ...parsed.known[k]!, rank: RANK.cookie });
  const fbc = unpackFbc(facts.cookies.get(COOKIE.fbc));
  if (fbc) out.push({ key: "fbclid", v: fbc.payload, ts: fbc.creationTime, rank: RANK.cookie });
  const tt = facts.cookies.get(COOKIE.ttclid);
  if (tt) {
    const p = parseTtclidCookie(tt);
    out.push({ key: "ttclid", v: p.clickId, ts: p.observedAt ?? facts.now, rank: RANK.cookie });
  }
  const op = facts.cookies.get(COOKIE.oppref);
  if (op) out.push({ key: "oppref", v: op, ts: facts.now, rank: RANK.cookie });
  return out;
}

/** URL click ids always; Referer-recovered ones only fill platforms nothing else knows (never override). */
function requestCandidates(facts: RequestFacts, known: ReadonlySet<ClickKey>): ClickCandidate[] {
  const out: ClickCandidate[] = [];
  for (const k of CLICK_KEYS) {
    const v = facts.clicks[k];
    if (v) out.push({ key: k, v, ts: facts.now, rank: RANK.url });
    const r = facts.recovered?.clicks[k];
    if (r && !known.has(k)) out.push({ key: k, v: r, ts: facts.now, rank: RANK.referrer });
  }
  return out;
}

function truncate(s: string, n: number): string {
  const p = Array.from(s);
  return p.length > n ? p.slice(0, n).join("") : s;
}

function shrinkTouch(t: Touch, n: number): Touch {
  const utm = t.utm ? (Object.fromEntries(Object.entries(t.utm).map(([k, v]) => [k, truncate(v, n)])) as Utm) : null;
  return { ...t, utm, landingPath: t.landingPath.slice(0, n) || "/" };
}

function minimalTouch(t: Touch): Touch {
  return { ...t, utm: null, referrerHost: null, landingPath: "/" };
}

/** Keeps the signed cookie within its budget, dropping the least useful data first (deterministically). */
export function fitToBudget(state: AttributionState, protectedKeys: ReadonlySet<ClickKey>): { state: AttributionState; trimmed: boolean } {
  const fits = (s: AttributionState) => encodeStatePayload(s).length <= ATTR_PAYLOAD_BUDGET;
  if (fits(state)) return { state, trimmed: false };
  const s = cloneState(state);
  const evict = (keys: ClickKey[]) => {
    const order = [...keys].sort(
      (x, y) => s.clickIds[x]!.ts - s.clickIds[y]!.ts || EVICTION_ORDER.indexOf(x) - EVICTION_ORDER.indexOf(y),
    );
    for (const k of order) {
      if (fits(s)) return;
      delete s.clickIds[k];
    }
  };
  evict(CLICK_KEYS.filter((k) => s.clickIds[k] && !protectedKeys.has(k)));
  if (!fits(s)) {
    s.firstTouch = shrinkTouch(s.firstTouch, 64);
    if (s.lastTouch) s.lastTouch = shrinkTouch(s.lastTouch, 64);
  }
  evict(CLICK_KEYS.filter((k) => s.clickIds[k]));
  if (!fits(s)) {
    s.firstTouch = minimalTouch(s.firstTouch);
    if (s.lastTouch) s.lastTouch = minimalTouch(s.lastTouch);
  }
  return { state: s, trimmed: true };
}

interface Projection {
  name: string;
  line: string;
  pair: number;
  reason: string;
}

function projection(name: string, value: string, maxAgeSeconds: number, domain: string | null, reason: string): Projection {
  return { name, line: serializeSetCookie(name, value, { domain, maxAgeSeconds }), pair: utf8Length(`${name}=${value}`), reason };
}

function projections(state: AttributionState, facts: RequestFacts, opts: ResolvedCoreOptions, domain: string | null): Projection[] {
  const now = facts.now;
  const out: Projection[] = [];
  const secs = (ms: number) => ms / 1000;

  // oa_ad_clids: OpenArt's own format, merged with what the browser holds, unknown keys preserved.
  const current = parseAdClidsCookie(facts.cookies.get(COOKIE.adClids));
  const desired = buildAdClidsCookie(state.clickIds, current?.unknown ?? [], now);
  if (desired && !sameAdClids(desired.entries, current)) {
    out.push(projection(COOKIE.adClids, desired.value, secs(desired.newestTs + TTL.adClidsMs - now), domain, `cookie:${COOKIE.adClids}`));
  }

  // _fbc: set only when absent or holding a different fbclid; the same fbclid keeps its timestamp.
  const f = state.clickIds.fbclid;
  if (f && isMetaFbclid(f.v) && now - f.ts < TTL.fbcMs) {
    const existing = unpackFbc(facts.cookies.get(COOKIE.fbc));
    if (!existing || existing.payload !== f.v) {
      const reason = existing ? "fbc:replaced" : facts.cookies.has(COOKIE.fbc) ? "fbc:repaired" : "fbc:set";
      out.push(projection(COOKIE.fbc, packFbc(f.v, f.ts), secs(f.ts + TTL.fbcMs - now), domain, reason));
    }
  }

  // ttclid: TikTok's own <id>.<ms> format, so its pixel keeps (not overwrites) the long-lived copy.
  const t = state.clickIds.ttclid;
  if (t && now - t.ts < opts.ttclidTtlMs) {
    const cur = facts.cookies.get(COOKIE.ttclid);
    const value = formatTtclidCookie(t.v, t.ts);
    if (value && (!cur || parseTtclidCookie(cur).clickId !== t.v)) {
      out.push(projection(COOKIE.ttclid, value, secs(t.ts + opts.ttclidTtlMs - now), domain, `cookie:${COOKIE.ttclid}`));
    }
  }

  // __oppref: the raw value the OpenAI SDK falls back to when the URL has none.
  const o = state.clickIds.oppref;
  if (o && now - o.ts < TTL.opprefMs && facts.cookies.get(COOKIE.oppref) !== o.v) {
    out.push(projection(COOKIE.oppref, o.v, secs(o.ts + TTL.opprefMs - now), domain, `cookie:${COOKIE.oppref}`));
  }
  return out;
}

/**
 * Keeps everything this module stores in the browser (after this response) under 4 KB, so one
 * crafted link cannot bloat every later request's Cookie header. Skips the least important
 * projections this response would write; the browser keeps whatever it already had.
 */
function withinJarBudget(emitted: Projection[], attrPair: number, facts: RequestFacts, changes: string[]): string[] {
  const stored = (name: string) => {
    const v = facts.cookies.get(name);
    return v === undefined ? 0 : utf8Length(`${name}=${v}`);
  };
  let total = attrPair + PROJECTION_COOKIES.reduce((sum, n) => sum + (emitted.find((p) => p.name === n)?.pair ?? stored(n)), 0);
  const kept = [...emitted];
  for (const name of JAR_DROP_ORDER) {
    if (total <= JAR_BUDGET_BYTES) break;
    const i = kept.findIndex((p) => p.name === name);
    if (i === -1) continue;
    total -= kept[i]!.pair - stored(name);
    kept.splice(i, 1);
    changes.push(`budget:skipped:${name}`);
  }
  for (const p of kept) changes.push(p.reason);
  return kept.map((p) => p.line);
}

export function planCapture(input: PlanInput): Plan {
  const { facts, consent, opts } = input;
  const now = facts.now;
  const domain = cookieDomainFor(facts.host, opts);
  const changes: string[] = [];
  const cookies: string[] = [];
  if (input.existingInvalid) changes.push("attr:invalid-ignored");

  const purge = () => {
    let any = false;
    for (const name of PROJECTION_COOKIES) {
      if (facts.cookies.has(name)) {
        cookies.push(expireCookie(name, domain));
        changes.push(`purge:${name}`);
        any = true;
      }
    }
    return any;
  };

  // An explicit refusal withdraws what this module manages in the browser.
  const explicitRefusal = consent.explicit && consent.mode !== "full";
  const purged = explicitRefusal ? purge() : false;

  const existing = input.existing?.state ?? null;
  const hadIdentifiers = !!existing && (hasAny(existing.clickIds) || !!existing.boundDevice || !!existing.handoffFrom);
  const canForget = input.persistenceEnabled && explicitRefusal && facts.deviceId !== null;

  const empty = (expireAttr: boolean, forget: boolean): Plan => ({
    state: null,
    emitAttr: false,
    expireAttr,
    cookies,
    persist: "no",
    forget,
    record: null,
    changes,
    cookieDomain: domain,
  });

  if (consent.mode === "none") {
    const expireAttr = facts.cookies.has(COOKIE.attr);
    if (expireAttr) changes.push("attr:removed");
    const forget = canForget && (expireAttr || purged);
    if (forget) changes.push("persist:forget");
    return empty(expireAttr, forget);
  }
  const mode = consent.mode;

  let state: AttributionState | null = existing ? cloneState(existing) : null;
  if (input.existing?.needsResign) changes.push("attr:resigned");
  if (input.incoming) {
    // An adopted record is bound to this browser's device only once this browser shows one.
    state = state ? mergeStates(state, input.incoming, now) : { ...cloneState(input.incoming), boundDevice: null };
    changes.push("handoff:merged");
  }

  const touch = input.noTouch ? null : buildTouch(facts, state === null);
  if (!state) {
    if (!touch) return empty(false, false);
    state = {
      createdAt: now,
      firstTouch: touch,
      lastTouch: touch.type === "direct" ? null : touch,
      clickIds: {},
      consentMode: mode,
      persistedAt: null,
      handoffFrom: null,
      boundDevice: null,
      consentKey: null,
    };
  } else if (touch && touch.type !== "direct") {
    const vault = state.clickIds;
    const newClickValue = mode === "full" && touch.clickKeys.some((k) => facts.clicks[k] !== undefined && vault[k]?.v !== facts.clicks[k]);
    if (replacesLastTouch(state, touch, now, newClickValue)) state.lastTouch = touch;
  }

  const protectedKeys = new Set<ClickKey>(CLICK_KEYS.filter((k) => facts.clicks[k] || facts.recovered?.clicks[k]));
  if (mode === "utm-only") {
    // The signed store keeps no identifiers. Browser cookies are only removed on an explicit
    // refusal (above): without one they stay for the CMP/pixels to govern, and full mode can
    // re-import them later (e.g. a traveller back in an opt-out region).
    state.clickIds = {};
    state.handoffFrom = null; // device linkage is an identifier too
    state.boundDevice = null;
    state.consentMode = "utm-only";
  } else {
    const held = [...vaultCandidates(state.clickIds, RANK.vault), ...cookieCandidates(facts)];
    const known = new Set<ClickKey>(held.map((c) => c.key));
    state.clickIds = resolveClickIds([...held, ...requestCandidates(facts, known)], now);
    state.consentMode = "full";
    if (!state.boundDevice && facts.deviceId) state.boundDevice = facts.deviceId;
  }
  state.consentKey = consentFingerprint(consent);

  const fitted = fitToBudget(state, protectedKeys);
  state = fitted.state;

  // Change detection by content (never by intermediate flags).
  const changed = !existing || contentKey(state) !== contentKey(existing);
  if (!existing) {
    changes.push("first-touch");
    if (state.lastTouch) changes.push("last-touch");
  } else if (changed) {
    if (touchKey(state.lastTouch) !== touchKey(existing.lastTouch)) changes.push("last-touch");
    for (const k of CLICK_KEYS) {
      const a = state.clickIds[k];
      const b = existing.clickIds[k];
      if (a?.v !== b?.v || a?.ts !== b?.ts) changes.push(a ? `click:${k}` : `click-removed:${k}`);
    }
    if ((existing.consentKey ?? null) !== state.consentKey) changes.push("consent");
    if (fitted.trimmed) changes.push("budget:trimmed");
  }
  let emit = changed || !!input.existing?.needsResign;

  let persist: Plan["persist"] = "no";
  let forget = false;
  if (mode === "full") {
    const hasSignal = state.lastTouch !== null || hasAny(state.clickIds);
    const due = hasSignal && (changed || state.persistedAt === null || now - state.persistedAt >= TTL.kvRefreshMs);
    if (input.persistenceEnabled && due) {
      if (facts.deviceId) {
        if (!changed && state.persistedAt !== null) changes.push("persist:refresh");
        state.persistedAt = now;
        emit = true;
        persist = "now";
      } else {
        persist = "awaiting-device-id";
      }
    }
  } else if (canForget && (hadIdentifiers || purged)) {
    forget = true;
    changes.push("persist:forget");
  }

  const attrPair = emit ? attrPairBytes(encodeStatePayload(state).length) : utf8Length(`${COOKIE.attr}=${facts.cookies.get(COOKIE.attr) ?? ""}`);
  if (mode === "full") cookies.push(...withinJarBudget(projections(state, facts, opts, domain), attrPair, facts, changes));

  const record = toRecord(
    state,
    consentSnapshot(consent),
    now,
    mode === "full" ? facts.deviceId : null,
    mode === "full" ? facts.cookies.get(COOKIE.fbc) : undefined,
  );
  return { state, emitAttr: emit, expireAttr: false, cookies, persist, forget, record, changes, cookieDomain: domain };
}

export function attrSetCookie(signedValue: string, state: AttributionState, domain: string | null, now: number): string {
  return serializeSetCookie(COOKIE.attr, signedValue, {
    domain,
    maxAgeSeconds: (state.createdAt + TTL.attrMs - now) / 1000,
    httpOnly: true,
  });
}

/** Final Set-Cookie list for a plan: oa_attr (set or delete) first, then the rest. */
export function finalizeSetCookies(plan: Plan, signedAttr: string | null, now: number): string[] {
  const head: string[] = [];
  if (plan.emitAttr && plan.state && signedAttr) head.push(attrSetCookie(signedAttr, plan.state, plan.cookieDomain, now));
  else if (plan.expireAttr) head.push(expireCookie(COOKIE.attr, plan.cookieDomain, true));
  return [...head, ...plan.cookies];
}
