// The attribution data model. One shape is used everywhere: in memory, in the KV record,
// in the origin-endpoint payload (snake_cased) and, compacted by codec.ts, in the cookie.
import type { ClickKey, UtmField } from "./constants.js";

export type { ClickKey } from "./constants.js";

export type Utm = Partial<Record<UtmField, string>>;

export type TouchType = "paid" | "campaign" | "referral" | "direct";

/** One arrival on the site. Click-id VALUES are not stored per touch; see `clickIds`. */
export interface Touch {
  /** ms epoch */
  at: number;
  /** paid = click id present; campaign = utm only; referral = external Referer; direct = none. */
  type: TouchType;
  utm: Utm | null;
  /** Which platforms' click ids arrived on this touch (canonical order). Kept even without ad consent: keys identify no one. */
  clickKeys: ClickKey[];
  /** External Referer host (never the full URL). */
  referrerHost: string | null;
  /** Landing pathname (never the query string). */
  landingPath: string;
  /** Detected in-app browser (instagram, tiktok, facebook, ...). */
  inAppBrowser: string | null;
  /** The visitor already carried oa_device_id when first observed: this first touch is left-censored. */
  seenBefore: boolean;
  /** Rebuilt from a same-origin Referer because the landing itself was not processed. */
  recovered: boolean;
}

/** Same shape as an `oa_ad_clids` entry: value + first-observed ms timestamp. */
export interface ClickIdEntry {
  v: string;
  ts: number;
}

export type ClickIds = Partial<Record<ClickKey, ClickIdEntry>>;

export type ConsentMode = "full" | "utm-only" | "none";
export type ConsentValue = "granted" | "denied";
export interface ConsentSignals {
  ad_storage?: ConsentValue;
  analytics_storage?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
}
export type ConsentRegion = "regulated" | "unregulated" | "unknown";

export interface ConsentDecision {
  /** full: click ids + advertising cookies; utm-only: non-identifying fields only; none: store nothing. */
  mode: ConsentMode;
  region: ConsentRegion;
  /** Based on an explicit CMP choice (as opposed to a regional default). */
  explicit: boolean;
  /** Sec-GPC: 1 was sent. */
  gpc: boolean;
  /**
   * A US "do not sell or share" opt-out was recorded (oa_consent opt_out_sale_sharing, IAB
   * usprivacy): packages/contracts Consent.opt_out_sale_sharing. Optional for policies written
   * before it existed; normalizeDecision() makes it a boolean.
   */
  optOutSaleSharing?: boolean;
  /** Consent Mode signals as read from the CMP cookie, for server-side propagation. */
  signals: ConsentSignals;
  reason: string;
}

/** Consent recorded alongside the data it governed. */
export type ConsentSnapshot = Omit<ConsentDecision, "reason">;

/** What the edge keeps per browser (and signs into `oa_attr`). */
export interface AttributionState {
  createdAt: number;
  firstTouch: Touch;
  /** Last non-direct touch. */
  lastTouch: Touch | null;
  /** Latest value per platform, each with the time it was first observed; pruned after 90 days. */
  clickIds: ClickIds;
  /** Consent mode the current contents were written under. */
  consentMode: Exclude<ConsentMode, "none">;
  /** When the record was last handed to persistence (null = never / pending a device id). */
  persistedAt: number | null;
  /** oa_device_id of the in-app-browser session this record was handed off from. */
  handoffFrom: string | null;
  /**
   * The oa_device_id this record was first seen with (full consent only). Device ids are
   * client-held; binding one inside the signed cookie is what lets a handoff name its source
   * device without trusting a forged Cookie header.
   */
  boundDevice?: string | null;
  /** Fingerprint of the consent decision the contents were written under (a change triggers persistence). */
  consentKey?: string | null;
}

/** The persisted/exported record (KV value, origin payload source, capture result). */
export interface AttributionRecord {
  schema: "oa_attr/1";
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  firstTouch: Touch;
  lastTouch: Touch | null;
  clickIds: ClickIds;
  /** Meta click id in `fb.1.<ms>.<fbclid>` form (the `_fbc` value), or null. */
  fbc: string | null;
  consent: ConsentSnapshot;
  deviceId: string | null;
  handoffFrom: string | null;
}
