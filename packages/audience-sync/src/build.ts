/**
 * From fct_audience_candidates rows to list memberships, then to canonical AudienceMember
 * rows (contracts) per platform.
 *
 * Seed lists (for lookalikes / value-based lookalikes):
 *   oa_seed_top_decile_predicted_profit  top 10% of predicted profit among ALL scored users
 *                                        (nearest rank ceil(p x n) in exact decimal arithmetic;
 *                                        ties at the threshold included), > $0
 *   oa_seed_positive_predicted_profit    predicted profit > $0 (value-based: value = predicted profit)
 *   Seeds never include fraud, chargeback or refunded users, whatever their score.
 * Suppression lists (campaign exclusions):
 *   oa_excl_active_subscribers           do not pay to re-acquire paying customers
 *   oa_excl_fraud_or_chargeback          fraud flag or any dispute
 *   oa_excl_refunded                     any refund
 *   oa_excl_low_predicted_profit         predicted profit below lowPredictedProfitMaxUsd (default $0)
 * Every list is filtered on consent (consent.ts). The decile threshold is computed before the
 * consent filter, so a user's seed membership does not move when consent coverage changes.
 */

import type { AudienceMember } from '@openart-signal/contracts';
import { consentEligibility, optOutSignalMissing, type ConsentReason } from './consent.js';
import { identifiersFor, memberKey, type IdentifierKey } from './identifiers.js';
import type { AudienceCandidateRow, AudiencePlatform } from './types.js';

export const LIST_DEFINITIONS = [
  { kind: 'seed_top_decile', list_name: 'oa_seed_top_decile_predicted_profit', reason: 'top_decile_predicted_profit', role: 'seed', valueBased: false },
  { kind: 'seed_positive', list_name: 'oa_seed_positive_predicted_profit', reason: 'positive_predicted_profit', role: 'seed', valueBased: true },
  { kind: 'excl_active_subscribers', list_name: 'oa_excl_active_subscribers', reason: 'active_subscriber_suppression', role: 'exclusion', valueBased: false },
  { kind: 'excl_fraud_or_chargeback', list_name: 'oa_excl_fraud_or_chargeback', reason: 'fraud_or_chargeback_suppression', role: 'exclusion', valueBased: false },
  { kind: 'excl_refunded', list_name: 'oa_excl_refunded', reason: 'refund_suppression', role: 'exclusion', valueBased: false },
  { kind: 'excl_low_predicted_profit', list_name: 'oa_excl_low_predicted_profit', reason: 'low_predicted_profit_suppression', role: 'exclusion', valueBased: false },
] as const;

export type ListDefinition = (typeof LIST_DEFINITIONS)[number];
export type ListKind = ListDefinition['kind'];

export function listByName(listName: string): ListDefinition {
  const def = LIST_DEFINITIONS.find((d) => d.list_name === listName);
  if (!def) throw new Error(`unknown audience list ${listName}`);
  return def;
}

export interface SelectOptions {
  /** Share of scored users in the top seed (0.1 = top decile). */
  topFraction: number;
  /** Users with predicted profit strictly below this go to oa_excl_low_predicted_profit. */
  lowPredictedProfitMaxUsd: number;
}

export const DEFAULT_SELECT_OPTIONS: Readonly<SelectOptions> = Object.freeze({ topFraction: 0.1, lowPredictedProfitMaxUsd: 0 });

export interface AudienceSelection {
  total: number;
  scored: number;
  topDecileThreshold: number | null;
  consent: {
    eligible: number;
    /** Eligible through an explicit CMP grant (consent-required regions). */
    granted: number;
    /** Eligible by default (outside consent-required regions, no denial or opt-out). */
    defaultEligible: number;
    /** Default-eligible users with neither GPC nor a sale/sharing opt-out ever recorded. */
    defaultEligibleWithoutOptOutSignal: number;
    ineligibleByReason: Partial<Record<Exclude<ConsentReason, 'granted' | 'default_eligible'>, number>>;
  };
  /** user_ids dropped by the consent gate (used to label removals "consent_withdrawn"). */
  consentDropped: ReadonlySet<string>;
  members: Record<ListKind, AudienceCandidateRow[]>;
}

const PARTS_PER_BILLION = 1_000_000_000n;

/**
 * Nearest-rank size of the top `fraction` of `n` users, ceil(fraction x n), in exact decimal
 * arithmetic: the fraction is read to 9 decimals and multiplied as integers, so 0.07 x 100 is 7
 * (floating point gives 7.000000000000001 and a ceil of 8). At least 1 when n > 0.
 */
