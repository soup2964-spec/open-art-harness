/** Shared shape of a dry-run audience request (never sent by this package). */

import type { AudiencePlatform } from '../types.js';

export interface AudienceHttpRequest {
  /** Stable id within a plan; later requests reference it (TikTok file_path). */
  id: string;
  platform: AudiencePlatform;
  listName: string;
  operation: 'add' | 'remove' | 'upload_file' | 'create' | 'delete';
  method: 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Form fields (Meta payload/session; TikTok multipart fields). */
  form?: Record<string, string>;
  /** Multipart file part (TikTok customer file). */
  file?: { field: 'file'; fileName: string; contentType: 'text/plain'; content: string; md5: string; lines: number; bytes: number };
  /** Audience members carried by this request. */
  members: number;
  /** Requests whose response this one needs. */
  dependsOn?: string[];
}

export interface PlatformRequestInput<C> {
  listName: string;
  adds: ReadonlyArray<import('@openart-signal/contracts').AudienceMember>;
  removes: ReadonlyArray<import('@openart-signal/contracts').AudienceMember>;
  /** Members the platform list has before this sync (the previous snapshot). */
  previousSize: number;
  /** Members after applying every add and remove. */
  sizeAfter: number;
  config: C;
  /** Identifies this sync run (session ids, file names). */
  runId: string;
}

export interface PlatformRequestOutput {
  requests: AudienceHttpRequest[];
  /** Why adds (or the whole list) were not sent, if they were not. */
  held: string | null;
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
