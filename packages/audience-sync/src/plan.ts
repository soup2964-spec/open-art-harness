/**
 * One audience sync: candidates + the previous snapshot -> per-platform, per-list diffs,
 * dry-run requests, the canonical AudienceMember change rows and the next snapshot.
 *
 * The snapshot is what each platform list contains after the last successful sync (the
 * exact identifiers uploaded, and the value for value-based lists). Adds held back by a
 * minimum-size rule are NOT written to the next snapshot, so they are retried on the next run; a
 * TikTok audience deleted to honour removals comes back empty, every member it held is logged as
 * removed, and its id is cleared in `nextAudienceIds`. Persist `nextSnapshot` and
 * `nextAudienceIds` only after every request succeeded.
 */

import { AudienceMemberSchema, type AudienceMember } from '@openart-signal/contracts';
import { z } from 'zod';
import { audienceMembers, DEFAULT_SELECT_OPTIONS, LIST_DEFINITIONS, selectAudiences, type ListKind, type SelectOptions } from './build.js';
import { diffMembers, valueBucket } from './diff.js';
import { memberKey, type IdentifierKey } from './identifiers.js';
import type { AudienceHttpRequest } from './platforms/common.js';
import { googleRequests, type GoogleConfig } from './platforms/google.js';
import { metaRequests, type MetaConfig } from './platforms/meta.js';
import { tiktokRequests, type TikTokConfig } from './platforms/tiktok.js';
import type { AudienceCandidateRow, AudiencePlatform } from './types.js';

export interface AudienceSyncConfig {
  select: SelectOptions;
  google_ads: (GoogleConfig & { enabled: boolean }) | null;
  meta: (MetaConfig & { enabled: boolean }) | null;
  tiktok: (TikTokConfig & { enabled: boolean }) | null;
}

const idMap = z.record(z.string(), z.string().min(1));
export const AudienceSyncConfigSchema = z.strictObject({
  _comment: z.string().optional(),
  select: z.strictObject({ topFraction: z.number().gt(0).max(1), lowPredictedProfitMaxUsd: z.number() }),
  google_ads: z
    .strictObject({
      enabled: z.boolean(),
      operatingAccountId: z.string(),
      loginAccountId: z.string().nullable(),
      userListIds: idMap,
      validateOnly: z.boolean(),
      minListSize: z.number().int().min(1),
      maxMembersPerRequest: z.number().int().min(1).max(10_000),
    })
    .nullable(),
  meta: z
    .strictObject({
      enabled: z.boolean(),
      apiVersion: z.string().regex(/^v\d+\.\d+$/),
      adAccountId: z.string().regex(/^act_\S+$/),
      audienceIds: idMap,
      valueBasedLists: z.array(z.string()),
      schemaMode: z.enum(['multi_key', 'email_sha256']),
      minListSize: z.number().int().min(1),
      maxUsersPerRequest: z.number().int().min(1).max(10_000),
    })
    .nullable(),
  tiktok: z
    .strictObject({
      enabled: z.boolean(),
      advertiserId: z.string().regex(/^\d+$/),
      audienceIds: z.record(z.string(), z.string().min(1).nullable()),
      calculateType: z.enum(['EMAIL_SHA256', 'PHONE_SHA256']),
      minAudienceSize: z.number().int().min(1000),
      maxLinesPerFile: z.number().int().min(1),
      maxFilePathsPerCall: z.number().int().min(1).max(50),
      retentionInDays: z.number().int().min(1).max(365).nullable(),
    })
    .nullable(),
});

