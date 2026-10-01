/**
 * Right to erasure. POST /tasks/erase {user_id} (or {hubspot_contact_id} for a lead) deletes, at
 * once, every document this service holds about the person:
 *
 *   outbox, parked Stripe events, inbox, dead letters, value decisions    (user_id field)
 *   Stripe join state: subscriptions, charge refunds, invoice->checkout   (user_id field)
 *   payment intents and charges written from invoice_payment.paid, which carries no customer:
 *     found through the user's purchase invoice ids (from their outbox and inbox records)
 *   HubSpot contact state                                                  (by contact id)
 *
 * and erases the ledger rows (in-memory/file ledgers at once; BigQuery queues a request row that the
 * scheduled DELETE in infra/conversion-service/bigquery/tables.sql applies once the rows have left
 * the streaming buffer). Retention TTLs (retention.ts) cover everything else over time.
 */

import type { DocumentStore } from './adapters/document-store.js';
import type { Ledger, LedgerErasure } from './adapters/ledger.js';
import { VALUE_DECISIONS } from './adapters/value-resolver.js';
import { STRIPE_STATE } from './ingest/stripe-mapper.js';
import { HUBSPOT_CONTACTS } from './ingest/internal-events.js';
import type { Logger } from './log.js';
import { OUTBOX_COLLECTION } from './outbox/outbox.js';
import { DEAD_LETTERS, INBOX, PARKED } from './pipeline/pipeline.js';

export interface ErasureRequest {
  user_id?: string;
  hubspot_contact_id?: string;
}

export interface ErasureReport {
  user_id: string | null;
  hubspot_contact_id: string | null;
  /** Documents deleted per collection. */
  deleted: Record<string, number>;
  ledger: LedgerErasure | 'skipped';
}

/** Collections whose documents carry the user id. */
const BY_USER = [OUTBOX_COLLECTION, PARKED, INBOX, DEAD_LETTERS, VALUE_DECISIONS, STRIPE_STATE.subscriptions, STRIPE_STATE.chargeRefunds, STRIPE_STATE.invoiceCheckout, STRIPE_STATE.paymentIntents, STRIPE_STATE.charges] as const;

/** Firestore IN filters take at most 30 values. */
const IN_LIMIT = 30;

export interface EraserDeps {
  store: DocumentStore;
  ledger: Ledger;
  log: Logger;
}

export class Eraser {
  constructor(private readonly deps: EraserDeps) {}

  async erase(request: ErasureRequest): Promise<ErasureReport> {
    const userId = request.user_id ?? null;
    const contactId = request.hubspot_contact_id ?? null;
    if (!userId && !contactId) throw new Error('erasure needs user_id or hubspot_contact_id');
    const report: ErasureReport = { user_id: userId, hubspot_contact_id: contactId, deleted: {}, ledger: 'skipped' };
    const count = (collection: string, n: number) => {
      report.deleted[collection] = (report.deleted[collection] ?? 0) + n;
    };

    if (userId) {
      const { store } = this.deps;
      const byUser = new Map<string, Array<{ key: string; data: Record<string, unknown> }>>();
      for (const collection of BY_USER) {
        byUser.set(collection, await store.query<Record<string, unknown>>(collection, [{ field: 'user_id', op: '==', value: userId }]));
      }
      // Invoices of the user's purchases: the key to join state that carries no customer.
      const invoices = new Set<string>();
      const addInvoice = (eventId: unknown) => {
        const m = typeof eventId === 'string' ? /^purchase_(in_[A-Za-z0-9]+)$/.exec(eventId) : null;
        if (m) invoices.add(m[1]!);
      };
      for (const doc of byUser.get(OUTBOX_COLLECTION) ?? []) addInvoice(doc.data.event_id);
      for (const doc of byUser.get(INBOX) ?? []) for (const id of ((doc.data.result as { event_ids?: unknown[] } | undefined)?.event_ids ?? [])) addInvoice(id);
      for (const doc of byUser.get(VALUE_DECISIONS) ?? []) addInvoice(doc.data.event_id);

      const invoiceList = [...invoices];
      for (const collection of [STRIPE_STATE.paymentIntents, STRIPE_STATE.charges]) {
        for (let i = 0; i < invoiceList.length; i += IN_LIMIT) {
          const linked = await store.query<Record<string, unknown>>(collection, [{ field: 'invoice_id', op: 'in', value: invoiceList.slice(i, i + IN_LIMIT) }]);
          const known = byUser.get(collection)!;
          for (const doc of linked) if (!known.some((k) => k.key === doc.key)) known.push(doc);
        }
      }
      for (const invoice of invoiceList) {
        const doc = await store.get<Record<string, unknown>>(STRIPE_STATE.invoiceCheckout, invoice);
        const known = byUser.get(STRIPE_STATE.invoiceCheckout)!;
        if (doc && !known.some((k) => k.key === doc.key)) known.push({ key: doc.key, data: doc.data });
      }

      for (const [collection, docs] of byUser) {
        await Promise.all(docs.map((d) => store.delete(collection, d.key)));
        count(collection, docs.length);
      }
      report.ledger = await this.deps.ledger.eraseUser(userId);
    }

    if (contactId) {
      const existing = await this.deps.store.get(HUBSPOT_CONTACTS, contactId);
      if (existing) await this.deps.store.delete(HUBSPOT_CONTACTS, contactId);
      count(HUBSPOT_CONTACTS, existing ? 1 : 0);
    }

    this.deps.log.info('erasure.done', { deleted: report.deleted, ledger: report.ledger });
    return report;
  }
}
