/**
 * Send windows and hold gates.
 *
 * Windows (per platform, checked when a record is enqueued AND again right before sending):
 *   max age        the contracts mapping's max_event_age_days (google 90, meta 7, reddit 7,
 *                  linkedin 90, microsoft 7); TikTok and X publish none for web events, so a
 *                  conservative 7 days is used (unverified).
 *   twin window    rows whose browser twin exists must reach the platform while the platform
 *                  still dedupes, or they double count: Meta 48 h ("within 48 hours"), TikTok 48 h,
 *                  Reddit 2 days ("within two days"), X 48 h. Google dedupes on transactionId with no
 *                  window, but a multi-source value override only reaches bidding within 7 days and
 *                  Google advises against backfilling values, so Google twins get 7 days (research/12
 *                  correction 6). LinkedIn and Microsoft document no window.
 *   adjustments    Google: not before 24 h after the original ("upload conversion adjustments at least
 *                  24 hours after the original conversion"), at most 54 days (Help 7686280; the FAQ says
 *                  55); only the first 7 days reach bidding. Microsoft: 90 days (offline adjustment rule;
 *                  the online window is undocumented).
 *
 * Gates (hold, then release or drop):
 *   web_fix              contracts rows flagged requires_web_fix: the browser twin sends no usable id yet.
 *                        Released for events at/after WEB_FIXES_LIVE's effective time; earlier events are
 *                        dropped, because their browser copy can never dedupe.
 *   google_multi_source  Google rows that override a tag conversion: held until the multi-source
 *                        allowlist / trial is confirmed with Google.
 *   reddit_dedup         any Reddit row with a browser twin: held until Reddit's dedup log confirms the
 *                        conversion_id encoding.
 */

import type { PlatformEventMappingRow, Platform } from '@openart-signal/contracts';
import type { ServiceConfig } from '../config.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../time.js';
import type { HoldGate } from '../types.js';

const UNPUBLISHED_MAX_AGE_MS: Partial<Record<Platform, number>> = {
  tiktok: 7 * DAY_MS,
  x: 7 * DAY_MS,
};

const TWIN_WINDOW_MS: Partial<Record<Platform, number>> = {
  google_ads: 7 * DAY_MS,
  meta: 48 * HOUR_MS,
  tiktok: 48 * HOUR_MS,
  reddit: 48 * HOUR_MS,
  x: 48 * HOUR_MS,
};

export const MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;

export const GOOGLE_ADJUSTMENT = { notBeforeMs: 24 * HOUR_MS, maxAgeMs: 54 * DAY_MS, biddingWindowMs: 7 * DAY_MS } as const;
export const MICROSOFT_ADJUSTMENT = { maxAgeMs: 90 * DAY_MS } as const;

export interface SendWindow {
  maxAgeMs: number;
  /** Set when a browser twin exists and the server copy is only useful (deduped / bid on) within a window. */
  twinWindowMs: number | null;
  /** occurred + min(maxAge, twinWindow). */
  deadlineMs: number;
}

export function sendWindow(platform: Platform, mapping: PlatformEventMappingRow, occurredMs: number, config?: ServiceConfig): SendWindow {
  // Microsoft offline conversion import accepts ConversionTime 'within the last 90 days'.
  const offlineMicrosoft = platform === 'microsoft' && config?.microsoft.sendMode === 'offline_conversions';
  const maxAgeMs = offlineMicrosoft
    ? MICROSOFT_ADJUSTMENT.maxAgeMs
    : mapping.max_event_age_days !== null
      ? mapping.max_event_age_days * DAY_MS
      : (UNPUBLISHED_MAX_AGE_MS[platform] ?? 7 * DAY_MS);
  const twinWindowMs = mapping.browser_twin !== null ? (TWIN_WINDOW_MS[platform] ?? null) : null;
  return { maxAgeMs, twinWindowMs, deadlineMs: occurredMs + Math.min(maxAgeMs, twinWindowMs ?? Number.POSITIVE_INFINITY) };
}

/** Gates that apply to a (canonical event, platform) mapping row, in evaluation order. */
export function gatesFor(platform: Platform, mapping: PlatformEventMappingRow): HoldGate[] {
  const gates: HoldGate[] = [];
  if (mapping.requires_web_fix) gates.push('web_fix');
  if (platform === 'google_ads' && mapping.status === 'twin_observed') gates.push('google_multi_source');
  if (platform === 'reddit' && mapping.browser_twin !== null) gates.push('reddit_dedup');
  return gates;
}

export type GateVerdict = { kind: 'release' } | { kind: 'hold'; gate: HoldGate } | { kind: 'drop'; reason: string };

export function evaluateGates(gates: HoldGate[], key: { event: string; platform: Platform; occurredMs: number }, config: ServiceConfig): GateVerdict {
  for (const gate of gates) {
    if (gate === 'web_fix') {
      const liveAt = config.webFixesLive.get(`${key.event}:${key.platform}`);
      if (liveAt === undefined) return { kind: 'hold', gate };
      if (key.occurredMs < liveAt) return { kind: 'drop', reason: 'predates_web_fix' };
    } else if (gate === 'google_multi_source') {
      if (!config.google.multiSourceConfirmed) return { kind: 'hold', gate };
    } else if (gate === 'reddit_dedup') {
      if (!config.reddit.dedupVerified) return { kind: 'hold', gate };
    }
  }
  return { kind: 'release' };
}
