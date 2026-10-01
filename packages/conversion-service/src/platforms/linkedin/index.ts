/**
 * LinkedIn Conversions API. "you must create a conversion rule for each data source" and,
 * for the same eventId from the Insight Tag and CAPI, "we discard the Conversions API event
 * and count only the Insight Tag event". The Insight tags send no eventId today, so both
 * LinkedIn twins (signup, purchase) are held until web-fixes adds it. Leads have no browser
 * twin. No consent/LDU field exists: opted-out users are never sent (consent resolver).
 */

import type { ServiceConfig } from '../../config.js';
import { formatMajor } from '../../money.js';
import type { OutboxAction, ResolvedValue } from '../../types.js';
import { classifyHttp, compact, isIpv4 } from '../types.js';
import type { BuildResult, EventBuildInput, PlatformModule, PlatformRequest } from '../types.js';
import schema from './conversion-events.schema.json' with { type: 'json' };

export const LINKEDIN_CONVERSION_EVENTS_URL = 'https://api.linkedin.com/rest/conversionEvents';

export const linkedin: PlatformModule = {
  platform: 'linkedin',
  maxBatchSize: { SEND: 5000 },
  requestSchemas: { SEND: schema },

  buildEvent(input: EventBuildInput): BuildResult {
    const { event, config } = input;
    const row = event.row;
    const rule = config.linkedin.conversionRules[row.event_name];
    if (!rule) return { ok: false, reason: 'destination_not_configured' };
    const userIds: Array<{ idType: string; idValue: string }> = [];
    const email = event.identity.email.linkedin;
    if (email) userIds.push({ idType: 'SHA256_EMAIL', idValue: email });
    const liFatId = row.click_ids.li_fat_id?.value;
    if (liFatId) userIds.push({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: liFatId });
    const ip = event.context.client_ip_address;
    if (isIpv4(ip)) userIds.push({ idType: 'PLAINTEXT_IP_ADDRESS', idValue: ip });
    if (!email && !liFatId) return { ok: false, reason: 'no_match_keys' };
    const value = event.value;
    const item = compact({
      conversion: rule,
      conversionHappenedAt: Date.parse(row.occurred_at),
      conversionValue: value ? { currencyCode: value.currency, amount: formatMajor(value.value, value.currency) } : undefined,
      eventId: input.dedupKey,
      user: compact({
        userIds,
        // Sent with standard identifiers, as the schema requires on first use; LinkedIn keeps the mapping for a year.
        externalIds: event.identity.external_id ? [event.identity.external_id] : undefined,
      }),
    });
    return { ok: true, item, batchKey: 'conversionEvents' };
  },

  applyValue(item: Record<string, unknown>, value: ResolvedValue): Record<string, unknown> {
    return { ...item, conversionValue: { currencyCode: value.currency, amount: formatMajor(value.value, value.currency) } };
  },

  buildRequest(action: OutboxAction, _batchKey: string, items: Record<string, unknown>[], config: ServiceConfig): PlatformRequest {
    return {
      platform: 'linkedin',
      action,
      method: 'POST',
      url: LINKEDIN_CONVERSION_EVENTS_URL,
      headers: {
        'Content-Type': 'application/json',
        'Linkedin-Version': config.linkedin.version,
        'X-Restli-Protocol-Version': '2.0.0',
        'X-RestLi-Method': 'BATCH_CREATE',
      },
      body: { elements: items },
      auth: 'linkedin_bearer',
      validationOnly: false,
    };
  },

  classifyResponse: classifyHttp,
};
