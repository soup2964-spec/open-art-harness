/**
 * ClickIdResolver: reads the user's click ids (and their created_at) from OpenArt's
 * ad-click-ids store — the body the Suite POSTs to /api/user/ad-click-ids, or the extended
 * superset edge-attribution writes — converts them with the contracts helpers, and builds
 * Meta's fbc = fb.1.<fbclid_created_at_ms>.<fbclid> when the request carried no _fbc.
 *
 * Rules:
 *  - a click stored AFTER the conversion never gets credit for it;
 *  - clicks older than the store's own lifetime (oa_ad_clids Max-Age, 90 days) are dropped;
 *  - click ids already on the row (e.g. the lead form's hidden gclid) win over stored ones.
 */

import {
  ClickIdStoreRecordExtendedSchema,
  OPENART,
  buildMetaFbc,
  clickIdsFromStoreRecord,
  utmFromStoreRecord,
} from '@openart-signal/contracts';
import type { ClickIdStoreRecordExtended, ClickIds, ConversionLedgerEvent, Utm } from '@openart-signal/contracts';
import { bqJson, qualifiedTable } from './bigquery.js';
import type { BigQueryPort, TableRef } from './bigquery.js';

export interface ClickIdStoreReader {
  read(userId: string): Promise<ClickIdStoreRecordExtended | null>;
}

export class InMemoryClickIdStore implements ClickIdStoreReader {
  private readonly byUser: Map<string, ClickIdStoreRecordExtended>;

  constructor(records: Record<string, ClickIdStoreRecordExtended>) {
    this.byUser = new Map(Object.entries(records).map(([k, v]) => [k, structuredClone(v)]));
  }

  async read(userId: string): Promise<ClickIdStoreRecordExtended | null> {
    const hit = this.byUser.get(userId);
    return hit ? structuredClone(hit) : null;
  }
}

/** Reads the latest ad-click-ids record (JSON column `record`) replicated to BigQuery. */
export class BigQueryClickIdStoreReader implements ClickIdStoreReader {
  private readonly table: string;

  constructor(
    private readonly bq: BigQueryPort,
    ref: TableRef,
  ) {
    this.table = qualifiedTable(ref);
  }

  async read(userId: string): Promise<ClickIdStoreRecordExtended | null> {
    const rows = await this.bq.query<{ record: unknown }>(
      `SELECT record FROM ${this.table} WHERE user_id = @user_id ORDER BY received_at DESC LIMIT 1`,
      { user_id: userId },
    );
    if (!rows[0]) return null;
    const parsed = ClickIdStoreRecordExtendedSchema.safeParse(bqJson<unknown>(rows[0].record, null));
    return parsed.success ? parsed.data : null;
  }
}

export interface ResolvedClicks {
  click_ids: ClickIds;
  utm: Utm;
  fbc: string | null;
}

export interface ClickIdResolverOptions {
  /** Oldest click that can still be attached (default: the oa_ad_clids cookie Max-Age, 90 days). */
  maxClickAgeMs?: number;
}

export class ClickIdResolver {
  private readonly maxAgeMs: number;

  constructor(
    private readonly reader: ClickIdStoreReader,
    options: ClickIdResolverOptions = {},
  ) {
    this.maxAgeMs = options.maxClickAgeMs ?? OPENART.clickIdCookieMaxAgeSeconds * 1000;
  }

  async resolve(row: ConversionLedgerEvent, requestFbc: string | null): Promise<ResolvedClicks> {
    const occurredMs = Date.parse(row.occurred_at);
    const stored = row.user_id ? await this.reader.read(row.user_id) : null;
    const fromStore: ClickIds = {};
    if (stored) {
      for (const [key, entry] of Object.entries(clickIdsFromStoreRecord(stored)) as Array<[keyof ClickIds, NonNullable<ClickIds[keyof ClickIds]>]>) {
        if (!entry.created_at) continue;
        const createdMs = Date.parse(entry.created_at);
        if (createdMs > occurredMs || occurredMs - createdMs > this.maxAgeMs) continue;
        fromStore[key] = entry;
      }
    }
    const click_ids: ClickIds = { ...fromStore, ...row.click_ids };

    let utm = row.utm;
    if (Object.keys(utm).length === 0 && stored?.context_captured_at !== undefined) {
      const capturedMs = stored.context_captured_at;
      if (capturedMs <= occurredMs && occurredMs - capturedMs <= this.maxAgeMs) utm = utmFromStoreRecord(stored);
    }

    let fbc: string | null = requestFbc ?? null;
    const fbclid = click_ids.fbclid;
    if (!fbc && fbclid?.created_at) fbc = buildMetaFbc(fbclid.value, Date.parse(fbclid.created_at));
    return { click_ids, utm, fbc };
  }
}
