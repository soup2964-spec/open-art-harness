import type { BigQueryPort, BigQueryInsertRow } from '../../src/adapters/bigquery.js';

/** Records every call; queries return queued results (FIFO) or []. Never touches the network. */
export class FakeBigQuery implements BigQueryPort {
  readonly inserts: Array<{ dataset: string; table: string; rows: BigQueryInsertRow[] }> = [];
  readonly queries: Array<{ sql: string; params: Record<string, unknown>; types?: Record<string, unknown> }> = [];
  readonly queryResults: unknown[][] = [];

  async insert(dataset: string, table: string, rows: BigQueryInsertRow[]): Promise<void> {
    this.inserts.push({ dataset, table, rows: structuredClone(rows) });
  }

  async query<T>(sql: string, params: Record<string, unknown>, types?: Record<string, unknown>): Promise<T[]> {
    this.queries.push({ sql, params, ...(types ? { types } : {}) });
    return (this.queryResults.shift() ?? []) as T[];
  }
}
