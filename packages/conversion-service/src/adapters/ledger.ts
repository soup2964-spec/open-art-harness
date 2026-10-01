/**
 * LedgerWriter adapters for fct_conversion_ledger's raw landing table.
 * The ledger stores CASH only (contracts decision); predicted value never enters it.
 *
 *   InMemoryLedger   tests
 *   FileLedger       local dry runs (JSONL, survives restarts)
 *   BigQueryLedger   production: streaming insert with insertId = event_id. Reads name their columns
 *                    and are partition-bounded on occurred_at (the table is partitioned by
 *                    DATE(occurred_at) with require_partition_filter), so a lookup never scans the
 *                    whole ledger.
 *
 * Erasure: local ledgers delete at once; BigQuery queues a row in erasure_requests, which the
 * scheduled DELETE in infra/conversion-service/bigquery/tables.sql applies once the rows have left
 * the streaming buffer (BigQuery refuses DML on streaming-buffer rows).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONVERSION_LEDGER_COLUMNS, PURCHASE_EVENT_NAMES, orderLedgerRow } from '@openart-signal/contracts';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { DAY_MS, toUtc } from '../time.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';
import { bqJson, bqScalar, qualifiedTable } from './bigquery.js';
import type { BigQueryPort, TableRef } from './bigquery.js';

export interface LedgerWriteResult {
  written: string[];
  duplicates: string[];
}

/** occurred_at bounds for a lookup (BigQuery prunes partitions outside them). */
export interface OccurredWindow {
  fromMs: number;
  toMs: number;
}

/** Default look-back for a lookup without a window: covers Stripe's refund and dispute horizons. */
export const LEDGER_LOOKBACK_DAYS = 400;

export type LedgerErasure = 'deleted' | 'queued' | 'not_configured';

export interface Ledger {
  /** First write per event_id wins. */
  write(rows: ConversionLedgerEvent[]): Promise<LedgerWriteResult>;
  /** The row for an event id, looked for within `window` (default: the last LEDGER_LOOKBACK_DAYS). */
  get(eventId: string, window?: OccurredWindow): Promise<ConversionLedgerEvent | null>;
  /** True when the user has a purchase row that occurred strictly before `beforeMs` (excluding one event). */
  hasPurchaseBefore(userId: string, beforeMs: number, excludeEventId: string): Promise<boolean>;
  /** Erase every row of a user (right to erasure). */
  eraseUser(userId: string): Promise<LedgerErasure>;
}

const PURCHASES = new Set<string>(PURCHASE_EVENT_NAMES);

export class InMemoryLedger implements Ledger {
  protected readonly rows = new Map<string, ConversionLedgerEvent>();

  async write(rows: ConversionLedgerEvent[]): Promise<LedgerWriteResult> {
    const result: LedgerWriteResult = { written: [], duplicates: [] };
    for (const row of rows) {
      if (this.rows.has(row.event_id)) {
        result.duplicates.push(row.event_id);
        continue;
      }
      this.rows.set(row.event_id, structuredClone(orderLedgerRow(row)));
      this.onWrite(row);
      result.written.push(row.event_id);
    }
    return result;
  }

  /** Hook for FileLedger. */
  protected onWrite(_row: ConversionLedgerEvent): void {}

  async get(eventId: string, _window?: OccurredWindow): Promise<ConversionLedgerEvent | null> {
    const row = this.rows.get(eventId);
    return row ? structuredClone(row) : null;
  }

  async eraseUser(userId: string): Promise<LedgerErasure> {
    for (const [id, row] of this.rows) if (row.user_id === userId) this.rows.delete(id);
    this.onErase();
    return 'deleted';
  }

  /** Hook for FileLedger. */
  protected onErase(): void {}

  async hasPurchaseBefore(userId: string, beforeMs: number, excludeEventId: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.user_id === userId && row.event_id !== excludeEventId && PURCHASES.has(row.event_name) && Date.parse(row.occurred_at) < beforeMs) {
        return true;
      }
    }
    return false;
  }

  /** Every row, in write order. */
  all(): ConversionLedgerEvent[] {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
}

export class FileLedger extends InMemoryLedger {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as ConversionLedgerEvent;
        if (!this.rows.has(row.event_id)) this.rows.set(row.event_id, row);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  protected override onWrite(row: ConversionLedgerEvent): void {
    appendFileSync(this.path, `${JSON.stringify(orderLedgerRow(row))}\n`);
  }

