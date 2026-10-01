/**
 * X Ads Conversion API. The browser sends conversion_id = sub_<invoiceId> on the purchase
 * event tw-qwghh-13vj24 (sealed replay), so the server twin reuses both the Events Manager
 * event id and the conversion_id ("use the same event in both pixel and CAPI requests, in
 * addition to using the same conversion_id", 48 h). X has no consent field ("Do not send
 * Conversion API events for users who have opted out"): the consent resolver drops them.
 * Note X ALSO records an automatic gtm_purchase for every purchase; only one of the two should
 * be a counted conversion in Events Manager (contracts mapping note).
 */

import type { ServiceConfig } from '../../config.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact } from '../types.js';
import type { BuildResult, EventBuildInput, PlatformModule, PlatformRequest } from '../types.js';
import schema from './conversions.schema.json' with { type: 'json' };

export function xConversionsUrl(pixelId: string): string {
  return `https://ads-api.x.com/12/measurement/conversions/${pixelId}`;
}

export const x: PlatformModule = {
  platform: 'x',
  // 500 per request per the archived reference; kept lower because the live cap is unverified.
  maxBatchSize: { SEND: 100 },
  requestSchemas: { SEND: schema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { event, config } = input;
    const row = event.row;
    const eventId = config.x.eventIds[row.event_name];
    if (!eventId) return { ok: false, reason: 'destination_not_configured' };
    const identifiers: Array<Record<string, string>> = [];
    const twclid = row.click_ids.twclid?.value;
    if (twclid) identifiers.push({ twclid });
    const email = event.identity.email.x;
    if (email) identifiers.push({ hashed_email: email });
    const phone = event.identity.phone.x;
    if (phone) identifiers.push({ hashed_phone_number: phone });
    if (identifiers.length === 0) return { ok: false, reason: 'no_match_keys' };
    const ip = event.context.client_ip_address;
    const ua = event.context.client_user_agent;
    if (ip && ua) identifiers.push({ ip_address: ip, user_agent: ua });
    const value = event.value;
    const item = compact({
      conversion_time: new Date(Date.parse(row.occurred_at)).toISOString(),
      event_id: eventId,
      identifiers,
      conversion_id: input.dedupKey,
      value: value?.value,
      price_currency: value?.currency,
    });
    return { ok: true, item, batchKey: config.x.pixelId };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    return { ...item, value: value.value, price_currency: value.currency };
  },

  buildRequest(action: OutboxAction, batchKey: string, items: Record<string, unknown>[], _config: ServiceConfig): PlatformRequest {
    return {
      platform: 'x',
      action,
      method: 'POST',
      url: xConversionsUrl(batchKey),
      headers: { 'Content-Type': 'application/json' },
      body: { conversions: items },
      auth: 'x_oauth1',
      validationOnly: false,
    };
  },

  classifyResponse: classifyHttp,
};
