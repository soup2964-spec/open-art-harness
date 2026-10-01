/**
 * Meta Conversions API (direct, graph.facebook.com). OpenArt's CAPI Gateway keeps relaying
 * pixel events unchanged; these server events carry the SAME event_name + event_id as the
 * pixel (reg_<uid>, purchase_<invoiceId>), so Meta keeps one of each within 48 h.
 *
 *  - external_id = SHA-256 of the LOWER-CASED uid (what the pixel sends; contracts metaExternalId)
 *  - fbc from the request or built from the stored fbclid (fb.1.<first_seen_ms>.<fbclid>)
 *  - value = resolved value (predicted profit on first purchases), predicted_ltv alongside
 *  - renewals: action_source system_generated ("a subscription renewal that's set to auto-pay")
 *  - no retraction exists: refunds/chargebacks are skipped by the mapping ("log and skip")
 *  - event_time older than 7 days fails the WHOLE request: the dispatcher's window guard
 *    drops those before they are batched.
 */

import type { ServiceConfig } from '../../config.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact, credentialRetry, truncate } from '../types.js';
import type { BuildResult, EventBuildInput, PlatformModule, PlatformRequest, SendOutcome } from '../types.js';
import schema from './events.schema.json' with { type: 'json' };

export function metaEventsUrl(config: ServiceConfig): string {
  return `https://graph.facebook.com/${config.meta.apiVersion}/${config.meta.pixelId}/events`;
}

/** Graph API rate-limit / transient codes come back as HTTP 400 bodies. */
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * Credential and permission codes (Graph API error reference): 190 invalid or expired access token
 * (OAuthException), 102 API session, 10 permission denied, 200-299 permission errors. Retried so a
 * rotated token resumes delivery; code 100 (invalid parameter) is also an OAuthException but is not
 * a credential problem, so it still fails.
 */
function isCredentialCode(code: unknown): boolean {
  return typeof code === 'number' && (code === 190 || code === 102 || code === 10 || (code >= 200 && code <= 299));
}

/**
 * custom_data in one canonical key order, shared by buildEvent and applyValue. value_basis is a custom
 * parameter (Meta accepts arbitrary custom_data keys) so Events Manager shows how each value was made.
 */
function customData(value: ResolvedValue, orderId: string | undefined): Record<string, unknown> {
  return compact({
    value: value.value,
    currency: value.currency,
    order_id: orderId,
    predicted_ltv: value.basis === 'predicted_profit_90d' && value.predicted_ltv !== null && value.predicted_ltv > 0 ? value.predicted_ltv : undefined,
    value_basis: value.basis,
  });
}

export const meta: PlatformModule = {
  platform: 'meta',
  maxBatchSize: { SEND: 1000 },
  requestSchemas: { SEND: schema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { event, mapping } = input;
    const row = event.row;
    const actionSource = mapping.action_source ?? 'website';
    const website = actionSource === 'website';
    const ua = event.context.client_user_agent ?? null;
    if (website && !ua) return { ok: false, reason: 'meta_website_event_requires_client_user_agent' };

    const email = event.identity.email.meta;
    const phone = event.identity.phone.meta;
    const userData = compact({
      em: email ? [email] : undefined,
      ph: phone ? [phone] : undefined,
      external_id: event.identity.external_id ? [event.identity.external_id] : undefined,
      client_ip_address: event.context.client_ip_address ?? undefined,
      client_user_agent: ua ?? undefined,
      fbc: event.fbc ?? undefined,
      fbp: event.context.fbp ?? undefined,
      subscription_id: row.subscription_id ?? undefined,
    });
    if (!userData.em && !userData.ph && !userData.external_id && !userData.fbc && !userData.fbp) return { ok: false, reason: 'no_match_keys' };

    const value = event.value;
    const item = compact({
      event_name: mapping.platform_event_name ?? row.event_name,
      event_time: Math.floor(Date.parse(row.occurred_at) / 1000),
      event_id: input.dedupKey,
      event_source_url: website ? input.eventSourceUrl : undefined,
      action_source: actionSource,
      user_data: userData,
      custom_data: value ? customData(value, row.order_id ?? undefined) : undefined,
      ...input.consent.meta,
    });
    return { ok: true, item, batchKey: input.config.meta.pixelId };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    const existing = (item.custom_data ?? {}) as { order_id?: string };
    return { ...item, custom_data: customData(value, existing.order_id) };
  },

  buildRequest(action: OutboxAction, _batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest {
    return {
      platform: 'meta',
      action,
      method: 'POST',
      url: metaEventsUrl(config),
      headers: { 'Content-Type': 'application/json' },
      body: compact({ data: items, test_event_code: config.meta.testEventCode ?? undefined }),
      auth: 'meta_access_token',
      validationOnly: Boolean(config.meta.testEventCode),
    };
  },

  classifyResponse(status: number, body: unknown, retryAfter: string | null): SendOutcome {
    if (status >= 200 && status < 300) {
      const received = (body as { events_received?: unknown } | null)?.events_received;
      if (typeof received === 'number') return { kind: 'ok', status, dryRun: false, detail: body };
      return { kind: 'fail', status, error: `2xx without events_received: ${truncate(body)}` };
    }
    const err = (body as { error?: { code?: number; is_transient?: boolean } } | null)?.error;
    if (err && isCredentialCode(err.code)) return credentialRetry(status, `Graph error ${err.code}: ${truncate(body)}`);
    if (err && (err.is_transient === true || (typeof err.code === 'number' && TRANSIENT_GRAPH_CODES.has(err.code)))) {
      return { kind: 'retry', status, error: `Graph error ${err.code}: ${truncate(body)}` };
    }
    return classifyHttp(status, body, retryAfter);
  },
};
