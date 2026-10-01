/**
 * The contract every platform sender implements. Builders are pure functions over an
 * EnrichedEvent: they never read clocks, secrets or the network, so dry-run output is
 * byte-for-byte what live mode would send (minus the auth header).
 */

import type { ConversionLedgerEvent, Platform, PlatformEventMappingRow } from '@openart-signal/contracts';
import type { PlatformConsentDecision } from '../adapters/consent-resolver.js';
import type { ServiceConfig } from '../config.js';
import type { EnrichedEvent, OutboxAction, ResolvedValue } from '../types.js';

export type SendConsent = Extract<PlatformConsentDecision, { send: true }>;

export interface EventBuildInput {
  event: EnrichedEvent;
  mapping: PlatformEventMappingRow;
  consent: SendConsent;
  config: ServiceConfig;
  /** mapping.dedup_key_template rendered for this row: the exact id the browser tag sends. */
  dedupKey: string;
  /** Page URL for web events (request context, else the configured canonical URL; never a query string). */
  eventSourceUrl: string;
}

export interface AdjustmentBuildInput {
  /** The refund or chargeback row, enriched (identity of the purchaser). */
  event: EnrichedEvent;
  /** The purchase row being adjusted. */
  original: ConversionLedgerEvent;
  /** Value the conversion should carry after the adjustment (major units, >= 0). */
  restatedValue: number;
  currency: string;
  /** Nothing of the original cash is left (full refund / chargeback). */
  full: boolean;
  consent: SendConsent;
  config: ServiceConfig;
}

export type MetaValue = string | number | boolean | null;

export type BuildResult =
  | { ok: true; item: Record<string, unknown>; batchKey: string; meta?: Record<string, MetaValue> }
  | { ok: false; reason: string };

export type AuthKind =
  | 'google_oauth'
  | 'meta_access_token'
  | 'tiktok_access_token'
  | 'reddit_bearer'
  | 'linkedin_bearer'
  | 'x_oauth1'
  | 'microsoft_uet_bearer'
  | 'microsoft_ads_api';

export interface PlatformRequest {
  platform: Platform;
  action: OutboxAction;
  method: 'POST';
  url: string;
  /** Non-secret headers only. The live transport adds authentication for `auth`. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  auth: AuthKind;
  /**
   * True when the platform only validates or test-routes the request (Google validateOnly, Meta and
   * TikTok test_event_code, Reddit test_id). A 2xx then means "validated", never "sent": the outbox
   * records `validated`, and adjustments never treat such a conversion as recorded.
   */
  validationOnly: boolean;
}

export type SendOutcome =
  | { kind: 'ok'; status: number; dryRun: boolean; detail?: unknown }
  /** auth = a credential or permission problem: retried until the send-by deadline without using up attempts. */
  | { kind: 'retry'; status: number | null; error: string; retryAfterMs?: number; auth?: boolean }
  | { kind: 'fail'; status: number | null; error: string };

export interface PlatformModule {
  platform: Platform;
  maxBatchSize: Partial<Record<OutboxAction, number>>;
  buildEvent(input: EventBuildInput): BuildResult;
  buildAdjustment?(input: AdjustmentBuildInput): BuildResult;
  /**
   * Replace the value fields of an item built earlier (a send held for its purchase-time value) with
   * `value`. The result must equal what buildEvent would produce with that value, key order included.
   */
  applyValue(item: Record<string, unknown>, value: ResolvedValue, config: ServiceConfig): Record<string, unknown>;
  buildRequest(action: OutboxAction, batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest;
  classifyResponse(status: number, body: unknown, retryAfterHeader: string | null): SendOutcome;
  /** JSON Schema (2020-12) of the request body per action, transcribed from the platform's docs (a list = alternative request shapes). */
  requestSchemas: Partial<Record<OutboxAction, object | object[]>>;
}

/**
 * Default HTTP classification: 2xx ok; 408/429/5xx retry (honouring Retry-After); 401/403 are
 * credential retries (an expired or revoked credential is systemic, so events wait for the fix
 * until their send-by deadline instead of being dead-lettered one by one); anything else fails.
 */
export function classifyHttp(status: number, body: unknown, retryAfterHeader: string | null): SendOutcome {
  if (status >= 200 && status < 300) return { kind: 'ok', status, dryRun: false, detail: body };
  const error = `HTTP ${status}: ${truncate(body)}`;
  if (status === 401 || status === 403) return credentialRetry(status, error);
  if (status === 408 || status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    return retryAfterMs === undefined ? { kind: 'retry', status, error } : { kind: 'retry', status, error, retryAfterMs };
  }
  return { kind: 'fail', status, error };
}

/** A credential or permission failure: retry (never dead-letter) so a fixed token resumes delivery. */
export function credentialRetry(status: number | null, error: string): SendOutcome {
  return { kind: 'retry', status, error, auth: true };
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export function truncate(body: unknown, max = 500): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Drop undefined/null properties (platforms reject explicit nulls for optional fields). */
export function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out as { [K in keyof T]?: NonNullable<T[K]> };
}

export const isIpv4 = (ip: string | null | undefined): ip is string => typeof ip === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
