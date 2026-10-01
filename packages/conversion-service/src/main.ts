/**
 * Process entry point (Cloud Run). Builds adapters from the environment, then serves HTTP.
 * With no configuration beyond the two required secrets it runs fully in memory and dry-run;
 * live mode refuses to start without durable storage (Firestore + BigQuery), real-looking
 * secrets and every live platform's credentials.
 */

import { InMemoryClickIdStore, BigQueryClickIdStoreReader } from './adapters/click-id-resolver.js';
import type { ClickIdStoreReader } from './adapters/click-id-resolver.js';
import { createBigQueryPort } from './adapters/bigquery.js';
import type { BigQueryPort } from './adapters/bigquery.js';
import { InMemoryDocumentStore } from './adapters/document-store.js';
import type { DocumentStore } from './adapters/document-store.js';
import { FIRESTORE_SCOPE, FirestoreDocumentStore } from './adapters/firestore-document-store.js';
import { BigQueryLedger, FileLedger, InMemoryLedger } from './adapters/ledger.js';
import type { Ledger } from './adapters/ledger.js';
import { BigQueryUserContextReader, InMemoryUserContext } from './adapters/user-context.js';
import type { UserContextReader } from './adapters/user-context.js';
import { BigQueryPurchaseValueReader, InMemoryPurchaseValues } from './adapters/value-resolver.js';
import type { PurchaseValueReader } from './adapters/value-resolver.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { googleIdTokenVerifier } from './http/oidc.js';
import type { IdTokenVerifier } from './http/oidc.js';
import { EnvAuthProvider, assertLiveCredentials, googleAccessTokenProvider } from './live.js';
import { jsonLogger } from './log.js';
import { DryRunTransport, LiveTransport, RoutingTransport } from './outbox/transport.js';
import type { FetchLike, Transport } from './outbox/transport.js';
import { GOOGLE_DATAMANAGER_SCOPE } from './platforms/google/index.js';
import { installProcessHandlers } from './process.js';
import { createHttpServer } from './server.js';
import { systemClock } from './time.js';
import { assertLiveStorage, loadStorageConfig } from './wiring.js';

/** Cloud Run gives 10 s after SIGTERM; leave room for the exit. */
const SHUTDOWN_GRACE_MS = 9_000;

async function main(): Promise<void> {
  const env = process.env;
  const log = jsonLogger();
  installProcessHandlers(process, log);
  const config = loadConfig(env);
  const storage = loadStorageConfig(env);
  assertLiveStorage(config, storage);
  // Node 22's global fetch satisfies FetchLike as is (bodyless GET/DELETE, redirect: 'error').
  const fetchImpl: FetchLike = globalThis.fetch;

  let store: DocumentStore;
  if (storage.firestore) {
    store = new FirestoreDocumentStore({ ...storage.firestore, fetch: fetchImpl, accessToken: await googleAccessTokenProvider([FIRESTORE_SCOPE]) });
  } else {
    log.warn('store.in_memory', { note: 'inbox/outbox are not durable; use STORE_BACKEND=firestore on Cloud Run' });
    store = new InMemoryDocumentStore();
  }

  const bq: BigQueryPort | null = storage.bigquery ? await createBigQueryPort({ projectId: storage.bigquery.projectId, ...(storage.bigquery.location ? { location: storage.bigquery.location } : {}) }) : null;
  const ref = (t: { dataset: string; table: string }) => ({ projectId: storage.bigquery!.projectId, ...t });

  let ledger: Ledger;
  if (storage.ledger === 'bigquery' && bq && storage.tables.ledger) ledger = new BigQueryLedger(bq, ref(storage.tables.ledger), systemClock, storage.tables.erasureRequests);
  else if (storage.ledger === 'file' && storage.ledgerFile) ledger = new FileLedger(storage.ledgerFile);
  else ledger = new InMemoryLedger();

  const purchaseValues: PurchaseValueReader = bq && storage.tables.purchaseValue ? new BigQueryPurchaseValueReader(bq, ref(storage.tables.purchaseValue)) : new InMemoryPurchaseValues([]);
  if (!storage.tables.purchaseValue) log.warn('value.no_purchase_value_table', { note: 'no BQ_PURCHASE_VALUE_TABLE: every acquisition purchase is sent at cash (value_basis=cash_fallback)' });
  const clickIdStore: ClickIdStoreReader = bq && storage.tables.adClickIds ? new BigQueryClickIdStoreReader(bq, ref(storage.tables.adClickIds)) : new InMemoryClickIdStore({});
  const userContext: UserContextReader = bq && storage.tables.userContext ? new BigQueryUserContextReader(bq, ref(storage.tables.userContext)) : new InMemoryUserContext([]);

  const dryRun = new DryRunTransport(config.dryRunOutDir, env.K_REVISION ? { instanceId: `${env.K_REVISION}-${process.pid}`.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) } : {});
  let transport: Transport = dryRun;
  if (config.mode === 'live') {
    const secret = (name: string) => env[name];
    assertLiveCredentials(config, secret);
    const google = config.livePlatforms.has('google_ads') ? await googleAccessTokenProvider([GOOGLE_DATAMANAGER_SCOPE]) : async () => Promise.reject(new Error('google_ads is not live'));
    transport = new RoutingTransport(dryRun, new LiveTransport(fetchImpl, new EnvAuthProvider(secret, google)), config.livePlatforms);
    log.warn('mode.live', { live_platforms: [...config.livePlatforms], google_validate_only: config.google.validateOnly });
  }

  const idTokenVerifier: IdTokenVerifier | undefined = config.oidc ? await googleIdTokenVerifier() : undefined;
  const app = createApp({ config, clock: systemClock, log, store, ledger, userContext, clickIdStore, purchaseValues, transport, ...(idTokenVerifier ? { idTokenVerifier } : {}) });
  const handle = createHttpServer(app);
  handle.server.listen(config.port, '0.0.0.0', () => log.info('server.listening', { port: config.port, mode: config.mode }));

  // Cloud Run sends SIGTERM and allows 10 s: stop accepting, finish in-flight requests and the drain.
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('server.shutdown', { signal });
    handle
      .shutdown(SHUTDOWN_GRACE_MS)
      .catch((err: unknown) => log.error('server.shutdown_failed', { error: (err as Error).message }))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ severity: 'CRITICAL', message: 'startup_failed', error: (err as Error).message })}\n`);
  process.exit(1);
});
