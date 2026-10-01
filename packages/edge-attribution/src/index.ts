// @openart-signal/edge-attribution: public API.
export { captureAttribution, withAttribution } from "./capture.js";
export type { AttributionEnv, CaptureOptions, CaptureResult, CaptureSkip, WaitUntilContext } from "./capture.js";

export { handleHandoff, handoffKvKey, sanitizeHandoffTarget, sanitizeTargetPath } from "./handoff.js";
export type { HandoffOptions, HandoffTarget } from "./handoff.js";

export { kvPersistence, originEndpointPersistence, verifyOriginSignature } from "./persistence.js";
export type { AttributionPersistence, ForgetInput, KVNamespaceLike, KvPersistenceOptions, OriginEndpointOptions, PersistInput } from "./persistence.js";

export { mergeAttributionForSignup } from "./merge.js";
export type { SignupMergeInput, SignupMergeResult } from "./merge.js";

export { readSecrets, signAttrState, verifyAttrCookie } from "./crypto.js";

export {
  REGULATED_COUNTRIES,
  US_PRIVACY_COOKIE,
  createDefaultConsentPolicy,
  parseConsentModeCookie,
  parseCookiebotCookie,
  parseOneTrustCookie,
  parseUsPrivacyString,
  readOptOutSaleSharing,
} from "./core/consent.js";
export type { ConsentContext, ConsentPolicy, DefaultConsentPolicyOptions } from "./core/consent.js";

export { CONTRACT_CLICK_KEYS, buildAdClickIdsPayload, consentPayload, toClickIdStoreRecordExtended } from "./core/record.js";
export type { AdClickIdsPayload, ClickIdStoreRecordExtended, ConsentPayload, TouchPayload } from "./core/record.js";

export { CLICK_KEYS, COOKIE, TTL } from "./core/constants.js";
export type { ClickKey } from "./core/constants.js";
export type {
  AttributionRecord,
  AttributionState,
  ClickIdEntry,
  ClickIds,
  ConsentDecision,
  ConsentMode,
  ConsentSignals,
  ConsentSnapshot,
  Touch,
  TouchType,
  Utm,
} from "./core/model.js";
