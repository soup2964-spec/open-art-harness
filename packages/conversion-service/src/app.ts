/**
 * Composition root: builds the pipeline from injected adapters. main.ts supplies production
 * adapters (Firestore, BigQuery, live transport) from config; tests supply in-memory ones.
 */

import { ClickIdResolver } from './adapters/click-id-resolver.js';
import type { ClickIdStoreReader } from './adapters/click-id-resolver.js';
import type { DocumentStore } from './adapters/document-store.js';
import { FixedFxRates } from './adapters/fx.js';
import type { FxRateProvider } from './adapters/fx.js';
import type { Ledger } from './adapters/ledger.js';
import type { UserContextReader } from './adapters/user-context.js';
import { ValueResolver } from './adapters/value-resolver.js';
import type { PurchaseValueReader } from './adapters/value-resolver.js';
import type { ServiceConfig } from './config.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { Eraser } from './erasure.js';
import type { IdTokenVerifier } from './http/oidc.js';
import type { Logger } from './log.js';
import { Drainer } from './outbox/drainer.js';
import { Outbox } from './outbox/outbox.js';
import type { Transport } from './outbox/transport.js';
import { Pipeline } from './pipeline/pipeline.js';
import type { Clock } from './time.js';

export interface AppDeps {
  config: ServiceConfig;
  clock: Clock;
  log: Logger;
  store: DocumentStore;
  ledger: Ledger;
  userContext: UserContextReader;
  clickIdStore: ClickIdStoreReader;
  /** Purchase-time value scores (warehouse fct_purchase_value_score): the value ad platforms get. */
  purchaseValues: PurchaseValueReader;
  /** FX to the reporting currency. Default: the static FX_RATES_TO_REPORTING table. */
  fx?: FxRateProvider;
  transport: Transport;
  /** Required for the OIDC-authenticated routes (Pub/Sub push, Cloud Scheduler). */
  idTokenVerifier?: IdTokenVerifier;
  rng?: () => number;
}

export interface App {
  deps: AppDeps;
  pipeline: Pipeline;
  outbox: Outbox;
  drainer: Drainer;
  values: ValueResolver;
  eraser: Eraser;
}

export function createApp(deps: AppDeps): App {
  const { config } = deps;
  const outbox = new Outbox(deps.store, deps.clock);
  const values = new ValueResolver(
    { scores: deps.purchaseValues, store: deps.store, fx: deps.fx ?? new FixedFxRates(config.value.reportingCurrency, config.value.fxRatesToReporting) },
    { floorMajor: config.value.floorMajor, reportingCurrency: config.value.reportingCurrency, scoreSlaMs: config.value.scoreSlaMs },
  );
  const drainer = new Drainer({
    outbox,
    transport: deps.transport,
    config,
    clock: deps.clock,
    log: deps.log,
    userContext: deps.userContext,
    values,
    store: deps.store,
    ...(deps.rng ? { rng: deps.rng } : {}),
  });
  const dispatcher = new Dispatcher({ config, clock: deps.clock, ledger: deps.ledger, outbox, store: deps.store });
  const pipeline = new Pipeline({
    config,
    clock: deps.clock,
    store: deps.store,
    ledger: deps.ledger,
    dispatcher,
    drainer,
    log: deps.log,
    userContext: deps.userContext,
    clickIds: new ClickIdResolver(deps.clickIdStore),
    values,
  });
  const eraser = new Eraser({ store: deps.store, ledger: deps.ledger, log: deps.log });
  return { deps, pipeline, outbox, drainer, values, eraser };
}
