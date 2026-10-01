/**
 * TikTok customer-file audiences (API for Business v1.3). The Streaming/segment API is
 * allowlist-only, so the documented customer-file flow is used:
 *
 *   POST /open_api/v1.3/dmp/custom_audience/file/upload/  multipart: advertiser_id, calculate_type,
 *        file_signature (MD5 of the file), file_name, file (.txt, one SHA-256 per line, no header)
 *        -> data.file_path
 *   POST /open_api/v1.3/dmp/custom_audience/create/  {advertiser_id, custom_audience_name, file_paths,
 *        calculate_type, retention_in_days}
 *   POST /open_api/v1.3/dmp/custom_audience/update/  {advertiser_id, custom_audience_id, file_paths,
 *        action: APPEND | REMOVE}   (action defaults to REPLACE server-side, so it is always explicit)
 *   POST /open_api/v1.3/dmp/custom_audience/delete/  {advertiser_id, custom_audience_ids}
 *   header: Access-Token
 * Limits: files <= 250 MB; < 50 file_paths per call recommended; an audience needs >= 1,000
 * users, and APPEND/REMOVE/REPLACE FAIL if the audience would have fewer than 1,000 afterwards,
 * so a removal that would cross that line is honoured by deleting the audience (recreated once
 * it is back above 1,000). APPEND runs before REMOVE so the size never dips below 1,000 midway.
 */

import { createHash } from 'node:crypto';
import type { AudienceMember } from '@openart-signal/contracts';
import { chunk, type AudienceHttpRequest, type PlatformRequestInput } from './common.js';

export const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
export const TIKTOK_LIMITS = { minAudienceSize: 1000, maxFileBytes: 250 * 1024 * 1024, maxFilePathsPerCall: 50 } as const;

export interface TikTokConfig {
  advertiserId: string;
  /** list_name -> custom_audience_id, or null when the audience does not exist yet. */
  audienceIds: Record<string, string | null>;
  calculateType: 'EMAIL_SHA256' | 'PHONE_SHA256';
  minAudienceSize: number;
  maxLinesPerFile: number;
  maxFilePathsPerCall: number;
  /** 1-365; omitted = 365 days after the audience was last used or modified. */
  retentionInDays: number | null;
}

const HEADERS_JSON = { 'Access-Token': '<TIKTOK_ACCESS_TOKEN>', 'Content-Type': 'application/json' };
const HEADERS_MULTIPART = { 'Access-Token': '<TIKTOK_ACCESS_TOKEN>', 'Content-Type': 'multipart/form-data' };

export interface TikTokRequestOutput {
  requests: AudienceHttpRequest[];
  held: string | null;
  deleted: boolean;
  skipped: number;
  /**
   * The list's custom_audience_id once these requests succeed: unchanged, null after a delete or
   * while the audience does not exist, or a reference to the create response. Persist it (the plan
   * writes nextAudienceIds) so the next sync never updates a deleted audience.
   */
  audienceIdAfter: string | null;
}

