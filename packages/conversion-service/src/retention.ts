/**
 * Retention for everything the service stores (config.ts used to declare this without using it).
 *
 * Firestore: every document carries `expire_at` (RFC 3339). FirestoreDocumentStore writes it as a
 * Timestamp and a TTL policy per collection group deletes the document after that time
 * (infra/conversion-service/firestore.indexes.json). Writers refresh it on every write, so a
 * long-lived subscription's join state never expires while the subscription keeps paying.
 * BigQuery: partition expiration on the ledger and click-id tables (infra bigquery/tables.sql).
 * Erasure by user id is separate and immediate (src/erasure.ts, POST /tasks/erase).
 */

import { toUtc } from './time.js';

const DAY = 86_400_000;

export const RETENTION = {
  /** Terminal outbox records that nothing will ever adjust (signups, leads, skips). */
  outboxDays: 30,
  /**
   * Purchase sends: an adjustment (refund, chargeback) must still find the original send.
   * Google adjusts up to 54 days after the conversion and Microsoft up to 90, so keep 100.
   */
  outboxAdjustableDays: 100,
  /** Webhook/event inbox: Stripe retries for 3 days; a redelivery must still be recognised. */
  inboxDays: 35,
  /** Parked Stripe events are swept after PARKING_MAX_MS (6 h); this is only the safety net. */
  parkedDays: 7,
  deadLetterDays: 30,
  /** First-decision-wins value records (server send and GET /value must agree). */
  valueDecisionDays: 100,
  /** Stripe join state and HubSpot contact state, refreshed on every write. */
  stateDays: 400,
  dayMs: DAY,
} as const;

/** expire_at for a document written at nowMs that should live `days` days. */
export function expireAt(nowMs: number, days: number): string {
  return toUtc(nowMs + days * DAY);
}