export function parseAudienceSyncConfig(raw: unknown): AudienceSyncConfig {
  const parsed = AudienceSyncConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid audience config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const { _comment, ...config } = parsed.data;
  void _comment;
  return config;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export type Snapshot = Map<string, AudienceMember[]>;

export const snapshotKey = (platform: AudiencePlatform, listName: string) => `${platform}|${listName}`;

/** Validate stored snapshot rows (JSONL of AudienceMember with action "add"). */
export function parseSnapshot(rows: readonly unknown[]): Snapshot {
  const out: Snapshot = new Map();
  rows.forEach((raw, i) => {
    const parsed = AudienceMemberSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`snapshot row ${i}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    if (parsed.data.action !== 'add') throw new Error(`snapshot row ${i}: snapshots hold members (action "add") only`);
    const key = snapshotKey(parsed.data.platform as AudiencePlatform, parsed.data.list_name);
    out.set(key, [...(out.get(key) ?? []), parsed.data]);
  });
  return out;
}

export function snapshotRows(snapshot: Snapshot): AudienceMember[] {
  return [...snapshot.keys()].sort().flatMap((k) => snapshot.get(k)!);
}

const AudienceIdsSchema = z.strictObject({ tiktok: z.record(z.string(), z.string().min(1).nullable()) });

/** Validate a stored nextAudienceIds file (CLI --audience-ids). */
export function parseAudienceIds(raw: unknown): AudienceIds {
  const parsed = AudienceIdsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid audience ids: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface ListPlan {
  platform: AudiencePlatform;
  listName: string;
  role: 'seed' | 'exclusion';
  current: number;
  previous: number;
  adds: number;
  removes: number;
  /** Members whose value moved to another bucket (value-based lists only). */
  updates: number;
  unchanged: number;
  sentAdds: number;
  sentRemoves: number;
  sentUpdates: number;
  held: string | null;
  deleted: boolean;
  skippedNoIdentifier: number;
  duplicateIdentifiers: number;
  removalReasons: Record<string, number>;
  requestIds: string[];
}

/** Platform audience ids that change during a sync (TikTok creates and deletes audiences). */
export interface AudienceIds {
  tiktok: Record<string, string | null>;
}

export interface AudienceSyncPlan {
  runId: string;
  computedAt: string;
  selection: {
    total: number;
    scored: number;
    topDecileThreshold: number | null;
    consentEligible: number;
    consentGranted: number;
    consentDefaultEligible: number;
    /** Default-eligible users with neither GPC nor a sale/sharing opt-out ever recorded. */
    defaultEligibleWithoutOptOutSignal: number;
    consentIneligibleByReason: Record<string, number>;
    usersPerList: Record<ListKind, number>;
  };
  lists: ListPlan[];
  requests: AudienceHttpRequest[];
  /** Canonical AudienceMember rows for every add/update/remove this plan sends. */
  changes: AudienceMember[];
  nextSnapshot: Snapshot;
  /** Audience ids after this sync: pass them back as `audienceIds` (CLI --audience-ids) next time. */
  nextAudienceIds: AudienceIds;
}

function keysFor(platform: AudiencePlatform, config: AudienceSyncConfig): IdentifierKey[] {
  if (platform === 'google_ads') return ['email_sha256', 'phone_sha256'];
  if (platform === 'meta') return config.meta?.schemaMode === 'email_sha256' ? ['email_sha256'] : ['email_sha256', 'phone_sha256', 'external_id_sha256'];
  return [config.tiktok?.calculateType === 'PHONE_SHA256' ? 'phone_sha256' : 'email_sha256'];
}

export function planAudienceSync(o: {
  candidates: readonly AudienceCandidateRow[];
  previous: Snapshot;
  config: AudienceSyncConfig;
  computedAt: string;
  runId?: string;
  /** Audience ids from the previous sync's nextAudienceIds; they override the config file. */
  audienceIds?: Partial<AudienceIds>;
}): AudienceSyncPlan {
  if (!/Z$/.test(o.computedAt) || Number.isNaN(Date.parse(o.computedAt))) throw new Error('computedAt must be an RFC 3339 UTC timestamp');
  const runId = o.runId ?? o.computedAt.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const selection = selectAudiences(o.candidates, o.config.select ?? DEFAULT_SELECT_OPTIONS);
  const candidateIds = new Set(o.candidates.map((c) => c.user_id));
  const lists: ListPlan[] = [];
  const requests: AudienceHttpRequest[] = [];
  const changes: AudienceMember[] = [];
  const nextSnapshot: Snapshot = new Map(o.previous);
  const tiktokConfig = o.config.tiktok ? { ...o.config.tiktok, audienceIds: { ...o.config.tiktok.audienceIds, ...(o.audienceIds?.tiktok ?? {}) } } : null;
  const nextAudienceIds: AudienceIds = { tiktok: { ...(tiktokConfig?.audienceIds ?? {}) } };

  const platforms: AudiencePlatform[] = (['google_ads', 'meta', 'tiktok'] as const).filter((p) => o.config[p]?.enabled);
  for (const platform of platforms) {
    const built = audienceMembers(platform, selection, { computedAt: o.computedAt, keys: keysFor(platform, o.config) });
    for (const def of LIST_DEFINITIONS) {
      const key = snapshotKey(platform, def.list_name);
      const previous = o.previous.get(key) ?? [];
      const current = built.members.filter((m) => m.list_name === def.list_name);
      const currentUsers = new Set(current.map((m) => m.user_id));
      // Only a list whose platform stores the value is diffed on it (Meta value-based seeds).
      const valueBased = platform === 'meta' && (o.config.meta?.valueBasedLists ?? []).includes(def.list_name);
      const diff = diffMembers(previous, current, o.computedAt, {
        reasonFor: (m) =>
          m.user_id && selection.consentDropped.has(m.user_id)
            ? 'consent_withdrawn'
            : m.user_id && currentUsers.has(m.user_id)
              ? 'identifier_changed'
              : m.user_id && !candidateIds.has(m.user_id)
                ? 'no_longer_a_candidate'
                : 'no_longer_qualifies',
        ...(valueBased ? { valueBucket: (v: number | null) => valueBucket(v) } : {}),
      });
      // Value updates are re-uploads: they travel with the adds (Meta takes the new LOOKALIKE_VALUE).
      const input = { listName: def.list_name, adds: [...diff.adds, ...diff.updates], removes: diff.removes, previousSize: previous.length, sizeAfter: current.length, runId };
      let out: { requests: AudienceHttpRequest[]; held: string | null; deleted?: boolean };
      if (platform === 'google_ads') out = googleRequests({ ...input, config: o.config.google_ads! });
      else if (platform === 'meta') out = metaRequests({ ...input, config: o.config.meta! });
      else {
        const t = tiktokRequests({ ...input, config: tiktokConfig! });
        nextAudienceIds.tiktok[def.list_name] = t.audienceIdAfter;
        out = t;
      }

      const sentOps = new Set(out.requests.map((r) => r.operation));
      const deleted = out.deleted === true;
      const addsSent = !deleted && (sentOps.has('add') || sentOps.has('create'));
      const removesSent = deleted || sentOps.has('remove');
      // Next snapshot = what the platform list holds once these requests succeed.
      const leaving = new Set(diff.removes.map((m) => memberKey(m.identifiers)));
      if (deleted) nextSnapshot.set(key, []);
      else {
        const next = new Map(previous.map((m) => [memberKey(m.identifiers), m]));
        if (removesSent) for (const k of leaving) next.delete(k);
        if (addsSent) for (const m of [...diff.adds, ...diff.updates]) next.set(memberKey(m.identifiers), { ...m, action: 'add' });
        nextSnapshot.set(key, [...next.values()]);
      }
      if (addsSent) changes.push(...diff.adds, ...diff.updates);
      if (removesSent) changes.push(...diff.removes);
      // A deleted audience also drops the members who still qualify: log them too (they are re-added
      // when the audience is recreated, because the next snapshot is empty).
      if (deleted) {
        for (const m of previous) {
          if (!leaving.has(memberKey(m.identifiers))) changes.push({ ...m, action: 'remove', reason: 'audience_deleted', computed_at: o.computedAt });
        }
      }
      requests.push(...out.requests);
      const removalReasons: Record<string, number> = {};
      for (const m of diff.removes) removalReasons[m.reason] = (removalReasons[m.reason] ?? 0) + 1;
      lists.push({
        platform,
        listName: def.list_name,
        role: def.role,
        current: current.length,
        previous: previous.length,
        adds: diff.adds.length,
        removes: diff.removes.length,
        updates: diff.updates.length,
        unchanged: diff.unchanged,
        sentAdds: addsSent ? diff.adds.length : 0,
        sentRemoves: removesSent ? (deleted ? previous.length : diff.removes.length) : 0,
        sentUpdates: addsSent ? diff.updates.length : 0,
        held: out.held,
        deleted,
        skippedNoIdentifier: built.skippedNoIdentifier[def.kind],
        duplicateIdentifiers: built.duplicateIdentifiers[def.kind],
        removalReasons,
        requestIds: out.requests.map((r) => r.id),
      });
    }
  }
  // Every change row must satisfy the canonical contract before anything could be sent.
  for (const m of changes) {
    const parsed = AudienceMemberSchema.safeParse(m);
    if (!parsed.success) throw new Error(`invalid AudienceMember for ${m.platform}/${m.list_name}: ${JSON.stringify(parsed.error.issues)}`);
  }
  return {
    runId,
    computedAt: o.computedAt,
    selection: {
      total: selection.total,
      scored: selection.scored,
      topDecileThreshold: selection.topDecileThreshold,
      consentEligible: selection.consent.eligible,
      consentGranted: selection.consent.granted,
      consentDefaultEligible: selection.consent.defaultEligible,
      defaultEligibleWithoutOptOutSignal: selection.consent.defaultEligibleWithoutOptOutSignal,
      consentIneligibleByReason: selection.consent.ineligibleByReason as Record<string, number>,
      usersPerList: Object.fromEntries(LIST_DEFINITIONS.map((d) => [d.kind, selection.members[d.kind].length])) as Record<ListKind, number>,
    },
    lists,
    requests,
    changes,
    nextSnapshot,
    nextAudienceIds,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function renderPlanReport(plan: AudienceSyncPlan): string {
  const L: string[] = [];
  const s = plan.selection;
  L.push(`# Audience sync plan ${plan.runId} (DRY RUN: nothing is sent)`);
  L.push('');
  L.push(`Candidates: ${s.total} users, ${s.scored} with a predicted profit. Top-decile threshold: ${s.topDecileThreshold === null ? 'n/a' : `$${s.topDecileThreshold.toFixed(2)}`}.`);
  const why = Object.entries(s.consentIneligibleByReason).map(([k, v]) => `${k} ${v}`).join(', ');
  L.push(
    `Consent gate (contracts CONSENT_REQUIRED_REGIONS need explicit CMP grants of ad_user_data AND ad_personalization; elsewhere eligible unless GPC, a sale/sharing opt-out or any explicit denial): ` +
      `${s.consentEligible} eligible (${s.consentGranted} by CMP grant, ${s.consentDefaultEligible} by default)${why ? `; excluded: ${why}` : ''}.`,
  );
  if (s.defaultEligibleWithoutOptOutSignal > 0) {
    L.push(
      `**Warning:** ${s.defaultEligibleWithoutOptOutSignal} default-eligible user(s) have no GPC or sale/sharing opt-out recorded. If those signals are not captured upstream, opt-outs cannot be honoured: confirm they reach fct_audience_candidates before any upload.`,
    );
  }
  L.push('');
  L.push('| Platform | List | Role | Members now | Before | Adds | Value updates | Removes | Sent (adds / updates / removes) | Held / note | Requests |');
  L.push('|---|---|---|---:|---:|---:|---:|---:|---|---|---:|');
  for (const l of plan.lists) {
    const reasons = Object.entries(l.removalReasons).map(([k, v]) => `${k} ${v}`).join(', ');
    const note = [l.held, l.skippedNoIdentifier ? `${l.skippedNoIdentifier} without a usable identifier` : null, reasons ? `removals: ${reasons}` : null].filter(Boolean).join('; ');
    L.push(
      `| ${l.platform} | ${l.listName} | ${l.role} | ${l.current} | ${l.previous} | ${l.adds} | ${l.updates} | ${l.removes} | ${l.sentAdds} / ${l.sentUpdates} / ${l.sentRemoves}${l.deleted ? ' (audience deleted)' : ''} | ${note || ''} | ${l.requestIds.length} |`,
    );
  }
  const deletedIds = Object.entries(plan.nextAudienceIds.tiktok).filter(([list]) => plan.lists.some((l) => l.platform === 'tiktok' && l.listName === list && l.deleted));
  if (deletedIds.length > 0) L.push('', `TikTok audiences deleted (their ids are cleared in nextAudienceIds): ${deletedIds.map(([list]) => list).join(', ')}.`);
  L.push('');
  L.push(`Requests (${plan.requests.length}):`);
  for (const r of plan.requests) L.push(`- ${r.id}: ${r.method} ${r.url} (${r.members} members)${r.dependsOn ? ` after ${r.dependsOn.length} upload(s)` : ''}`);
  return `${L.join('\n')}\n`;
}
