/**
 * Credit-ledger entry builder that keeps per-(user, bucket) balances consistent,
 * in the exact shape of GET /suite/api/credits/logs entries[]
 * (src/sources/credit-ledger-entry.schema.json).
 *
 * businessType conventions:
 *   USER_SIGNUP_TRIAL            observed (signup trial grant, reason "New user trial grant")
 *   <model>:<mode>               observed for openart-sdxl:text2image; other capability ids inferred
 *   credit-pack, one-time-pack-purchase   seen in shipped code (research/10 §3.3)
 *   subscription-refill          INFERRED name for SUBSCRIPTION_ADJUSTMENT "Subscription Refill" rows
 */

import type { Prng } from '../cohort/prng.js';

export type CreditField =
  | 'trial_credit_balance'
  | 'subscription_monthly_credit'
  | 'one_time_pack_credit'
  | 'subscription_sponsor_credit';

export type LedgerType = 'ADD' | 'CONSUME' | 'REFUND' | 'SUBSCRIPTION_ADJUSTMENT' | 'INTERNAL_ADJUSTMENT';

export interface LedgerEntry {
  id: string;
  sequenceId: number;
  type: LedgerType;
  amount: number;
  creditField: CreditField;
  balanceBefore: number;
  balanceAfter: number;
  previousSequenceId: number | null;
  reference: { businessType: string; businessId: string };
  idempotencyKey: string;
  createdAt: string;
  userId: string;
  reason?: string;
  businessDetails?: Array<{
    metadata: { projectId: string };
    quantity: number;
    unitCredits: number;
    subBusinessType: string;
  }>;
}

export const REFILL_BUSINESS_TYPE = 'subscription-refill';

const ACTION: Record<LedgerType, string> = {
  ADD: 'ADD',
  CONSUME: 'REDUCE',
  REFUND: 'REFUND',
  SUBSCRIPTION_ADJUSTMENT: 'SUBSCRIPTION_ADJUSTMENT',
  INTERNAL_ADJUSTMENT: 'INTERNAL_ADJUSTMENT',
};

/** Ledger createdAt is truncated to whole seconds (observed `.000Z`). */
export function ledgerTimestamp(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000).toISOString();
}

export class LedgerWriter {
  private readonly balances = new Map<string, number>();
  readonly entries: LedgerEntry[] = [];

  constructor(private readonly prng: Prng) {}

  balance(userId: string, field: CreditField): number {
    return this.balances.get(`${userId}|${field}`) ?? 0;
  }

  private push(
    userId: string,
    field: CreditField,
    type: LedgerType,
    amount: number,
    businessType: string,
    businessId: string,
    atMs: number,
    extra: Pick<LedgerEntry, 'reason' | 'businessDetails'> = {},
  ): LedgerEntry {
    const key = `${userId}|${field}`;
    const before = this.balances.get(key) ?? 0;
    const after = before + amount;
    if (after < 0) throw new Error(`ledger would go negative for ${key}`);
    this.balances.set(key, after);
    const entry: LedgerEntry = {
      id: this.prng.uuidv7(atMs),
      // Observed rows carried sequenceId 0 / previousSequenceId null; mirror that.
      sequenceId: 0,
      type,
      amount,
      creditField: field,
      balanceBefore: before,
      balanceAfter: after,
      previousSequenceId: null,
      reference: { businessType, businessId },
      idempotencyKey: `${businessType}:${ACTION[type]}:${businessId}`,
      createdAt: ledgerTimestamp(atMs),
      userId,
    };
    if (extra.businessDetails) entry.businessDetails = extra.businessDetails;
    if (extra.reason !== undefined) entry.reason = extra.reason;
    this.entries.push(entry);
    return entry;
  }

  signupTrial(userId: string, atMs: number, credits = 40): LedgerEntry {
    return this.push(userId, 'trial_credit_balance', 'ADD', credits, 'USER_SIGNUP_TRIAL', userId, atMs, {
      reason: 'New user trial grant',
    });
  }

  consume(opts: {
    userId: string;
    field: CreditField;
    businessType: string;
    historyId: string;
    projectId: string;
    unitCredits: number;
    quantity: number;
    atMs: number;
  }): LedgerEntry {
    const total = opts.unitCredits * opts.quantity;
    return this.push(opts.userId, opts.field, 'CONSUME', -total, opts.businessType, opts.historyId, opts.atMs, {
      businessDetails: [
        {
          metadata: { projectId: opts.projectId },
          quantity: opts.quantity,
          unitCredits: opts.unitCredits,
          subBusinessType: opts.businessType,
        },
      ],
    });
  }

  /** Failed generation: credits go back to the bucket they came from, referenced by the capability id. */
  refundGeneration(opts: {
    userId: string;
    field: CreditField;
    businessType: string;
    historyId: string;
    credits: number;
    atMs: number;
  }): LedgerEntry {
    return this.push(opts.userId, opts.field, 'REFUND', opts.credits, opts.businessType, opts.historyId, opts.atMs, {
      reason: 'Generation failed',
    });
  }

  /** Subscription refill: amount brings plan credits back to the plan allowance (monthly credits don't roll over). */
  refill(userId: string, invoiceId: string, amount: number, atMs: number): LedgerEntry {
    return this.push(
      userId,
      'subscription_monthly_credit',
      'SUBSCRIPTION_ADJUSTMENT',
      amount,
      REFILL_BUSINESS_TYPE,
      invoiceId,
      atMs,
      { reason: 'Subscription Refill' },
    );
  }

  creditPack(userId: string, invoiceId: string, credits: number, atMs: number): LedgerEntry {
    return this.push(userId, 'subscription_monthly_credit', 'ADD', credits, 'credit-pack', invoiceId, atMs, {
      reason: 'Credit pack purchase',
    });
  }

  oneTimePack(userId: string, purchaseId: string, credits: number, atMs: number): LedgerEntry {
    return this.push(userId, 'one_time_pack_credit', 'ADD', credits, 'one-time-pack-purchase', purchaseId, atMs, {
      reason: 'One-time pack purchase',
    });
  }

  /** Entries for one user, newest first (API order). */
  forUserNewestFirst(userId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.userId === userId).reverse();
  }
}
