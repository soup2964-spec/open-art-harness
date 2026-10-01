/**
 * Narrow port over @google-cloud/bigquery so adapters are testable with a fake and the
 * real client is only constructed in live wiring (dynamic import, no work at import time).
 */

export interface BigQueryInsertRow {
  /** Best-effort streaming dedup key (BigQuery keeps it about a minute). */
  insertId: string;
  json: Record<string, unknown>;
}

export interface BigQueryPort {
  /** tabledata.insertAll (streaming insert) with raw rows. */
  insert(dataset: string, table: string, rows: BigQueryInsertRow[]): Promise<void>;
  /** Parameterised query; values always go through params, never into the SQL string. */
  query<T>(sql: string, params: Record<string, unknown>, types?: Record<string, unknown>): Promise<T[]>;
}

export interface TableRef {
  projectId: string;
  dataset: string;
  table: string;
}

const PROJECT_ID = /^(?:[a-z][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET_OR_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

/** Validated, backtick-quoted `project.dataset.table` (identifiers cannot be query parameters). */
export function qualifiedTable(ref: TableRef): string {
  if (!PROJECT_ID.test(ref.projectId)) throw new Error(`invalid BigQuery project identifier: ${JSON.stringify(ref.projectId)}`);
  if (!DATASET_OR_TABLE.test(ref.dataset)) throw new Error(`invalid BigQuery dataset identifier: ${JSON.stringify(ref.dataset)}`);
  if (!DATASET_OR_TABLE.test(ref.table)) throw new Error(`invalid BigQuery table identifier: ${JSON.stringify(ref.table)}`);
  return `\`${ref.projectId}.${ref.dataset}.${ref.table}\``;
}

/** BigQuery returns TIMESTAMP as BigQueryTimestamp {value}, INT64 as number or {value}. */
export function bqScalar(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value && Object.keys(value).length === 1) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/** JSON columns come back as strings (or already-parsed objects with parseJSON). */
export function bqJson<T>(value: unknown, fallback: T): T {
  const v = bqScalar(value);
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return JSON.parse(v) as T;
  return v as T;
}

/** Live wiring only: builds the port on the real client. Never called by tests. */
export async function createBigQueryPort(options: { projectId: string; location?: string }): Promise<BigQueryPort> {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const client = new BigQuery({ projectId: options.projectId });
  return {
    async insert(dataset, table, rows) {
      await client.dataset(dataset).table(table).insert(rows, {
        raw: true,
        skipInvalidRows: false,
        ignoreUnknownValues: false,
      });
    },
    async query<T>(sql: string, params: Record<string, unknown>, types?: Record<string, unknown>): Promise<T[]> {
      const [rows] = await client.query({
        query: sql,
        params,
        ...(types ? { types: types as never } : {}),
        ...(options.location ? { location: options.location } : {}),
      });
      return rows as T[];
    },
  };
}
