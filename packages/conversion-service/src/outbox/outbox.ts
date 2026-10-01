/**
 * The outbox: one record per (platform, event_id), keyed `<platform>:<ACTION>:<event_id>`
 * like the credit ledger's `<businessType>:<ACTION>:<businessId>` idempotencyKey. Creation is
 * create-if-absent, so re-processing a source event (Stripe redelivery, a crash between the
 * ledger write and dispatch, a double-generated Stripe event) never queues a second send.
 *
 * Every state change goes through an optimistic-concurrency replace and appends to a bounded
 * history, so two concurrent drains can never both claim a record.
 *
 * Data minimisation and retention:
 *  - a terminal record (sent, validated, dry_run, skipped, dead) drops its platform payload
 *    (hashed identifiers, IP, user agent). The decision, the non-PII meta (dedup key, value and
 *    value_basis) and the user id stay, so adjustments and reports still work;
 *  - every record carries expire_at for the Firestore TTL policy: until its send-by deadline while
 *    it can still be sent, then RETENTION.outboxDays, or outboxAdjustableDays for a purchase send
 *    a refund may still adjust.
 *
 * Held records are read only when due (next_attempt_at_ms <= now): a gate hold is due at its
 * deadline, a value hold every VALUE_SCORE_RECHECK_MS. When a gate is opened the drainer scans all
 * held records once (candidates allHeld).
 */

import type { DocumentStore, StoredDoc } from '../adapters/document-store.js';
import { RETENTION, expireAt } from '../retention.js';
import type { Clock } from '../time.js';
import type { OutboxRecord, OutboxStatus } from '../types.js';

export const OUTBOX_COLLECTION = 'outbox';
const HISTORY_LIMIT = 20;

export const TERMINAL: ReadonlySet<OutboxStatus> = new Set(['sent', 'validated', 'dry_run', 'skipped', 'dead']);

/** When a record may be deleted (see the header). */
export function outboxExpiry(record: OutboxRecord, nowMs: number): string {
  if (TERMINAL.has(record.status)) {
    const adjustable = record.action === 'SEND' && record.event_id.startsWith('purchase_');
    return expireAt(nowMs, adjustable ? RETENTION.outboxAdjustableDays : RETENTION.outboxDays);
  }
  const until = Math.max(nowMs, record.deadline_ms ?? nowMs, record.not_before_ms ?? nowMs, record.next_attempt_at_ms);
  return expireAt(until, RETENTION.outboxDays);
}

/** Terminal records keep no platform payload and no lease; every record gets its expire_at. */
export function finalizeRecord(record: OutboxRecord, nowMs: number): OutboxRecord {
  const r = TERMINAL.has(record.status) ? { ...record, item: null, lease_until_ms: null } : record;
  return { ...r, expire_at: outboxExpiry(r, nowMs) };
}

export class Outbox {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: Clock,
  ) {}

  /** Create-if-absent. Returns false when a record with the same key already exists. */
  async enqueue(record: OutboxRecord): Promise<boolean> {
    return this.store.create(OUTBOX_COLLECTION, record.key, finalizeRecord(record, this.clock()));
  }

  async get(key: string): Promise<StoredDoc<OutboxRecord> | null> {
    return this.store.get<OutboxRecord>(OUTBOX_COLLECTION, key);
  }

  /**
   * Records a drain must look at: due pending work, expired leases, and due held records
   * (every held record when allHeld: a gate configuration changed).
   */
  async candidates(limit: number, options: { allHeld?: boolean } = {}): Promise<StoredDoc<OutboxRecord>[]> {
    const now = this.clock();
    const heldFilters = options.allHeld
      ? [{ field: 'status', op: '==' as const, value: 'held' }]
      : [{ field: 'status', op: '==' as const, value: 'held' }, { field: 'next_attempt_at_ms', op: '<=' as const, value: now }];
    const [pending, inFlight, held] = await Promise.all([
      this.store.query<OutboxRecord>(OUTBOX_COLLECTION, [{ field: 'status', op: '==', value: 'pending' }, { field: 'next_attempt_at_ms', op: '<=', value: now }], { orderBy: 'next_attempt_at_ms', limit }),
      this.store.query<OutboxRecord>(OUTBOX_COLLECTION, [{ field: 'status', op: '==', value: 'in_flight' }, { field: 'lease_until_ms', op: '<=', value: now }], { orderBy: 'lease_until_ms', limit }),
      this.store.query<OutboxRecord>(OUTBOX_COLLECTION, heldFilters, { orderBy: 'next_attempt_at_ms', limit }),
    ]);
    return [...pending, ...inFlight, ...held];
  }

  /** Apply a change with optimistic concurrency; returns the new doc, or null if someone else won. */
  async transition(
    doc: StoredDoc<OutboxRecord>,
    status: OutboxStatus,
    patch: Partial<OutboxRecord> & { reason?: string | null },
  ): Promise<StoredDoc<OutboxRecord> | null> {
    const now = this.clock();
    const reason = patch.reason === undefined ? doc.data.reason : patch.reason;
    const next = finalizeRecord(
      {
        ...doc.data,
        ...patch,
        status,
        reason,
        updated_at_ms: now,
        history: [...doc.data.history, { at_ms: now, status, reason }].slice(-HISTORY_LIMIT),
      },
      now,
    );
    const ok = await this.store.replace(OUTBOX_COLLECTION, doc.key, next, doc.version);
    if (!ok) return null;
    return (await this.store.get<OutboxRecord>(OUTBOX_COLLECTION, doc.key)) ?? null;
  }

  /**
   * Extend a claimed record's lease (no history entry). Returns the new doc, or null when the
   * record changed underneath (another drain reclaimed it): the caller must then leave it alone.
   */
  async renewLease(doc: StoredDoc<OutboxRecord>, leaseMs: number): Promise<StoredDoc<OutboxRecord> | null> {
    if (doc.data.status !== 'in_flight') return null;
    const now = this.clock();
    const next: OutboxRecord = { ...doc.data, lease_until_ms: now + leaseMs, updated_at_ms: now };
    if (!(await this.store.replace(OUTBOX_COLLECTION, doc.key, next, doc.version))) return null;
    return (await this.store.get<OutboxRecord>(OUTBOX_COLLECTION, doc.key)) ?? null;
  }

  /** Every record (tests, reports). */
  async all(): Promise<OutboxRecord[]> {
    return (await this.store.query<OutboxRecord>(OUTBOX_COLLECTION, [])).map((d) => d.data);
  }
}

/** Exponential backoff with full jitter, capped (rng injectable for deterministic tests). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, rng: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(baseMs, Math.floor(ceiling * rng()));
}
