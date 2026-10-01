/**
 * The pipeline: source event -> canonical rows -> ledger -> per-platform outbox -> drain.
 *
 *   inbox       create-if-absent per source record (Stripe event.id, ledger entry id, Amplitude
 *               uuid, HubSpot ids): Stripe redeliveries and backend retries are no-ops.
 *   map         StripeMapper / InternalEventMapper (contracts rules).
 *   park        Stripe events whose join is not known yet wait under a dependency key; they are
 *               re-driven when the key is satisfied, or mapped degraded after PARKING_MAX_MS.
 *               After parking, the event is mapped once more: a join that landed between the map
 *               and the park (its release found nothing to release) is not left for the sweep.
 *               A replay removes the parked copy only AFTER it applied successfully, and a re-park
 *               keeps the first parked_at_ms, so the parking deadline never slides.
 *   enrich      user context, consent, click ids + fbc, contracts validation, hashing, value.
 *   ledger      first write per event_id wins.
 *   dispatch    one outbox record per platform (pending / held / skipped), create-if-absent.
 *   drain       optional, bounded by OUTBOX_DRAIN_BUDGET_MS (Cloud Scheduler drains the rest).
 *
 * The parking sweep isolates failures per parked event: a replay that keeps failing is
 * dead-lettered after PARKING_MAX_SWEEP_ATTEMPTS sweeps instead of blocking the others.
 * Every stored document carries the user id where known (erasure) and an expire_at (retention).
 */

import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { PURCHASE_EVENT_NAMES } from '@openart-signal/contracts';
import type { DocumentStore } from '../adapters/document-store.js';
import type { Ledger } from '../adapters/ledger.js';
import type { ServiceConfig } from '../config.js';
import type { Dispatcher } from '../dispatch/dispatcher.js';
import { InternalEventMapper, internalInboxKey } from '../ingest/internal-events.js';
import type { InternalEventEnvelope } from '../ingest/internal-events.js';
import { StripeMapper } from '../ingest/stripe-mapper.js';
import type { StripeMapResult } from '../ingest/stripe-mapper.js';
import type { StripeEvent } from '../ingest/stripe-types.js';
import type { Logger } from '../log.js';
import type { DrainReport, Drainer } from '../outbox/drainer.js';
import { RETENTION, expireAt } from '../retention.js';
import type { Clock } from '../time.js';
import { MINUTE_MS } from '../time.js';
import type { NormalizedEvent, OutboxRecord } from '../types.js';
import { enrich } from './enrich.js';
import type { EnrichDeps } from './enrich.js';
import { projectStripeEvent } from './projection.js';

export const INBOX = 'inbox';
export const PARKED = 'parked';
export const DEAD_LETTERS = 'dead_letters';

const PURCHASES = new Set<string>(PURCHASE_EVENT_NAMES);
const STALE_PROCESSING_MS = 5 * MINUTE_MS;

export type IngestStatus = 'processed' | 'duplicate' | 'in_progress' | 'ignored' | 'state' | 'parked' | 'dead_lettered';

export interface IngestResult {
  source_key: string;
  status: IngestStatus;
  reason?: string;
  event_ids: string[];
  outbox: Array<Pick<OutboxRecord, 'key' | 'status' | 'reason'>>;
  /** The user the source event belongs to, when known (inbox erasure). */
  user_id?: string | null;
}

interface InboxDoc {
  status: 'processing' | 'done';
  started_at_ms: number;
  finished_at_ms?: number;
  result?: Omit<IngestResult, 'outbox'>;
  user_id: string | null;
  expire_at: string;
}

export interface ParkedDoc {
  dependency: string;
  source_key: string;
  /** When the event was FIRST parked; kept across re-parks so the deadline never slides. */
  parked_at_ms: number;
  reason: string;
  /** Minimal projection of the Stripe event (no billing details or card data). */
  event: StripeEvent;
  user_id: string | null;
  /** Failed sweeps so far; dead-lettered at PARKING_MAX_SWEEP_ATTEMPTS. */
  sweep_attempts: number;
  last_error: string | null;
  expire_at: string;
}

