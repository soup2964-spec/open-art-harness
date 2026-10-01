import type { PurchaseValueScore } from '@openart-signal/contracts';
import { InMemoryDocumentStore } from '../../src/adapters/document-store.js';
import { FixedFxRates } from '../../src/adapters/fx.js';
import { InMemoryLedger } from '../../src/adapters/ledger.js';
import { InMemoryUserContext } from '../../src/adapters/user-context.js';
import type { UserContext } from '../../src/adapters/user-context.js';
import { InMemoryPurchaseValues, ValueResolver } from '../../src/adapters/value-resolver.js';
import type { ServiceConfig } from '../../src/config.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { MemoryLogger } from '../../src/log.js';
import { Drainer } from '../../src/outbox/drainer.js';
import { Outbox } from '../../src/outbox/outbox.js';
import type { Transport } from '../../src/outbox/transport.js';
import type { PlatformRequest, SendOutcome } from '../../src/platforms/types.js';
import { ManualClock } from '../../src/time.js';
import { testConfig } from './enriched.js';

export class ScriptedTransport implements Transport {
  readonly requests: PlatformRequest[] = [];
  constructor(private readonly script: (req: PlatformRequest) => SendOutcome | Promise<SendOutcome>) {}
  async send(req: PlatformRequest): Promise<SendOutcome> {
    this.requests.push(structuredClone(req));
    return this.script(req);
  }
}

export interface OutboxHarnessOptions {
  transport?: Transport;
  config?: ServiceConfig;
  now?: string;
  users?: UserContext[];
  scores?: PurchaseValueScore[];
}

/** Dispatcher + Drainer over in-memory stores and a manual clock (no HTTP, no network). */
export function outboxHarness(opts: OutboxHarnessOptions = {}) {
  const clock = new ManualClock(Date.parse(opts.now ?? '2026-07-03T17:05:00Z'));
  const store = new InMemoryDocumentStore();
  const ledger = new InMemoryLedger();
  const outbox = new Outbox(store, clock.now);
  const config = opts.config ?? testConfig();
  const dispatcher = new Dispatcher({ config, clock: clock.now, ledger, outbox, store });
  const log = new MemoryLogger();
  const transport = opts.transport ?? new ScriptedTransport(() => ({ kind: 'ok', status: 200, dryRun: true }));
  const userContext = new InMemoryUserContext(opts.users ?? []);
  const scores = new InMemoryPurchaseValues(opts.scores ?? []);
  const values = new ValueResolver(
    { scores, store, fx: new FixedFxRates('USD', {}) },
    { floorMajor: config.value.floorMajor, reportingCurrency: config.value.reportingCurrency, scoreSlaMs: config.value.scoreSlaMs },
  );
  const drainer = new Drainer({ outbox, transport, config, clock: clock.now, log, rng: () => 0.5, userContext, values, store });
  return { clock, store, ledger, outbox, dispatcher, drainer, transport, log, config, userContext, scores, values };
}