  protected override onErase(): void {
    const lines = [...this.rows.values()].map((r) => JSON.stringify(orderLedgerRow(r)));
    writeFileSync(this.path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }
}

const JSON_COLUMNS = new Set(['click_ids', 'utm', 'experiment_arms']);
const OPTIONAL_CONSENT_FLAGS = ['gpc', 'opt_out_sale_sharing'] as const;
const TIMESTAMP_COLUMNS = new Set(['occurred_at']);

/** Ledger row -> BigQuery row: RECORD columns stay objects, map columns become JSON strings. */
export function toBigQueryRow(row: ConversionLedgerEvent, ingestedAt: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of CONVERSION_LEDGER_COLUMNS) {
    const value = row[col];
    out[col] = JSON_COLUMNS.has(col) ? JSON.stringify(value) : value;
  }
  out.ingested_at = ingestedAt;
  return out;
}

/** BigQuery query result row -> ledger row (inverse of toBigQueryRow). */
export function fromBigQueryRow(bq: Record<string, unknown>): ConversionLedgerEvent {
  const out: Record<string, unknown> = {};
  for (const col of CONVERSION_LEDGER_COLUMNS) {
    const raw = bq[col];
    if (JSON_COLUMNS.has(col)) {
      out[col] = bqJson(raw, {});
    } else if (TIMESTAMP_COLUMNS.has(col)) {
      const v = bqScalar(raw);
      out[col] = typeof v === 'string' ? toUtc(Date.parse(v)) : v;
    } else if (col === 'consent' && raw && typeof raw === 'object') {
      // STRUCT fields added later come back NULL on older rows; Consent has them as optional booleans.
      const consent: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
      for (const flag of OPTIONAL_CONSENT_FLAGS) if (consent[flag] === null || consent[flag] === undefined) delete consent[flag];
      out[col] = consent;
    } else if (col === 'cash_value_minor' || col === 'plan_tier_code' || col === 'credit_pack_quantity' || col === 'schema_version') {
      const v = bqScalar(raw);
      out[col] = v === null || v === undefined ? null : Number(v);
    } else {
      out[col] = raw === undefined ? null : raw;
    }
  }
  return out as unknown as ConversionLedgerEvent;
}

export class BigQueryLedger implements Ledger {
  private readonly table: string;

  constructor(
    private readonly bq: BigQueryPort,
    private readonly ref: TableRef,
    private readonly clock: Clock = systemClock,
    /** Where erasure requests go (same project); null = erasure is not configured. */
    private readonly erasureTable: { dataset: string; table: string } | null = null,
  ) {
    this.table = qualifiedTable(ref);
    if (erasureTable) qualifiedTable({ projectId: ref.projectId, ...erasureTable });
  }

  async write(rows: ConversionLedgerEvent[]): Promise<LedgerWriteResult> {
    if (rows.length === 0) return { written: [], duplicates: [] };
    const ingestedAt = toUtc(this.clock());
    await this.bq.insert(
      this.ref.dataset,
      this.ref.table,
      rows.map((row) => ({ insertId: row.event_id, json: toBigQueryRow(row, ingestedAt) })),
    );
    // Streaming insert cannot report duplicates; fct_conversion_ledger keeps the first row per event_id.
    return { written: rows.map((r) => r.event_id), duplicates: [] };
  }

  async get(eventId: string, window?: OccurredWindow): Promise<ConversionLedgerEvent | null> {
    const now = this.clock();
    const from = window?.fromMs ?? now - LEDGER_LOOKBACK_DAYS * DAY_MS;
    const to = window?.toMs ?? now + DAY_MS;
    const rows = await this.bq.query<Record<string, unknown>>(
      `SELECT ${CONVERSION_LEDGER_COLUMNS.join(', ')}, ingested_at FROM ${this.table} ` +
        'WHERE event_id = @event_id AND occurred_at BETWEEN TIMESTAMP(@from) AND TIMESTAMP(@to) ORDER BY ingested_at ASC LIMIT 1',
      { event_id: eventId, from: toUtc(from), to: toUtc(to) },
    );
    return rows[0] ? fromBigQueryRow(rows[0]) : null;
  }

  async eraseUser(userId: string): Promise<LedgerErasure> {
    if (!this.erasureTable) return 'not_configured';
    const requestedAt = toUtc(this.clock());
    await this.bq.insert(this.erasureTable.dataset, this.erasureTable.table, [
      { insertId: `erase:${userId}:${requestedAt}`, json: { user_id: userId, requested_at: requestedAt } },
    ]);
    return 'queued';
  }

  async hasPurchaseBefore(userId: string, beforeMs: number, excludeEventId: string): Promise<boolean> {
    const rows = await this.bq.query<{ hit: number }>(
      `SELECT 1 AS hit FROM ${this.table} WHERE user_id = @user_id AND event_id != @exclude_event_id AND event_name IN UNNEST(@purchase_event_names) AND occurred_at < TIMESTAMP(@before) LIMIT 1`,
      { user_id: userId, exclude_event_id: excludeEventId, purchase_event_names: [...PURCHASE_EVENT_NAMES], before: toUtc(beforeMs) },
      { purchase_event_names: ['STRING'] },
    );
    return rows.length > 0;
  }
}
