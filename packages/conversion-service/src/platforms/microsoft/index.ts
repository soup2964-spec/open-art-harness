/**
 * Microsoft Advertising.
 *  SEND   UET Conversions API (staged rollout: "Not everyone has this feature yet"). Dedup needs
 *         the same tagId + eventId + eventName as the UET tag; the tag's purchase call carries
 *         transaction_id but no event id today, so the purchase twin is held until web-fixes adds it.
 *         Alternative (MICROSOFT_SEND_MODE=offline_conversions): ApplyOfflineConversions for the
 *         server-only goals (renewals, add-ons, packs, leads). Offline imports never dedupe against
 *         UET tag conversions, so rows with a browser twin are skipped in that mode.
 *  ADJUST OnlineConversionAdjustment keyed on TransactionId (sub_<invoiceId>, which the UET tag
 *         already sends): Restate for a partial refund, Retract for a full refund or chargeback.
 *         Behind MICROSOFT_ADJUSTMENTS=online_conversion_adjustments (needs Ads API credentials).
 */

import type { ServiceConfig } from '../../config.js';
import { roundMajor } from '../../money.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact, truncate } from '../types.js';
import type { AdjustmentBuildInput, BuildResult, EventBuildInput, PlatformModule, PlatformRequest, SendOutcome } from '../types.js';
import offlineSchema from './offline-conversions.schema.json' with { type: 'json' };
import adjustmentsSchema from './online-conversion-adjustments.schema.json' with { type: 'json' };
import eventsSchema from './uet-events.schema.json' with { type: 'json' };

export function uetEventsUrl(tagId: string): string {
  return `https://capi.uet.microsoft.com/v1/${tagId}/events`;
}

export const MICROSOFT_ADJUSTMENTS_URL = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OnlineConversionAdjustments/Apply';
export const MICROSOFT_OFFLINE_CONVERSIONS_URL = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply';

const MSCLKID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

/** ApplyOfflineConversions item for a server-only goal (enhanced conversions: hashed email/phone or MSCLKID). */
function buildOffline(input: EventBuildInput, msclkid: string | undefined): BuildResult {
  const { event, mapping, config } = input;
  if (mapping.browser_twin !== null) return { ok: false, reason: 'offline_import_cannot_dedupe_with_uet_tag' };
  const goal = config.microsoft.conversionGoals[event.row.event_name];
  if (!goal || !config.microsoft.customerId || !config.microsoft.accountId) return { ok: false, reason: 'destination_not_configured' };
  const clickId = msclkid && MSCLKID.test(msclkid) ? msclkid : undefined;
  const email = event.identity.email.microsoft;
  const phone = event.identity.phone.microsoft;
  if (!clickId && !email && !phone) return { ok: false, reason: 'no_match_keys' };
  const value = event.value;
  const item = compact({
    ConversionName: goal,
    ConversionTime: new Date(Date.parse(event.row.occurred_at)).toISOString(),
    ConversionValue: value?.value,
    ConversionCurrencyCode: value?.currency,
    MicrosoftClickId: clickId,
    HashedEmailAddress: email,
    HashedPhoneNumber: phone,
  });
  return { ok: true, item, batchKey: `${config.microsoft.customerId}:${config.microsoft.accountId}`, meta: { send_mode: 'offline_conversions' } };
}

