/**
 * Reddit Conversions API v3.
 *
 * Dedup: the pixel sends conversionId = SHA-256(<order id>) (sealed replay, research/11 §3.2).
 * Reddit's help centre: "If the conversion ID is unhashed, Reddit will use SHA-256 to hash it
 * before storing it". Sending the pixel's exact hashed string (conversionIdMode pixel_sha256,
 * the default) matches whether Reddit detects pre-hashed values or not for the pixel side;
 * plaintext is available as a switch. Neither is proven until Reddit's dedup log shows the
 * pair collapsing, so tag-twin rows stay HELD until REDDIT_DEDUP_VERIFIED=true (the contracts
 * mapping and integration map say the same). Dedup needs both events "within two days".
 */

import { redditPixelConversionId } from '@openart-signal/contracts';
import type { ServiceConfig } from '../../config.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact } from '../types.js';
import type { BuildResult, EventBuildInput, PlatformModule, PlatformRequest } from '../types.js';
import schema from './conversion-events.schema.json' with { type: 'json' };

export function redditUrl(pixelId: string): string {
  return `https://ads-api.reddit.com/api/v3/pixels/${pixelId}/conversion_events`;
}

/** Mapping names are 'SIGN_UP', 'PURCHASE' or 'CUSTOM:<name>'. */
export function redditType(platformEventName: string): { tracking_type: string; custom_event_name?: string } {
  if (platformEventName.startsWith('CUSTOM:')) return { tracking_type: 'CUSTOM', custom_event_name: platformEventName.slice('CUSTOM:'.length) };
  return { tracking_type: platformEventName };
}

export const reddit: PlatformModule = {
  platform: 'reddit',
  maxBatchSize: { SEND: 1000 },
  requestSchemas: { SEND: schema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { event, mapping, config } = input;
    const row = event.row;
    const user = compact({
      email: event.identity.email.reddit,
      phone_number: event.identity.phone.reddit,
      external_id: event.identity.external_id ?? undefined,
      ip_address: event.context.client_ip_address ?? undefined,
      user_agent: event.context.client_user_agent ?? undefined,
      uuid: event.context.rdt_uuid ?? undefined,
      data_processing_options: input.consent.reddit ?? undefined,
    });
    const clickId = row.click_ids.rdt_cid?.value;
    if (!user.email && !user.phone_number && !user.external_id && !user.uuid && !clickId) return { ok: false, reason: 'no_match_keys' };
    const conversionId = config.reddit.conversionIdMode === 'pixel_sha256' ? redditPixelConversionId(input.dedupKey) : input.dedupKey;
    const value = event.value;
    const item = compact({
      event_at: Date.parse(row.occurred_at),
      action_source: mapping.action_source ?? 'WEBSITE',
      type: redditType(mapping.platform_event_name ?? `CUSTOM:${row.event_name}`),
      click_id: clickId,
      event_source_url: input.eventSourceUrl,
      metadata: compact({
        conversion_id: conversionId,
        order_id: row.order_id ?? undefined,
        currency: value?.currency,
        value: value?.value,
      }),
      user,
    });
    return { ok: true, item, batchKey: config.reddit.pixelId, meta: { conversion_id_mode: config.reddit.conversionIdMode } };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    return { ...item, metadata: { ...metadata, currency: value.currency, value: value.value } };
  },

  buildRequest(action: OutboxAction, batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest {
    return {
      platform: 'reddit',
      action,
      method: 'POST',
      url: redditUrl(batchKey),
      headers: { 'Content-Type': 'application/json', 'User-Agent': config.reddit.userAgent },
      body: { data: compact({ test_id: config.reddit.testId ?? undefined, events: items }) },
      auth: 'reddit_bearer',
      validationOnly: Boolean(config.reddit.testId),
    };
  },

  classifyResponse: classifyHttp,
};
