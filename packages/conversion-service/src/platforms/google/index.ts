/**
 * Google Ads via the Data Manager API (IngestEvents).
 *
 * Purchases reuse the browser tag's order id as transactionId (sub_<invoiceId>), so within
 * the same conversion action multi-source matching OVERRIDES the tag's value with ours
 * "in reporting and bidding, without incrementing the conversion count" (send-events guide).
 * The first 14 days of a conversion action are a trial with value updates disabled, and the
 * events overview's page summary calls multi-source "allowlist-only" — the dispatcher holds
 * tag-twin rows until GOOGLE_MULTI_SOURCE_CONFIRMED=true.
 *
 * Refunds/chargebacks: the Data Manager API supports only RESTATEMENT (same transactionId +
 * same conversion action + new conversionValue; "You don't need to specify an adjustment
 * type") and user-data supplementation. It "doesn't support conversion retractions … the
 * conversion count will remain the same". Retraction exists only in the Google Ads API
 * (ConversionAdjustmentUploadService, adjustment_type RETRACTION), whose availability to new
 * adopters after the 2026-06-15 offline-import cutoff is undocumented. So the implemented
 * path is a Data Manager restatement behind GOOGLE_ADJUSTMENTS=data_manager_restatement.
 */

import type { ServiceConfig } from '../../config.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact } from '../types.js';
import type { AdjustmentBuildInput, BuildResult, EventBuildInput, PlatformModule, PlatformRequest } from '../types.js';
import schema from './ingest-events.schema.json' with { type: 'json' };

export const GOOGLE_INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';
export const GOOGLE_DATAMANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';

function destinationKey(config: ServiceConfig, conversionActionId: string): string {
  return `${config.google.operatingAccountId}:${conversionActionId}`;
}

function customerType(input: EventBuildInput): 'NEW' | 'RETURNING' | 'REENGAGED' | null {
  const row = input.event.row;
  if (row.cash_value_minor === null || row.order_id === null) return null;
  if (row.event_name === 'purchase_first' || row.event_name === 'purchase_one_time_pack') {
    return row.is_first_purchase ? 'NEW' : 'REENGAGED';
  }
  return 'RETURNING';
}

function userData(input: { event: EventBuildInput['event'] }): Record<string, unknown> | undefined {
  const ids: Array<Record<string, string>> = [];
  const email = input.event.identity.email.google_ads;
  const phone = input.event.identity.phone.google_ads;
  if (email) ids.push({ emailAddress: email });
  if (phone) ids.push({ phoneNumber: phone });
  return ids.length > 0 ? { userIdentifiers: ids } : undefined;
}

function adIdentifiers(input: { event: EventBuildInput['event'] }): Record<string, string> | undefined {
  const c = input.event.row.click_ids;
  const out = compact({ gclid: c.gclid?.value, gbraid: c.gbraid?.value, wbraid: c.wbraid?.value });
  return Object.keys(out).length > 0 ? out : undefined;
}

function deviceInfo(input: { event: EventBuildInput['event'] }): Record<string, string> | undefined {
  const ctx = input.event.context;
  const out = compact({ userAgent: ctx.client_user_agent ?? undefined, ipAddress: ctx.client_ip_address ?? undefined });
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Replace conversionValue/currency in place (they are always built together). */
function withValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
  return { ...item, conversionValue: value.value, currency: value.currency };
}

export const googleAds: PlatformModule = {
  platform: 'google_ads',
  maxBatchSize: { SEND: 2000, ADJUST: 2000 },
  requestSchemas: { SEND: schema, ADJUST: schema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { config, event } = input;
    const action = config.google.conversionActions[event.row.event_name];
    if (!config.google.operatingAccountId || !action) return { ok: false, reason: 'destination_not_configured' };
    const ad = adIdentifiers(input);
    const ud = userData(input);
    const device = deviceInfo(input);
    if (!ad && !ud && !device?.ipAddress) return { ok: false, reason: 'no_match_keys' };
    const type = customerType(input);
    const item = compact({
      transactionId: input.dedupKey,
      eventTimestamp: event.row.occurred_at,
      eventSource: 'WEB',
      conversionValue: event.value?.value,
      currency: event.value?.currency,
      adIdentifiers: ad,
      userData: ud,
      eventDeviceInfo: device,
      consent: input.consent.google ?? undefined,
      userProperties: type ? { customerType: type } : undefined,
    });
    return { ok: true, item, batchKey: destinationKey(config, action), meta: { conversion_action: action } };
  },

  buildAdjustment(input: AdjustmentBuildInput): BuildResult {
    const { config, original } = input;
    const action = config.google.conversionActions[original.event_name];
    if (!config.google.operatingAccountId || !action) return { ok: false, reason: 'destination_not_configured' };
    if (!original.order_id) return { ok: false, reason: 'original_without_order_id' };
    // Only value/currency (and missing user data) are applied to a matched conversion; identifiers are
    // included so the event is valid under the send-events identifier rule.
    const ud = userData(input);
    const ad = adIdentifiers(input);
    if (!ud && !ad) return { ok: false, reason: 'no_match_keys' };
    const item = compact({
      transactionId: original.order_id,
      eventTimestamp: original.occurred_at,
      conversionValue: input.restatedValue,
      currency: input.currency,
      adIdentifiers: ad,
      userData: ud,
      consent: input.consent.google ?? undefined,
    });
    return { ok: true, item, batchKey: destinationKey(config, action), meta: { conversion_action: action, restated_value: input.restatedValue } };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    return withValue(item, value);
  },

  buildRequest(action: OutboxAction, batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest {
    const [operatingAccountId, conversionActionId] = batchKey.split(':') as [string, string];
    const destination = compact({
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: operatingAccountId },
      loginAccount: config.google.loginAccountId ? { accountType: 'GOOGLE_ADS', accountId: config.google.loginAccountId } : undefined,
      productDestinationId: conversionActionId,
    });
    return {
      platform: 'google_ads',
      action,
      method: 'POST',
      url: GOOGLE_INGEST_URL,
      headers: { 'Content-Type': 'application/json' },
      body: { destinations: [destination], encoding: 'HEX', events: items, validateOnly: config.google.validateOnly },
      auth: 'google_oauth',
      validationOnly: config.google.validateOnly,
    };
  },

  classifyResponse: classifyHttp,
};