export interface SweepReport {
  /** Parked events past their deadline that the sweep looked at. */
  swept: number;
  failed: number;
  dead_lettered: number;
}

interface ApplyResult {
  ingest: IngestResult;
  released: string[];
  /** Set when the event is (still) parked, under this key. */
  parkedKey?: string;
}

export interface PipelineDeps extends EnrichDeps {
  config: ServiceConfig;
  clock: Clock;
  store: DocumentStore;
  ledger: Ledger;
  dispatcher: Dispatcher;
  drainer: Drainer;
  log: Logger;
}

function stripeCustomer(event: StripeEvent): string | null {
  const customer = (event.data.object as { customer?: unknown }).customer;
  return typeof customer === 'string' && customer.length > 0 ? customer : null;
}

export class Pipeline {
  readonly stripeMapper: StripeMapper;
  readonly internalMapper: InternalEventMapper;

  constructor(private readonly deps: PipelineDeps) {
    this.stripeMapper = new StripeMapper(deps.store, deps.ledger, deps.clock);
    this.internalMapper = new InternalEventMapper(deps.store, { leadConversionStages: deps.config.leadConversionStages }, deps.clock);
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  private async withInbox(sourceKey: string, work: () => Promise<IngestResult>): Promise<IngestResult> {
    const { store, clock } = this.deps;
    const now = clock();
    const fresh: InboxDoc = { status: 'processing', started_at_ms: now, user_id: null, expire_at: expireAt(now, RETENTION.inboxDays) };
    if (!(await store.create(INBOX, sourceKey, fresh))) {
      const existing = await store.get<InboxDoc>(INBOX, sourceKey);
      if (existing?.data.status === 'done') {
        return { source_key: sourceKey, status: 'duplicate', event_ids: existing.data.result?.event_ids ?? [], outbox: [] };
      }
      if (existing && now - existing.data.started_at_ms < STALE_PROCESSING_MS) {
        return { source_key: sourceKey, status: 'in_progress', event_ids: [], outbox: [] };
      }
      // A previous attempt died mid-way: take over (every downstream write is idempotent).
      if (existing && !(await store.replace(INBOX, sourceKey, fresh, existing.version))) {
        return { source_key: sourceKey, status: 'in_progress', event_ids: [], outbox: [] };
      }
    }
    try {
      const result = await work();
      const { outbox: _omit, ...summary } = result;
      const done: InboxDoc = {
        status: 'done',
        started_at_ms: now,
        finished_at_ms: clock(),
        result: summary,
        user_id: result.user_id ?? null,
        expire_at: expireAt(clock(), RETENTION.inboxDays),
      };
      await store.put<InboxDoc>(INBOX, sourceKey, done);
      return result;
    } catch (err) {
      // Let the sender retry: forget the attempt.
      await store.delete(INBOX, sourceKey);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  async ingestStripe(event: StripeEvent): Promise<IngestResult> {
    const sourceKey = `stripe:${event.id}`;
    return this.withInbox(sourceKey, async () => {
      const result = await this.applyStripe(event, sourceKey, false);
      await this.releaseParked(result.released);
      return { ...result.ingest, user_id: result.ingest.user_id ?? stripeCustomer(event) };
    });
  }

  async ingestInternal(envelope: InternalEventEnvelope): Promise<IngestResult> {
    const sourceKey = `internal:${internalInboxKey(envelope)}`;
    return this.withInbox(sourceKey, async () => {
      const mapped = await this.internalMapper.map(envelope);
      if (mapped.kind === 'ignore') return { source_key: sourceKey, status: 'ignored', reason: mapped.reason, event_ids: [], outbox: [] };
      if (mapped.kind === 'state') return { source_key: sourceKey, status: 'state', reason: mapped.note, event_ids: [], outbox: [] };
      return this.processRows(sourceKey, mapped.rows);
    });
  }

  /** Turn one mapping result into its effect (park it, process its rows, or nothing). */
  private async handleMapped(
    mapped: StripeMapResult,
    event: StripeEvent,
    sourceKey: string,
    prior: ParkedDoc | null,
  ): Promise<ApplyResult> {
    const released = [...mapped.satisfies];
    switch (mapped.kind) {
      case 'ignore':
        return { ingest: { source_key: sourceKey, status: 'ignored', reason: mapped.reason, event_ids: [], outbox: [] }, released };
      case 'state':
        return { ingest: { source_key: sourceKey, status: 'state', reason: mapped.note, event_ids: [], outbox: [] }, released };
      case 'park': {
        const parkedAt = prior?.parked_at_ms ?? this.deps.clock();
        const key = `${mapped.dependency}|${event.id}`;
        const doc: ParkedDoc = {
          dependency: mapped.dependency,
          source_key: sourceKey,
          parked_at_ms: parkedAt,
          reason: mapped.reason,
          event: projectStripeEvent(event),
          user_id: stripeCustomer(event),
          sweep_attempts: prior?.sweep_attempts ?? 0,
          last_error: prior?.last_error ?? null,
          expire_at: expireAt(parkedAt, RETENTION.parkedDays),
        };
        await this.deps.store.put(PARKED, key, doc);
        this.deps.log.info('stripe.parked', { event_id: event.id, dependency: mapped.dependency, reason: mapped.reason });
        return { ingest: { source_key: sourceKey, status: 'parked', reason: mapped.reason, event_ids: [], outbox: [] }, released, parkedKey: key };
      }
      case 'rows': {
        const ingest = await this.processRows(sourceKey, mapped.rows);
        for (const id of ingest.event_ids) if (id.startsWith('purchase_')) released.push(`purchase:${id}`);
        return { ingest, released };
      }
      default: {
        const never: never = mapped;
        throw new Error(`unexpected mapping result ${String(never)}`);
      }
    }
  }

  /**
   * Map and apply a Stripe event. `prior` is the parked copy being replayed: it is removed only
   * after the apply succeeded and only if the event no longer lives under that key (a re-park under
   * the same key has just overwritten it). A failure leaves it exactly where it was.
   */
  private async applyStripe(event: StripeEvent, sourceKey: string, degraded: boolean, prior: { key: string; doc: ParkedDoc } | null = null): Promise<ApplyResult> {
    let result = await this.handleMapped(await this.stripeMapper.map(event, { degraded }), event, sourceKey, prior?.doc ?? null);
    if (result.parkedKey && !degraded) {
      // The join may have landed between the map and the park, and its release found nothing to
      // release. Now that the parked copy is visible to any later release, map once more.
      const again = await this.stripeMapper.map(event, { degraded: false });
      const againKey = again.kind === 'park' ? `${again.dependency}|${event.id}` : null;
      if (againKey !== result.parkedKey) {
        const firstKey = result.parkedKey;
        const firstDoc = (await this.deps.store.get<ParkedDoc>(PARKED, firstKey))?.data ?? prior?.doc ?? null;
        const second = await this.handleMapped(again, event, sourceKey, firstDoc);
        if (second.parkedKey !== firstKey) await this.deps.store.delete(PARKED, firstKey);
        result = { ...second, released: [...result.released, ...second.released] };
      }
    }
    if (prior && result.parkedKey !== prior.key) await this.deps.store.delete(PARKED, prior.key);
    return result;
  }

  /** Map a parked event again (it stays parked unless the apply succeeds). */
  private async replayParked(key: string, doc: ParkedDoc, degraded: boolean): Promise<ApplyResult> {
    return this.applyStripe(doc.event, doc.source_key, degraded, { key, doc });
  }

  /** Re-drive parked events whose dependency just became known (transitively). */
  private async releaseParked(dependencies: string[]): Promise<void> {
    const queue = [...dependencies];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const dependency = queue.shift()!;
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      const waiting = await this.deps.store.query<ParkedDoc>(PARKED, [{ field: 'dependency', op: '==', value: dependency }]);
      for (const doc of waiting) {
        const { ingest, released } = await this.replayParked(doc.key, doc.data, false);
        this.deps.log.info('stripe.unparked', { source_key: doc.data.source_key, dependency, status: ingest.status });
        queue.push(...released);
      }
    }
  }

  /**
   * Parked events past the deadline are mapped with whatever is known (cash kept, joins null).
   * Each one is isolated: a failure is recorded on its parked copy and, after
   * PARKING_MAX_SWEEP_ATTEMPTS failed sweeps, it moves to the dead letters.
   */
  async sweepParked(): Promise<SweepReport> {
    const { store, clock, config, log } = this.deps;
    const cutoff = clock() - config.parking.maxParkMs;
    const stale = await store.query<ParkedDoc>(PARKED, [{ field: 'parked_at_ms', op: '<=', value: cutoff }]);
    const report: SweepReport = { swept: stale.length, failed: 0, dead_lettered: 0 };
    for (const doc of stale) {
      try {
        const { ingest, released } = await this.replayParked(doc.key, doc.data, true);
        log.warn('stripe.parking_deadline', { source_key: doc.data.source_key, dependency: doc.data.dependency, status: ingest.status });
        await this.releaseParked(released);
      } catch (err) {
        report.failed += 1;
        const message = (err as Error).message;
        const attempts = (doc.data.sweep_attempts ?? 0) + 1;
        log.error('stripe.parked_replay_failed', { source_key: doc.data.source_key, attempts, error: message });
        if (attempts >= config.parking.maxSweepAttempts) {
          await store.put(DEAD_LETTERS, `${doc.data.source_key}|parked`, {
            source_key: doc.data.source_key,
            event_id: doc.data.event.id,
            reason: 'parked_replay_failed',
            errors: [message],
            attempts,
            user_id: doc.data.user_id ?? null,
            at_ms: clock(),
            expire_at: expireAt(clock(), RETENTION.deadLetterDays),
          });
          await store.delete(PARKED, doc.key);
          report.dead_lettered += 1;
        } else {
          await store.put(PARKED, doc.key, { ...doc.data, sweep_attempts: attempts, last_error: message });
        }
      }
    }
    return report;
  }

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  private async processRows(sourceKey: string, rows: NormalizedEvent[]): Promise<IngestResult> {
    const { ledger, dispatcher, clock, store, log } = this.deps;
    const eventIds: string[] = [];
    const outbox: IngestResult['outbox'] = [];
    const userId = rows.find((n) => n.row.user_id)?.row.user_id ?? null;
    for (const n of rows) {
      const enriched = await enrich(n, this.deps, clock());
      if (!enriched.ok) {
        await store.put(DEAD_LETTERS, `${sourceKey}|${n.row.event_id || 'unknown'}`.replace(/\//g, '_'), {
          source_key: sourceKey,
          event_id: n.row.event_id,
          reason: 'canonical_row_invalid',
          errors: enriched.errors,
          user_id: n.row.user_id,
          at_ms: clock(),
          expire_at: expireAt(clock(), RETENTION.deadLetterDays),
        });
        log.error('pipeline.row_invalid', { source_key: sourceKey, event_id: n.row.event_id, errors: enriched.errors });
        return { source_key: sourceKey, status: 'dead_lettered', reason: 'canonical_row_invalid', event_ids: eventIds, outbox, user_id: userId };
      }
      const row: ConversionLedgerEvent = enriched.event.row;
      await ledger.write([row]);
      const records = await dispatcher.dispatch(enriched.event);
      eventIds.push(row.event_id);
      outbox.push(...records.map((r) => ({ key: r.key, status: r.status, reason: r.reason })));
      log.info('pipeline.row', {
        source_key: sourceKey,
        event_id: row.event_id,
        event_name: row.event_name,
        purchase: PURCHASES.has(row.event_name),
        value_basis: enriched.event.value?.basis ?? null,
        value_pending: enriched.event.value?.pending ?? false,
        outbox: records.map((r) => `${r.platform}:${r.status}${r.reason ? `:${r.reason}` : ''}`),
      });
    }
    return { source_key: sourceKey, status: 'processed', event_ids: eventIds, outbox, user_id: userId };
  }

  async drain(budgetMs?: number): Promise<DrainReport> {
    return this.deps.drainer.drain(budgetMs === undefined ? {} : { budgetMs });
  }
}
