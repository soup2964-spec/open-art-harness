/**
 * Meta customer-list Custom Audiences (Marketing API).
 *
 *   POST   https://graph.facebook.com/{version}/{audience_id}/users   add
 *   DELETE https://graph.facebook.com/{version}/{audience_id}/users   remove
 *   form fields: payload = {"schema": [...], "data": [[...], ...]}, session = {...}, access_token
 * Multi-key schema: ["EXTERN_ID", "EMAIL", "PHONE"] (+ "LOOKALIKE_VALUE" on value-based seeds);
 * unknown keys are left blank. EMAIL/PHONE are SHA-256 of the normalised value (lowercase hex);
 * EXTERN_ID is sent exactly as the pixel sends external_id (SHA-256 of the lower-cased uid), so
 * list members match pixel/CAPI events. The single-key alternative is schema "EMAIL_SHA256"
 * with a flat data array. Up to 10,000 users per request, batched in one session
 * {session_id, batch_seq from 1, last_batch_flag, estimated_num_total}. Lookalike and
 * value-based lookalike seeds need at least 100 people (100 per country for lookalikes).
 */

import type { AudienceMember } from '@openart-signal/contracts';
import { sha256Hex } from '@openart-signal/contracts';
import { chunk, type AudienceHttpRequest, type PlatformRequestInput } from './common.js';

export const META_GRAPH_BASE = 'https://graph.facebook.com';
export const META_LIMITS = { maxUsersPerRequest: 10_000, minListSize: 100 } as const;

export interface MetaConfig {
  apiVersion: string;
  adAccountId: string;
  /** list_name -> customer-list custom audience id (created once with subtype CUSTOM). */
  audienceIds: Record<string, string>;
  /** Lists created with is_value_based=1 (their adds carry LOOKALIKE_VALUE). */
  valueBasedLists: string[];
  schemaMode: 'multi_key' | 'email_sha256';
  minListSize: number;
  maxUsersPerRequest: number;
}

/** Positive 53-bit session id, stable per (ad account, audience, operation, run). */
export function metaSessionId(adAccountId: string, audienceId: string, operation: 'add' | 'remove', runId: string): number {
  return Number.parseInt(sha256Hex(`${adAccountId}|${audienceId}|${operation}|${runId}`).slice(0, 13), 16) + 1;
}

export function metaRequests(o: PlatformRequestInput<MetaConfig>): { requests: AudienceHttpRequest[]; held: string | null; skipped: number } {
  const c = o.config;
  const audienceId = c.audienceIds[o.listName] ?? `<META_CUSTOM_AUDIENCE_ID:${o.listName}>`;
  const valueBased = c.valueBasedLists.includes(o.listName);
  const size = Math.min(c.maxUsersPerRequest, META_LIMITS.maxUsersPerRequest);
  let skipped = 0;

  const payloadFor = (batch: readonly AudienceMember[], operation: 'add' | 'remove') => {
    if (c.schemaMode === 'email_sha256') return { schema: 'EMAIL_SHA256', data: batch.map((m) => m.identifiers.email_sha256!) };
    const withValue = valueBased && operation === 'add';
    const schema = ['EXTERN_ID', 'EMAIL', 'PHONE', ...(withValue ? ['LOOKALIKE_VALUE'] : [])];
    const data = batch.map((m) => {
      const row: Array<string | number> = [m.identifiers.external_id_sha256 ?? '', m.identifiers.email_sha256 ?? '', m.identifiers.phone_sha256 ?? ''];
      if (withValue) row.push(Math.max(0, m.value ?? 0));
      return row;
    });
    return { schema, data };
  };

  const usable = (ms: readonly AudienceMember[]) =>
    ms.filter((m) => {
      const ok = c.schemaMode === 'email_sha256' ? Boolean(m.identifiers.email_sha256) : Object.keys(m.identifiers).length > 0;
      if (!ok) skipped += 1;
      return ok;
    });

  const build = (members: readonly AudienceMember[], operation: 'add' | 'remove'): AudienceHttpRequest[] => {
    const batches = chunk(members, size);
    const sessionId = metaSessionId(c.adAccountId, audienceId, operation, o.runId);
    return batches.map((batch, i) => ({
      id: `meta/${o.listName}/${operation}-${i + 1}`,
      platform: 'meta',
      listName: o.listName,
      operation,
      method: operation === 'add' ? 'POST' : 'DELETE',
      url: `${META_GRAPH_BASE}/${c.apiVersion}/${audienceId}/users`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      form: {
        payload: JSON.stringify(payloadFor(batch, operation)),
        session: JSON.stringify({ session_id: sessionId, batch_seq: i + 1, last_batch_flag: i === batches.length - 1, estimated_num_total: members.length }),
        access_token: '<META_ACCESS_TOKEN>',
      },
      members: batch.length,
    }));
  };

  const adds = usable(o.adds);
  const removes = usable(o.removes);
  let held: string | null = null;
  const requests: AudienceHttpRequest[] = [];
  if (o.previousSize === 0 && o.sizeAfter < c.minListSize) {
    if (adds.length > 0) held = `new list would have ${o.sizeAfter} people < ${c.minListSize} (Meta seed minimum); not uploaded yet`;
  } else if (adds.length > 0) {
    requests.push(...build(adds, 'add'));
  }
  // Removals always go out (consent withdrawals, users who stopped qualifying).
  if (removes.length > 0) requests.push(...build(removes, 'remove'));
  return { requests, held, skipped };
}