export function topCount(fraction: number, n: number): number {
  if (!(fraction > 0 && fraction <= 1)) throw new Error('topFraction must be in (0, 1]');
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`n must be a non-negative integer, got ${n}`);
  if (n === 0) return 0;
  const ppb = BigInt(Math.round(fraction * 1e9));
  const k = (ppb * BigInt(n) + PARTS_PER_BILLION - 1n) / PARTS_PER_BILLION;
  return Math.min(n, Math.max(1, Number(k)));
}

export function selectAudiences(candidates: readonly AudienceCandidateRow[], opts: SelectOptions = DEFAULT_SELECT_OPTIONS): AudienceSelection {
  if (!(opts.topFraction > 0 && opts.topFraction <= 1)) throw new Error('topFraction must be in (0, 1]');
  const scored = candidates.map((c) => c.predicted_profit).filter((p): p is number => p !== null).sort((a, b) => b - a);
  const k = topCount(opts.topFraction, scored.length);
  const threshold = scored.length > 0 ? scored[k - 1]! : null;

  const members = Object.fromEntries(LIST_DEFINITIONS.map((d) => [d.kind, [] as AudienceCandidateRow[]])) as Record<ListKind, AudienceCandidateRow[]>;
  const ineligibleByReason: AudienceSelection['consent']['ineligibleByReason'] = {};
  const consentDropped = new Set<string>();
  let eligible = 0;
  let granted = 0;
  let defaultEligible = 0;
  let defaultEligibleWithoutOptOutSignal = 0;
  for (const c of candidates) {
    const verdict = consentEligibility(c);
    if (!verdict.eligible) {
      ineligibleByReason[verdict.reason] = (ineligibleByReason[verdict.reason] ?? 0) + 1;
      consentDropped.add(c.user_id);
      continue;
    }
    eligible += 1;
    if (verdict.reason === 'granted') granted += 1;
    else {
      defaultEligible += 1;
      if (optOutSignalMissing(c)) defaultEligibleWithoutOptOutSignal += 1;
    }
    const p = c.predicted_profit;
    const tainted = c.is_fraud || c.has_chargeback || c.has_refund;
    if (p !== null && p > 0 && !tainted) {
      members.seed_positive.push(c);
      if (threshold !== null && p >= threshold) members.seed_top_decile.push(c);
    }
    if (c.is_active_subscriber) members.excl_active_subscribers.push(c);
    if (c.is_fraud || c.has_chargeback) members.excl_fraud_or_chargeback.push(c);
    if (c.has_refund) members.excl_refunded.push(c);
    if (p !== null && p < opts.lowPredictedProfitMaxUsd) members.excl_low_predicted_profit.push(c);
  }
  return {
    total: candidates.length,
    scored: scored.length,
    topDecileThreshold: threshold,
    consent: { eligible, granted, defaultEligible, defaultEligibleWithoutOptOutSignal, ineligibleByReason },
    consentDropped,
    members,
  };
}

export interface PlatformMembers {
  members: AudienceMember[];
  /** Users on a list who have no usable identifier for this platform. */
  skippedNoIdentifier: Record<ListKind, number>;
  /** Users whose identifiers collide with an earlier user on the same list (deduplicated). */
  duplicateIdentifiers: Record<ListKind, number>;
}

const cents = (x: number) => Math.round(x * 100) / 100;

export function audienceMembers(
  platform: AudiencePlatform,
  selection: AudienceSelection,
  o: { computedAt: string; keys?: readonly IdentifierKey[] },
): PlatformMembers {
  const members: AudienceMember[] = [];
  const skippedNoIdentifier = Object.fromEntries(LIST_DEFINITIONS.map((d) => [d.kind, 0])) as Record<ListKind, number>;
  const duplicateIdentifiers = { ...skippedNoIdentifier };
  for (const def of LIST_DEFINITIONS) {
    const seen = new Set<string>();
    for (const c of selection.members[def.kind]) {
      const identifiers = identifiersFor(platform, c, o.keys);
      if (Object.keys(identifiers).length === 0) {
        skippedNoIdentifier[def.kind] += 1;
        continue;
      }
      const key = memberKey(identifiers);
      if (seen.has(key)) {
        duplicateIdentifiers[def.kind] += 1;
        continue;
      }
      seen.add(key);
      members.push({
        platform,
        list_name: def.list_name,
        action: 'add',
        reason: def.reason,
        identifiers,
        value: def.role === 'seed' && c.predicted_profit !== null ? cents(Math.max(0, c.predicted_profit)) : null,
        user_id: c.user_id,
        computed_at: o.computedAt,
      });
    }
  }
  return { members, skippedNoIdentifier, duplicateIdentifiers };
}
