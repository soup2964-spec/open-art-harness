// Merge-at-signup: the reference implementation of what OpenArt's backend does when an account
// is created (see README "Backend change"). Pure and order-independent, so it can be ported
// line by line to the backend's language and tested against the same cases.
import { RANK, isMetaFbclid, packFbc, resolveClickIds, unpackFbc, vaultCandidates } from "./core/clicks.js";
import { TTL } from "./core/constants.js";
import type { AttributionRecord, ClickIds, ConsentSnapshot, Touch } from "./core/model.js";
import { buildAdClickIdsPayload, toClickIdStoreRecordExtended } from "./core/record.js";
import type { AdClickIdsPayload, ClickIdStoreRecordExtended } from "./core/record.js";

export interface SignupMergeInput {
  /** Attribution already on the user record. Its first touch is never replaced. */
  existing?: AttributionRecord | null;
  /**
   * The `oa_attr` cookie on the signup request, verified with ATTRIBUTION_SECRET. It is the only
   * input nobody can forge, so when present it decides which device records belong to this browser.
   */
  cookie?: AttributionRecord | null;
  /**
   * Device-store records (KV `dev:<id>` or the backend table) for the request's oa_device_id and
   * for the cookie's `handoffFrom` device. Device ids are client-held, so with a cookie present
   * only records of the same lineage (same createdAt, which only the edge sets) or of the device
   * the signed cookie names in `handoffFrom` are merged. Without a cookie, all are used.
   */
  records: ReadonlyArray<AttributionRecord | null | undefined>;
  /** Account creation time (ms). Anything observed later is ignored. */
  signupAt: number;
  /** Consent that applies at signup; "utm-only" strips every identifier. Default: most restrictive of the inputs. */
  consentMode?: "full" | "utm-only";
  /** Device the signup happened on. Default: the most recently updated record's. */
  deviceId?: string | null;
}

export interface SignupMergeResult {
  record: AttributionRecord | null;
  /** The same data in the extended /api/user/ad-click-ids shape, ready for the existing storage code. */
  payload: AdClickIdsPayload | null;
  /** The user store record in the shared contract shape (packages/contracts ClickIdStoreRecordExtended). */
  storeRecord: ClickIdStoreRecordExtended | null;
}

function touchKey(t: Touch): string {
  return JSON.stringify([t.at, t.type, t.landingPath, t.referrerHost, t.utm, t.clickKeys, t.inAppBrowser]);
}

/** Earliest (or latest) touch with a deterministic tie-break, so input order never matters. */
function pick(touches: Touch[], latest: boolean): Touch | null {
  let best: Touch | null = null;
  for (const t of touches) {
    if (!best) best = t;
    else if (latest ? t.at > best.at : t.at < best.at) best = t;
    else if (t.at === best.at && touchKey(t) < touchKey(best)) best = t;
  }
  return best;
}

export function mergeAttributionForSignup(input: SignupMergeInput): SignupMergeResult {
  const cutoff = input.signupAt;
  const cookie = input.cookie && input.cookie.createdAt <= cutoff ? input.cookie : null;
  const belongs = (r: AttributionRecord) =>
    !cookie || r.createdAt === cookie.createdAt || (cookie.handoffFrom !== null && r.deviceId === cookie.handoffFrom);
  const device = input.records.filter((r): r is AttributionRecord => !!r && r.createdAt <= cutoff && belongs(r));
  const records = cookie ? [cookie, ...device] : device;
  const all = input.existing ? [input.existing, ...records] : records;
  if (all.length === 0) return { record: null, payload: null, storeRecord: null };

  // First touch: immutable once stored on the user; otherwise the earliest seen anywhere.
  const firstTouch = input.existing?.firstTouch ?? pick(records.map((r) => r.firstTouch).filter((t) => t.at <= cutoff), false);
  if (!firstTouch) return { record: null, payload: null, storeRecord: null };

  // Last touch: latest non-direct touch at or before signup (first touches count too).
  const lastCandidates = all
    .flatMap((r) => [r.lastTouch, r.firstTouch])
    .filter((t): t is Touch => !!t && t.type !== "direct" && t.at <= cutoff);
  const lastTouch = pick(lastCandidates, true);

  // Newest first, ties broken by device id, so the result never depends on input order.
  const newestFirst = [...all].sort((a, b) => b.updatedAt - a.updatedAt || (a.deviceId ?? "").localeCompare(b.deviceId ?? ""));
  const latest = newestFirst[0]!;
  const mode = input.consentMode ?? (all.every((r) => r.consent.mode === "full") ? "full" : "utm-only");

  let clickIds: ClickIds = {};
  let fbc: string | null = null;
  if (mode === "full") {
    const candidates = all.flatMap((r) =>
      vaultCandidates(r.clickIds, RANK.vault).filter((c) => c.ts <= cutoff),
    );
    clickIds = resolveClickIds(candidates, cutoff);
    const f = clickIds.fbclid;
    if (f && isMetaFbclid(f.v) && cutoff - f.ts < TTL.fbcMs) {
      // Prefer a browser-set value for the same fbclid (it may carry an appendix or another index).
      const seen = all.map((r) => r.fbc).find((v) => v && unpackFbc(v)?.payload === f.v);
      fbc = seen ?? packFbc(f.v, f.ts);
    }
  }

  const createdAt = Math.min(...all.map((r) => r.createdAt));
  const consent: ConsentSnapshot = { ...latest.consent, mode };
  const handoffFrom = mode === "full" ? (newestFirst.find((r) => r.handoffFrom)?.handoffFrom ?? null) : null;
  const record: AttributionRecord = {
    schema: "oa_attr/1",
    createdAt,
    expiresAt: createdAt + TTL.attrMs,
    updatedAt: Math.max(...all.map((r) => r.updatedAt)),
    firstTouch,
    lastTouch,
    clickIds,
    fbc,
    consent,
    deviceId: input.deviceId ?? latest.deviceId,
    handoffFrom,
  };
  return { record, payload: buildAdClickIdsPayload(record), storeRecord: toClickIdStoreRecordExtended(record) };
}
