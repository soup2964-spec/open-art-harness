/**
 * Storage/adapters selection from the environment (kept apart from ServiceConfig, which is
 * about behaviour). Defaults are in-memory so `npm run dev` and tests need nothing.
 *
 *   STORE_BACKEND        memory | firestore   (inbox, Stripe join state, parked events, outbox)
 *   FIRESTORE_PROJECT_ID, FIRESTORE_DATABASE (default "(default)"), FIRESTORE_COLLECTION_PREFIX
 *   LEDGER_BACKEND       memory | file | bigquery
 *   LEDGER_FILE          path for the file ledger
 *   BIGQUERY_PROJECT_ID, BIGQUERY_LOCATION
 *   BQ_LEDGER_TABLE, BQ_PURCHASE_VALUE_TABLE, BQ_AD_CLICK_IDS_TABLE, BQ_USER_CONTEXT_TABLE,
 *   BQ_ERASURE_REQUESTS_TABLE   (dataset.table)
 *
 * Live mode refuses in-memory state (assertLiveStorage): an in-memory inbox forgets Stripe
 * redeliveries on restart (double sends) and an in-memory outbox loses queued conversions.
 */

import type { Env, ServiceConfig } from './config.js';

export interface StorageConfig {
  store: 'memory' | 'firestore';
  firestore: { projectId: string; databaseId: string; collectionPrefix: string } | null;
  ledger: 'memory' | 'file' | 'bigquery';
  ledgerFile: string | null;
  bigquery: { projectId: string; location: string | null } | null;
  tables: {
    ledger: { dataset: string; table: string } | null;
    /** fct_purchase_value_score: the purchase-time value (contracts PurchaseValueScore). */
    purchaseValue: { dataset: string; table: string } | null;
    adClickIds: { dataset: string; table: string } | null;
    userContext: { dataset: string; table: string } | null;
    /** Erasure requests the scheduled ledger DELETE consumes (infra bigquery/tables.sql). */
    erasureRequests: { dataset: string; table: string } | null;
  };
}

function table(value: string | undefined, name: string): { dataset: string; table: string } | null {
  if (!value) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (!m) throw new Error(`${name} must be <dataset>.<table>`);
  return { dataset: m[1]!, table: m[2]! };
}

export function loadStorageConfig(env: Env): StorageConfig {
  const store = (env.STORE_BACKEND ?? 'memory') as StorageConfig['store'];
  if (store !== 'memory' && store !== 'firestore') throw new Error('STORE_BACKEND must be memory or firestore');
  const ledger = (env.LEDGER_BACKEND ?? 'memory') as StorageConfig['ledger'];
  if (!['memory', 'file', 'bigquery'].includes(ledger)) throw new Error('LEDGER_BACKEND must be memory, file or bigquery');
  if (store === 'firestore' && !env.FIRESTORE_PROJECT_ID) throw new Error('STORE_BACKEND=firestore needs FIRESTORE_PROJECT_ID');
  if (ledger === 'file' && !env.LEDGER_FILE) throw new Error('LEDGER_BACKEND=file needs LEDGER_FILE');
  if (env.BQ_PREDICTED_PROFIT_TABLE) {
    // The signup+24h estimate (unconditional E[90d profit per exposed user]) is for experiment readouts.
    // Ad values come from the purchase-time score; refuse the old variable so nobody assumes it is used.
    throw new Error('BQ_PREDICTED_PROFIT_TABLE is no longer read: ad values come from BQ_PURCHASE_VALUE_TABLE (fct_purchase_value_score)');
  }
  const tables = {
    ledger: table(env.BQ_LEDGER_TABLE, 'BQ_LEDGER_TABLE'),
    purchaseValue: table(env.BQ_PURCHASE_VALUE_TABLE, 'BQ_PURCHASE_VALUE_TABLE'),
    adClickIds: table(env.BQ_AD_CLICK_IDS_TABLE, 'BQ_AD_CLICK_IDS_TABLE'),
    userContext: table(env.BQ_USER_CONTEXT_TABLE, 'BQ_USER_CONTEXT_TABLE'),
    erasureRequests: table(env.BQ_ERASURE_REQUESTS_TABLE, 'BQ_ERASURE_REQUESTS_TABLE'),
  };
  const needsBq = ledger === 'bigquery' || Object.values(tables).some((t) => t !== null);
  if (needsBq && !env.BIGQUERY_PROJECT_ID) throw new Error('BigQuery tables need BIGQUERY_PROJECT_ID');
  if (ledger === 'bigquery' && !tables.ledger) throw new Error('LEDGER_BACKEND=bigquery needs BQ_LEDGER_TABLE');
  return {
    store,
    firestore:
      store === 'firestore'
        ? { projectId: env.FIRESTORE_PROJECT_ID!, databaseId: env.FIRESTORE_DATABASE ?? '(default)', collectionPrefix: env.FIRESTORE_COLLECTION_PREFIX ?? 'conversion_service_' }
        : null,
    ledger,
    ledgerFile: env.LEDGER_FILE ?? null,
    bigquery: needsBq ? { projectId: env.BIGQUERY_PROJECT_ID!, location: env.BIGQUERY_LOCATION ?? null } : null,
    tables,
  };
}

/** Live mode needs durable state: Firestore for inbox/outbox/join state and BigQuery for the ledger. */
export function assertLiveStorage(config: Pick<ServiceConfig, 'mode'>, storage: StorageConfig): void {
  if (config.mode !== 'live') return;
  if (storage.store !== 'firestore') throw new Error('live mode needs STORE_BACKEND=firestore (an in-memory inbox/outbox loses conversions and dedup state on restart)');
  if (storage.ledger !== 'bigquery') throw new Error('live mode needs LEDGER_BACKEND=bigquery (memory and file ledgers are for local runs)');
}
