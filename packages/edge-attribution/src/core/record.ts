// The exported record and the extended /api/user/ad-click-ids payload built from it.
import { formatFbc, isMetaFbclid, packFbc, unpackFbc } from "./clicks.js";
import { CLICK_KEYS, TTL } from "./constants.js";
import type { ClickKey } from "./constants.js";
import type { AttributionRecord, AttributionState, ClickIds, ConsentSnapshot, Touch, Utm } from "./model.js";

/** The `_fbc` value for the vault's fbclid: the browser's own cookie when it holds the same fbclid, else a minted one. */
export function deriveFbc(ids: ClickIds, existingCookie: string | undefined, now: number): string | null {
  const f = ids.fbclid;
  if (!f || !isMetaFbclid(f.v) || now - f.ts >= TTL.fbcMs) return null;
  const existing = unpackFbc(existingCookie);
  return existing && existing.payload === f.v ? formatFbc(existing) : packFbc(f.v, f.ts);
}

export function toRecord(
  state: AttributionState,
  consent: ConsentSnapshot,
  now: number,
  deviceId: string | null,
  existingFbcCookie?: string,
): AttributionRecord {
  return {
    schema: "oa_attr/1",
    createdAt: state.createdAt,
    expiresAt: state.createdAt + TTL.attrMs,
    updatedAt: now,
    firstTouch: state.firstTouch,
    lastTouch: state.lastTouch,
    clickIds: state.clickIds,
    fbc: deriveFbc(state.clickIds, existingFbcCookie, now),
    consent,
    deviceId,
    handoffFrom: state.handoffFrom,
  };
}

export interface TouchPayload {
  at: number;
  type: Touch["type"];
  utm: Utm | null;
  click_keys: ClickKey[];
  referrer_host: string | null;
  landing_path: string;
  in_app_browser: string | null;
  seen_before: boolean;
  recovered: boolean;
}

/**
 * Backward-compatible extension of what the Suite POSTs to /api/user/ad-click-ids today
 * ({gclid, gclid_created_at, fbclid, …, ttclid_created_at}, 02 §3.3): the same `<key>` /
 * `<key>_created_at` (ms) pairs for all 14 platforms, plus `fbc`, `device_id` and an
 * `attribution` object. Unknown fields are additive, so the existing handler can ignore them.
 */
/** The consent snapshot as the backend receives it: snake_case, `opt_out_sale_sharing` as packages/contracts names it. */
export interface ConsentPayload {
  mode: ConsentSnapshot["mode"];
  region: ConsentSnapshot["region"];
  explicit: boolean;
  gpc: boolean;
  opt_out_sale_sharing: boolean;
  signals: ConsentSnapshot["signals"];
}

export function consentPayload(c: ConsentSnapshot): ConsentPayload {
  return { mode: c.mode, region: c.region, explicit: c.explicit, gpc: c.gpc, opt_out_sale_sharing: c.optOutSaleSharing === true, signals: { ...c.signals } };
}

export type AdClickIdsPayload = { [K in ClickKey]?: string } & { [K in `${ClickKey}_created_at`]?: number } & {
  fbc?: string;
  device_id?: string;
  attribution: {
    schema: "oa_attr/1";
    source: "edge";
    created_at: number;
    expires_at: number;
    updated_at: number;
    first_touch: TouchPayload;
    last_touch: TouchPayload | null;
    consent: ConsentPayload;
    handoff_from: string | null;
  };
};

export function touchPayload(t: Touch): TouchPayload {
  return {
    at: t.at,
    type: t.type,
    utm: t.utm,
    click_keys: [...t.clickKeys],
    referrer_host: t.referrerHost,
    landing_path: t.landingPath,
    in_app_browser: t.inAppBrowser,
    seen_before: t.seenBefore,
    recovered: t.recovered,
  };
}

/** Click-id keys of the shared contract (packages/contracts CLICK_ID_KEYS_EXTENDED). */
export const CONTRACT_CLICK_KEYS = ["gclid", "fbclid", "msclkid", "ttclid", "gbraid", "wbraid", "rdt_cid", "twclid", "li_fat_id", "oppref"] as const;
type ContractClickKey = (typeof CONTRACT_CLICK_KEYS)[number];
const CONTRACT_VALUE_RE = /^[A-Za-z0-9._-]{1,1000}$/;

/**
 * packages/contracts `ClickIdStoreRecordExtended`: the flat user store record that
 * conversion-service reads (`clickIdsFromStoreRecord`, `utmFromStoreRecord`). Mirrored here so
 * the Worker bundle does not depend on the contracts package; test/node/contracts.test.ts
 * validates it against the shared strict schema.
 */
export type ClickIdStoreRecordExtended = { [K in ContractClickKey]?: string } & { [K in `${ContractClickKey}_created_at`]?: number } & {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  utm_id?: string;
  landing_url?: string;
  referrer?: string;
  context_captured_at?: number;
};

/**
 * The record in the shared contract shape: the 10 contract click keys (others such as epik stay
 * in the richer payload), and the context of the last marketing touch (else the first touch).
 */
export function toClickIdStoreRecordExtended(record: AttributionRecord, options: { origin?: string } = {}): ClickIdStoreRecordExtended {
  const out: Record<string, string | number> = {};
  for (const key of CONTRACT_CLICK_KEYS) {
    const e = record.clickIds[key];
    if (e && CONTRACT_VALUE_RE.test(e.v)) {
      out[key] = e.v;
      out[`${key}_created_at`] = e.ts;
    }
  }
  const touch = record.lastTouch ?? record.firstTouch;
  if (touch.utm) for (const [field, value] of Object.entries(touch.utm)) if (value) out[`utm_${field}`] = value;
  out.landing_url = new URL(touch.landingPath, options.origin ?? "https://openart.ai").toString();
  if (touch.referrerHost) out.referrer = `https://${touch.referrerHost}/`;
  out.context_captured_at = touch.at;
  return out as ClickIdStoreRecordExtended;
}

export function buildAdClickIdsPayload(record: AttributionRecord): AdClickIdsPayload {
  const out: Record<string, unknown> = {};
  if (record.deviceId) out.device_id = record.deviceId;
  for (const key of CLICK_KEYS) {
    const e = record.clickIds[key];
    if (!e) continue;
    out[key] = e.v;
    out[`${key}_created_at`] = e.ts;
  }
  if (record.fbc) out.fbc = record.fbc;
  out.attribution = {
    schema: record.schema,
    source: "edge",
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    updated_at: record.updatedAt,
    first_touch: touchPayload(record.firstTouch),
    last_touch: record.lastTouch ? touchPayload(record.lastTouch) : null,
    consent: consentPayload(record.consent),
    handoff_from: record.handoffFrom,
  };
  return out as AdClickIdsPayload;
}