export function tiktokRequests(o: PlatformRequestInput<TikTokConfig>): TikTokRequestOutput {
  const c = o.config;
  const key = c.calculateType === 'EMAIL_SHA256' ? 'email_sha256' : 'phone_sha256';
  let skipped = 0;
  const hashes = (ms: readonly AudienceMember[]) =>
    ms.flatMap((m) => {
      const h = m.identifiers[key];
      if (!h) {
        skipped += 1;
        return [];
      }
      return [h];
    });
  const audienceId = c.audienceIds[o.listName] ?? null;
  const requests: AudienceHttpRequest[] = [];

  const uploads = (values: readonly string[], purpose: 'add' | 'remove' | 'create'): string[] => {
    const ids: string[] = [];
    chunk(values, c.maxLinesPerFile).forEach((part, i) => {
      const content = `${part.join('\n')}\n`;
      const bytes = Buffer.byteLength(content);
      if (bytes > TIKTOK_LIMITS.maxFileBytes) throw new Error(`TikTok audience file would be ${bytes} bytes > 250 MB; lower maxLinesPerFile`);
      const md5 = createHash('md5').update(content).digest('hex');
      const fileName = `${o.listName}-${purpose}-${o.runId}-${i + 1}.txt`;
      const id = `tiktok/${o.listName}/upload-${purpose}-${i + 1}`;
      requests.push({
        id,
        platform: 'tiktok',
        listName: o.listName,
        operation: 'upload_file',
        method: 'POST',
        url: `${TIKTOK_API_BASE}/dmp/custom_audience/file/upload/`,
        headers: HEADERS_MULTIPART,
        form: { advertiser_id: c.advertiserId, calculate_type: c.calculateType, file_signature: md5, file_name: fileName },
        file: { field: 'file', fileName, contentType: 'text/plain', content, md5, lines: part.length, bytes },
        members: part.length,
      });
      ids.push(id);
    });
    return ids;
  };
  const fileRef = (uploadId: string) => `{{${uploadId}.data.file_path}}`;
  const update = (uploadIds: string[], action: 'APPEND' | 'REMOVE') => {
    chunk(uploadIds, c.maxFilePathsPerCall).forEach((ids, i) => {
      requests.push({
        id: `tiktok/${o.listName}/${action.toLowerCase()}-${i + 1}`,
        platform: 'tiktok',
        listName: o.listName,
        operation: action === 'APPEND' ? 'add' : 'remove',
        method: 'POST',
        url: `${TIKTOK_API_BASE}/dmp/custom_audience/update/`,
        headers: HEADERS_JSON,
        json: { advertiser_id: c.advertiserId, custom_audience_id: audienceId, file_paths: ids.map(fileRef), action },
        dependsOn: ids,
        members: requests.filter((r) => ids.includes(r.id)).reduce((s, r) => s + r.members, 0),
      });
    });
  };

  const addHashes = hashes(o.adds);
  const removeHashes = hashes(o.removes);

  if (!audienceId) {
    if (o.sizeAfter < c.minAudienceSize) {
      return { requests: [], held: addHashes.length > 0 ? `new audience would have ${o.sizeAfter} entries < ${c.minAudienceSize} (TikTok minimum); not created yet` : null, deleted: false, skipped, audienceIdAfter: null };
    }
    const ids = uploads(addHashes, 'create');
    chunk(ids, c.maxFilePathsPerCall).forEach((part, i) => {
      if (i === 0) {
        requests.push({
          id: `tiktok/${o.listName}/create`,
          platform: 'tiktok',
          listName: o.listName,
          operation: 'create',
          method: 'POST',
          url: `${TIKTOK_API_BASE}/dmp/custom_audience/create/`,
          headers: HEADERS_JSON,
          json: {
            advertiser_id: c.advertiserId,
            custom_audience_name: o.listName,
            file_paths: part.map(fileRef),
            calculate_type: c.calculateType,
            ...(c.retentionInDays ? { retention_in_days: c.retentionInDays } : {}),
          },
          dependsOn: part,
          members: requests.filter((r) => part.includes(r.id)).reduce((s, r) => s + r.members, 0),
        });
      } else {
        // More than 50 files: append the rest once the audience exists (id from the create response).
        requests.push({
          id: `tiktok/${o.listName}/append-after-create-${i}`,
          platform: 'tiktok',
          listName: o.listName,
          operation: 'add',
          method: 'POST',
          url: `${TIKTOK_API_BASE}/dmp/custom_audience/update/`,
          headers: HEADERS_JSON,
          json: { advertiser_id: c.advertiserId, custom_audience_id: `{{tiktok/${o.listName}/create.data.custom_audience_id}}`, file_paths: part.map(fileRef), action: 'APPEND' },
          dependsOn: [`tiktok/${o.listName}/create`, ...part],
          members: requests.filter((r) => part.includes(r.id)).reduce((s, r) => s + r.members, 0),
        });
      }
    });
    return { requests, held: null, deleted: false, skipped, audienceIdAfter: `{{tiktok/${o.listName}/create.data.custom_audience_id}}` };
  }

  if (o.sizeAfter < c.minAudienceSize) {
    if (removeHashes.length === 0) {
      return { requests: [], held: addHashes.length > 0 ? `audience would have ${o.sizeAfter} entries < ${c.minAudienceSize}; TikTok rejects the update` : null, deleted: false, skipped, audienceIdAfter: audienceId };
    }
    // REMOVE would fail below 1,000, but removals must be honoured: delete the audience.
    requests.push({
      id: `tiktok/${o.listName}/delete`,
      platform: 'tiktok',
      listName: o.listName,
      operation: 'delete',
      method: 'POST',
      url: `${TIKTOK_API_BASE}/dmp/custom_audience/delete/`,
      headers: HEADERS_JSON,
      json: { advertiser_id: c.advertiserId, custom_audience_ids: [audienceId] },
      members: o.previousSize,
    });
    return {
      requests,
      held: `removals would leave ${o.sizeAfter} entries < ${c.minAudienceSize}, which TikTok rejects; audience deleted to honour them (recreate it once the list is back above ${c.minAudienceSize})`,
      deleted: true,
      skipped,
      audienceIdAfter: null,
    };
  }
  if (addHashes.length > 0) update(uploads(addHashes, 'add'), 'APPEND');
  if (removeHashes.length > 0) update(uploads(removeHashes, 'remove'), 'REMOVE');
  return { requests, held: null, deleted: false, skipped, audienceIdAfter: audienceId };
}