export const microsoft: PlatformModule = {
  platform: 'microsoft',
  maxBatchSize: { SEND: 1000, ADJUST: 1000 },
  requestSchemas: { SEND: [eventsSchema, offlineSchema], ADJUST: adjustmentsSchema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { event, mapping, config } = input;
    const row = event.row;
    const msclkid = row.click_ids.msclkid?.value;
    if (config.microsoft.sendMode === 'offline_conversions') return buildOffline(input, msclkid);
    const userData = compact({
      em: event.identity.email.microsoft,
      ph: event.identity.phone.microsoft,
      externalId: event.identity.external_id ?? undefined,
      msclkid: msclkid && MSCLKID.test(msclkid) ? msclkid : undefined,
      clientIpAddress: event.context.client_ip_address ?? undefined,
      clientUserAgent: event.context.client_user_agent ?? undefined,
    });
    if (!userData.em && !userData.ph && !userData.externalId && !userData.msclkid) return { ok: false, reason: 'no_match_keys' };
    const value = event.value;
    const item = compact({
      eventType: 'custom',
      eventId: input.dedupKey,
      eventName: mapping.platform_event_name ?? row.event_name,
      eventTime: Math.floor(Date.parse(row.occurred_at) / 1000),
      eventSourceUrl: input.eventSourceUrl,
      adStorageConsent: input.consent.microsoftAdStorage ?? undefined,
      userData,
      customData: value ? compact({ value: value.value, currency: value.currency, transactionId: row.order_id ?? undefined }) : undefined,
    });
    return { ok: true, item, batchKey: config.microsoft.tagId };
  },

  buildAdjustment(input: AdjustmentBuildInput): BuildResult {
    const { config, original, event } = input;
    const goal = config.microsoft.conversionGoals[original.event_name];
    if (!goal || !config.microsoft.customerId || !config.microsoft.accountId) return { ok: false, reason: 'destination_not_configured' };
    if (!original.order_id) return { ok: false, reason: 'original_without_order_id' };
    const retract = input.full;
    const item = compact({
      AdjustmentType: retract ? 'Retract' : 'Restate',
      AdjustmentTime: new Date(Date.parse(event.row.occurred_at)).toISOString(),
      AdjustmentValue: retract ? undefined : roundMajor(input.restatedValue, input.currency),
      AdjustmentCurrencyCode: retract ? undefined : input.currency,
      ConversionName: goal,
      TransactionId: original.order_id,
    });
    return { ok: true, item, batchKey: `${config.microsoft.customerId}:${config.microsoft.accountId}`, meta: { adjustment_type: retract ? 'Retract' : 'Restate' } };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    // Offline conversion import items carry ConversionName; UET CAPI items carry eventType + customData.
    if ('ConversionName' in item) return { ...item, ConversionValue: value.value, ConversionCurrencyCode: value.currency };
    const customData = (item.customData ?? {}) as Record<string, unknown>;
    return { ...item, customData: { ...customData, value: value.value, currency: value.currency } };
  },

  buildRequest(action: OutboxAction, batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest {
    if (action === 'SEND' && config.microsoft.sendMode === 'offline_conversions') {
      const [customerId, accountId] = batchKey.split(':') as [string, string];
      return {
        platform: 'microsoft',
        action,
        method: 'POST',
        url: MICROSOFT_OFFLINE_CONVERSIONS_URL,
        headers: { 'Content-Type': 'application/json', CustomerId: customerId, CustomerAccountId: accountId },
        body: { OfflineConversions: items },
        auth: 'microsoft_ads_api',
        validationOnly: false,
      };
    }
    if (action === 'ADJUST') {
      const [customerId, accountId] = batchKey.split(':') as [string, string];
      return {
        platform: 'microsoft',
        action,
        method: 'POST',
        url: MICROSOFT_ADJUSTMENTS_URL,
        headers: { 'Content-Type': 'application/json', CustomerId: customerId, CustomerAccountId: accountId },
        body: { OnlineConversionAdjustments: items },
        auth: 'microsoft_ads_api',
        validationOnly: false,
      };
    }
    return {
      platform: 'microsoft',
      action,
      method: 'POST',
      url: uetEventsUrl(config.microsoft.tagId),
      headers: { 'Content-Type': 'application/json' },
      body: { data: items, continueOnValidationError: false },
      auth: 'microsoft_uet_bearer',
      validationOnly: false,
    };
  },

  classifyResponse(status: number, body: unknown, retryAfter: string | null): SendOutcome {
    const partial = (body as { PartialErrors?: unknown[] } | null)?.PartialErrors;
    if (status >= 200 && status < 300 && Array.isArray(partial) && partial.length > 0) {
      return { kind: 'fail', status, error: `PartialErrors: ${truncate(partial)}` };
    }
    return classifyHttp(status, body, retryAfter);
  },
};
