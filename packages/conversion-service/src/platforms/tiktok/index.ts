/**
 * TikTok Events API 2.0. Dedup key = event_source_id + event + event_id; TikTok keeps the
 * first event and discards later ones within 48 h. The browser's Purchase (first purchase
 * only) sends event_id = sub_<invoiceId>, so the server twin reuses it; the browser's
 * CompleteRegistration sends event_id "" today, so signup is held until web-fixes adds reg_<uid>.
 *
 * TikTok can answer HTTP 200 with a non-zero `code`, so the body decides success.
 */

import type { ServiceConfig } from '../../config.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact, credentialRetry, truncate } from '../types.js';
import type { BuildResult, EventBuildInput, PlatformModule, PlatformRequest, SendOutcome } from '../types.js';
import schema from './event-track.schema.json' with { type: 'json' };

export const TIKTOK_EVENT_TRACK_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

/**
 * Marketing API access-token and permission codes (40001 no permission, 40101/40102 token invalid or
 * expired, 40104 token missing, 40105 token revoked). Retried so a rotated token resumes delivery.
 * The exact code list is from TikTok's response-code table and is not verified against a live account.
 */
const TIKTOK_CREDENTIAL_CODES: ReadonlySet<number> = new Set([40001, 40101, 40102, 40104, 40105]);

export const tiktok: PlatformModule = {
  platform: 'tiktok',
  // TikTok's FAQ recommends "less than 100 events per batch".
  maxBatchSize: { SEND: 100 },
  requestSchemas: { SEND: schema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { event, mapping } = input;
    const row = event.row;
    const user = compact({
      email: event.identity.email.tiktok,
      phone: event.identity.phone.tiktok,
      external_id: event.identity.external_id ?? undefined,
      ttclid: row.click_ids.ttclid?.value,
      ttp: event.context.ttp ?? undefined,
      ip: event.context.client_ip_address ?? undefined,
      user_agent: event.context.client_user_agent ?? undefined,
    });
    if (!user.email && !user.phone && !user.external_id) return { ok: false, reason: 'no_match_keys' };
    const value = event.value;
    const properties = value
      ? compact({
          currency: value.currency,
          value: value.value,
          order_id: row.order_id ?? undefined,
          customer_type: row.is_first_purchase === null ? undefined : row.is_first_purchase ? 'new' : 'returning',
        })
      : undefined;
    const item = compact({
      event: mapping.platform_event_name ?? row.event_name,
      event_time: Math.floor(Date.parse(row.occurred_at) / 1000),
      event_id: input.dedupKey,
      user,
      properties,
      page: { url: input.eventSourceUrl },
      limited_data_use: input.consent.tiktokLimitedDataUse,
    });
    return { ok: true, item, batchKey: input.config.tiktok.pixelCode };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    const properties = (item.properties ?? {}) as Record<string, unknown>;
    return { ...item, properties: { ...properties, currency: value.currency, value: value.value } };
  },

  buildRequest(action: OutboxAction, batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest {
    return {
      platform: 'tiktok',
      action,
      method: 'POST',
      url: TIKTOK_EVENT_TRACK_URL,
      headers: { 'Content-Type': 'application/json' },
      body: compact({ event_source: 'web', event_source_id: batchKey, test_event_code: config.tiktok.testEventCode ?? undefined, data: items }),
      auth: 'tiktok_access_token',
      validationOnly: Boolean(config.tiktok.testEventCode),
    };
  },

  classifyResponse(status: number, body: unknown, retryAfter: string | null): SendOutcome {
    const code = (body as { code?: unknown } | null)?.code;
    if (status >= 200 && status < 300 && typeof code === 'number') {
      if (code === 0) return { kind: 'ok', status, dryRun: false, detail: body };
      if (TIKTOK_CREDENTIAL_CODES.has(code)) return credentialRetry(status, `TikTok code ${code}: ${truncate(body)}`);
      // 40100 = rate limited; 5xxxx = TikTok server errors ("Wait for about 5 minutes and retry").
      if (code === 40100 || code >= 50000) return { kind: 'retry', status, error: `TikTok code ${code}: ${truncate(body)}`, retryAfterMs: 300_000 };
      return { kind: 'fail', status, error: `TikTok code ${code}: ${truncate(body)}` };
    }
    return classifyHttp(status, body, retryAfter);
  },
};
