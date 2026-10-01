/**
 * Membership diff for ONE platform list against the previous snapshot (the members this job
 * last uploaded). Removals are the only way a customer-list member leaves a list, so every
 * user who stops qualifying (profit dropped, became a subscriber, withdrew consent, changed
 * email, was deleted) is sent as a removal with the identifiers that were uploaded before.
 *
 * Value-based lists (Meta LOOKALIKE_VALUE) are diffed on (identifiers, value bucket): a member
 * whose predicted-profit value moved to another bucket is an UPDATE and is re-uploaded with the
 * new value. Buckets are relative (20% steps by default), so cent-level noise in a daily score does
 * not re-upload the whole list. Lists that carry no value pass no bucket function and ignore it.
 */

import type { AudienceMember } from '@openart-signal/contracts';
import { memberKey } from './identifiers.js';

export interface MemberDiff {
  adds: AudienceMember[];
  removes: AudienceMember[];
  /** Still on the list, value moved to another bucket: re-upload (action "add", reason "value_changed"). */
  updates: AudienceMember[];
  unchanged: number;
}

export interface DiffOptions {
  reasonFor?: (removed: AudienceMember) => string;
  /** Bucket of a member's value, for lists whose platform stores it; omit for the others. */
  valueBucket?: (value: number | null) => string;
}

/**
 * Relative value bucket: floor(log(v) / log(1 + step)) for v >= 1, with separate buckets for
 * "no value", 0 (or less) and (0, 1).
 */
export function valueBucket(value: number | null, step = 0.2): string {
  if (!(step > 0)) throw new Error('value bucket step must be > 0');
  if (value === null) return 'none';
  if (!(value > 0)) return '0';
  if (value < 1) return '<1';
  return String(Math.floor(Math.log(value) / Math.log1p(step) + 1e-9));
}

export function diffMembers(previous: readonly AudienceMember[], current: readonly AudienceMember[], computedAt: string, opts: DiffOptions = {}): MemberDiff {
  const scope = new Set([...previous, ...current].map((m) => `${m.platform}|${m.list_name}`));
  if (scope.size > 1) throw new Error(`diffMembers expects rows of one platform and list, got ${[...scope].join(', ')}`);
  const prev = new Map(previous.map((m) => [memberKey(m.identifiers), m]));
  const curr = new Map(current.map((m) => [memberKey(m.identifiers), m]));
  const adds = [...curr.entries()].filter(([k]) => !prev.has(k)).map(([, m]) => ({ ...m, action: 'add' as const }));
  const removes = [...prev.entries()]
    .filter(([k]) => !curr.has(k))
    .map(([, m]) => ({ ...m, action: 'remove' as const, reason: opts.reasonFor?.(m) ?? 'left_list', computed_at: computedAt }));
  const bucket = opts.valueBucket;
  const updates = bucket
    ? [...curr.entries()]
        .filter(([k, m]) => prev.has(k) && bucket(prev.get(k)!.value) !== bucket(m.value))
        .map(([, m]) => ({ ...m, action: 'add' as const, reason: 'value_changed', computed_at: computedAt }))
    : [];
  return { adds, removes, updates, unchanged: curr.size - adds.length - updates.length };
}
