/**
 * LaunchDarkly REST API: requests that change the rollout weights of OpenArt's EXISTING
 * `suite-default-model-*` flags, at the fallthrough and at per-segment rules. No app change:
 * the Suite keeps evaluating the same flags and logging the same ab_* properties.
 *
 * Exact shapes (docs fetched 2026-09-29; verbatim examples in test/fixtures/):
 *   PATCH /api/v2/flags/{projectKey}/{flagKey}[?dryRun=true]
 *     Content-Type: application/json; domain-model=launchdarkly.semanticpatch
 *     { environmentKey, comment, instructions: [...] }   (all-or-nothing)
 *   instructions used:
 *     updateFallthroughVariationOrRollout { rolloutWeights, rolloutBucketBy, rolloutContextKind }
 *     updateRuleVariationOrRollout        { ruleId, rolloutWeights, rolloutBucketBy, rolloutContextKind }
 *     addRule                             { clauses, beforeRuleId?, rolloutWeights, ... }  (one-time setup only)
 *   rolloutWeights: variation `_id` -> thousandths of a percent (0-100000). The docs do not say
 *   what happens to variations left out of the map, so every variation is always written
 *   explicitly (0 for arms the allocator does not manage) and the total is always 100000.
 *   Approvals: a direct PATCH in an approval-gated environment fails with 405; rollout changes
 *   then go through POST /api/v2/projects/{p}/flags/{f}/environments/{e}/approval-requests
 *   { description, instructions, comment, notifyMemberIds, notifyTeamKeys } and a reviewer
 *   applies them (POST .../approval-requests/{id}/apply).
 *   Auth: `Authorization: <api access token>` (no Bearer prefix), `LD-API-Version: 20240415`.
 *
 * Bucketing caveat: LaunchDarkly walks rollout weights cumulatively over a hashed bucket
 * value, so changing weights RE-ASSIGNS some already-bucketed users ("LaunchDarkly reassigns
 * contexts to different variations based on their bucket's position"). reassignedShare()
 * estimates how many; the daily-change cap bounds it.
 *
 * The holdout is a rule the allocator never edits, matched by a deterministic predicate on
 * the context key (default: OpenArt uid ending in 0-5, ~9.7% of base62 uids). It is a key
 * predicate rather than a percentage segment because the REST API does not expose segment
 * salts, and the warehouse must be able to recompute holdout membership in SQL:
 *   allocation_slice = IF(REGEXP_CONTAINS(user_id, r'[0-5]$'), 'holdout', 'bandit')
 */

import { z } from 'zod';
import { LD_WEIGHT_TOTAL, toUnits } from './thompson.js';

export const LD_API_BASE_URL = 'https://app.launchdarkly.com';
export const LD_API_VERSION = '20240415';
export const SEMANTIC_PATCH_CONTENT_TYPE = 'application/json; domain-model=launchdarkly.semanticpatch';
export const REDACTED_TOKEN = '<LD_API_TOKEN>';
export const HOLDOUT_KEY_PATTERN = '[0-5]$';

// ---------------------------------------------------------------------------
// Flag snapshot (GET /api/v2/flags/{projectKey}/{flagKey}?env=<env>)
// ---------------------------------------------------------------------------

export interface LdClause {
  _id?: string;
  contextKind?: string;
  attribute: string;
  op: string;
  values: Array<string | number | boolean>;
  negate: boolean;
}

export interface LdWeightedVariation {
  variation: number;
  weight: number;
  _untracked?: boolean;
}

export interface LdRollout {
  variations: LdWeightedVariation[];
  bucketBy?: string;
  contextKind?: string;
  seed?: number;
  experimentAllocation?: unknown;
}

export interface LdVariationOrRollout {
  variation?: number;
  rollout?: LdRollout;
}

export interface LdRule extends LdVariationOrRollout {
  _id: string;
  clauses: LdClause[];
  description?: string;
  ref?: string;
  trackEvents?: boolean;
  disabled?: boolean;
}

export interface LdEnvironmentConfig {
  on: boolean;
  version: number;
  salt?: string;
  fallthrough: LdVariationOrRollout;
  rules: LdRule[];
  offVariation?: number;
  [key: string]: unknown;
}

export interface LdVariation {
  _id: string;
  value: unknown;
  name?: string;
  description?: string;
}

export interface LdFlag {
  key: string;
  _version?: number;
  variations: LdVariation[];
  environments: Record<string, LdEnvironmentConfig>;
  [key: string]: unknown;
}

const ClauseSchema = z.looseObject({
  _id: z.string().optional(),
  contextKind: z.string().optional(),
  attribute: z.string(),
  op: z.string(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])),
  negate: z.boolean(),
});
const RolloutSchema = z.looseObject({
  variations: z.array(z.looseObject({ variation: z.number().int().min(0), weight: z.number().int().min(0), _untracked: z.boolean().optional() })),
  bucketBy: z.string().optional(),
  contextKind: z.string().optional(),
  seed: z.number().optional(),
  experimentAllocation: z.unknown().optional(),
});
const VorSchema = { variation: z.number().int().min(0).optional(), rollout: RolloutSchema.optional() };
const FlagSchema = z.looseObject({
  key: z.string().min(1),
  _version: z.number().int().optional(),
  variations: z.array(z.looseObject({ _id: z.string().min(1), value: z.unknown(), name: z.string().optional() })).min(1),
  environments: z.record(
    z.string(),
    z.looseObject({
      on: z.boolean(),
      version: z.number().int(),
      salt: z.string().optional(),
      fallthrough: z.looseObject(VorSchema),
      rules: z.array(z.looseObject({ _id: z.string().min(1), clauses: z.array(ClauseSchema), description: z.string().optional(), ...VorSchema })),
    }),
  ),
});

/** Validate an untrusted flag snapshot (file or REST response). */
export function parseLdFlag(raw: unknown): LdFlag {
  const parsed = FlagSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`not a LaunchDarkly flag representation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data as unknown as LdFlag;
}

export function environmentOf(flag: LdFlag, environmentKey: string): LdEnvironmentConfig {
  const env = flag.environments[environmentKey];
  if (!env) throw new Error(`flag ${flag.key} has no environment ${environmentKey} in the snapshot`);
  return env;
}

export interface RolloutReading {
  /** Units per managed arm, in the order given. */
  units: Map<string, number>;
  /** Units on variations the allocator does not manage. */
  unmanagedUnits: number;
  /** A LaunchDarkly Experimentation rollout (seed / experimentAllocation / _untracked). */
  isExperiment: boolean;
  /** The target serves one variation rather than a rollout. */
  singleVariation: boolean;
  /** Variation indexes in the order LaunchDarkly walks them (for the re-bucketing estimate). */
  order: number[];
}

export function rolloutUnitsByArm(flag: LdFlag, target: LdVariationOrRollout, managedArms: readonly string[]): RolloutReading {
  const units = new Map<string, number>(managedArms.map((a) => [a, 0]));
  let unmanagedUnits = 0;
  const credit = (index: number, weight: number) => {
    const v = flag.variations[index];
    if (!v) throw new Error(`flag ${flag.key}: rollout references variation index ${index} that does not exist`);
    const value = String(v.value);
    if (units.has(value)) units.set(value, units.get(value)! + weight);
    else unmanagedUnits += weight;
  };
  if (target.rollout) {
    const r = target.rollout;
    r.variations.forEach((wv) => credit(wv.variation, wv.weight));
    return {
      units,
      unmanagedUnits,
      isExperiment: r.seed !== undefined || r.experimentAllocation !== undefined || r.variations.some((v) => v._untracked !== undefined),
      singleVariation: false,
      order: r.variations.map((v) => v.variation),
    };
  }
  if (target.variation !== undefined) {
    credit(target.variation, LD_WEIGHT_TOTAL);
    return { units, unmanagedUnits, isExperiment: false, singleVariation: true, order: flag.variations.map((_, i) => i) };
  }
  throw new Error(`flag ${flag.key}: target serves neither a variation nor a rollout`);
}

/** rolloutWeights for a semantic patch: EVERY variation id, 0 for unmanaged, total 100000. */
export function rolloutWeightsForFlag(flag: LdFlag, unitsByArm: ReadonlyMap<string, number>): Record<string, number> {
  const known = new Set(flag.variations.map((v) => String(v.value)));
  for (const arm of unitsByArm.keys()) if (!known.has(arm)) throw new Error(`flag ${flag.key} has no variation with value ${arm}`);
  const out: Record<string, number> = {};
  let total = 0;
  for (const v of flag.variations) {
    const w = unitsByArm.get(String(v.value)) ?? 0;
    if (!Number.isInteger(w) || w < 0 || w > LD_WEIGHT_TOTAL) throw new Error(`weight for ${String(v.value)} must be an integer in 0..100000`);
    out[v._id] = w;
    total += w;
  }
  if (total !== LD_WEIGHT_TOTAL) throw new Error(`rollout weights must total 100000 (thousandths of a percent), got ${total}`);
  return out;
}

function canonicalClause(c: LdClause): string {
  return JSON.stringify([c.contextKind ?? 'user', c.attribute, c.op, c.negate, [...c.values].map(String).sort()]);
}

export function clausesEqual(a: readonly LdClause[], b: readonly LdClause[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(canonicalClause).sort();
  const kb = b.map(canonicalClause).sort();
  return ka.every((k, i) => k === kb[i]);
}

export function findRuleByClauses(env: LdEnvironmentConfig, clauses: readonly LdClause[]): LdRule | undefined {
  return env.rules.find((r) => clausesEqual(r.clauses, clauses));
}

/**
 * Share of users whose variation changes when weights move from `before` to `after`
 * (same variation order, cumulative layout over a uniform bucket value).
 */
export function reassignedShare(before: readonly number[], after: readonly number[]): number {
  if (before.length !== after.length) throw new Error('reassignedShare: length mismatch');
  const total = Math.max(
    before.reduce((a, b) => a + b, 0),
    after.reduce((a, b) => a + b, 0),
  );
  if (total <= 0) return 0;
  let overlap = 0;
  let startBefore = 0;
  let startAfter = 0;
  for (let i = 0; i < before.length; i += 1) {
    const endBefore = startBefore + before[i]!;
    const endAfter = startAfter + after[i]!;
    overlap += Math.max(0, Math.min(endBefore, endAfter) - Math.max(startBefore, startAfter));
    startBefore = endBefore;
    startAfter = endAfter;
  }
  return 1 - overlap / total;
}

// ---------------------------------------------------------------------------
// Semantic patch instructions and HTTP requests
// ---------------------------------------------------------------------------

export type RolloutWeights = Record<string, number>;

type RolloutParams = { rolloutWeights: RolloutWeights; rolloutBucketBy?: string; rolloutContextKind?: string };

export type SemanticInstruction =
  | ({ kind: 'updateFallthroughVariationOrRollout' } & RolloutParams)
  | { kind: 'updateFallthroughVariationOrRollout'; variationId: string }
  | ({ kind: 'updateRuleVariationOrRollout'; ruleId: string } & RolloutParams)
  | { kind: 'updateRuleVariationOrRollout'; ruleId: string; variationId: string }
  | ({ kind: 'addRule'; clauses: Array<Omit<LdClause, '_id'>>; beforeRuleId?: string } & RolloutParams);

export interface LdHttpRequest {
  method: 'GET' | 'PATCH' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const enc = encodeURIComponent;

export function flagPatchRequest(o: {
  projectKey: string;
  flagKey: string;
  environmentKey: string;
  instructions: SemanticInstruction[];
  comment: string;
  /** Ask LaunchDarkly to validate without persisting (?dryRun=true). */
  validateOnly?: boolean;
  baseUrl?: string;
}): LdHttpRequest {
  return {
    method: 'PATCH',
    url: `${o.baseUrl ?? LD_API_BASE_URL}/api/v2/flags/${enc(o.projectKey)}/${enc(o.flagKey)}${o.validateOnly ? '?dryRun=true' : ''}`,
    headers: { Authorization: REDACTED_TOKEN, 'Content-Type': SEMANTIC_PATCH_CONTENT_TYPE, 'LD-API-Version': LD_API_VERSION },
    body: { environmentKey: o.environmentKey, comment: o.comment, instructions: o.instructions },
  };
}

export function flagApprovalRequest(o: {
  projectKey: string;
  flagKey: string;
  environmentKey: string;
  instructions: SemanticInstruction[];
  description: string;
  comment?: string;
  notifyMemberIds?: string[];
  notifyTeamKeys?: string[];
  baseUrl?: string;
}): LdHttpRequest {
  const body: Record<string, unknown> = { description: o.description, instructions: o.instructions };
  if (o.comment) body.comment = o.comment;
  if (o.notifyMemberIds && o.notifyMemberIds.length > 0) body.notifyMemberIds = o.notifyMemberIds;
  if (o.notifyTeamKeys && o.notifyTeamKeys.length > 0) body.notifyTeamKeys = o.notifyTeamKeys;
  return {
    method: 'POST',
    url: `${o.baseUrl ?? LD_API_BASE_URL}/api/v2/projects/${enc(o.projectKey)}/flags/${enc(o.flagKey)}/environments/${enc(o.environmentKey)}/approval-requests`,
    headers: { Authorization: REDACTED_TOKEN, 'Content-Type': 'application/json', 'LD-API-Version': LD_API_VERSION },
    body,
  };
}

export function getFlagRequest(o: { projectKey: string; flagKey: string; environmentKey: string; baseUrl?: string }): LdHttpRequest {
  return {
    method: 'GET',
    url: `${o.baseUrl ?? LD_API_BASE_URL}/api/v2/flags/${enc(o.projectKey)}/${enc(o.flagKey)}?env=${enc(o.environmentKey)}`,
    headers: { Authorization: REDACTED_TOKEN, 'LD-API-Version': LD_API_VERSION },
  };
}

// ---------------------------------------------------------------------------
// One-time setup: holdout rule + per-segment rules (idempotent)
// ---------------------------------------------------------------------------

export function holdoutSetupInstructions(o: {
  flag: LdFlag;
  environmentKey: string;
  arms: readonly string[];
  holdoutClause: LdClause;
  ruleClauses: ReadonlyArray<readonly LdClause[]>;
  /** Starting weights for new segment rules (normally the current fallthrough). */
  initialUnits: ReadonlyMap<string, number>;
  rolloutContextKind: string;
  rolloutBucketBy: string;
}): SemanticInstruction[] {
  const env = environmentOf(o.flag, o.environmentKey);
  const strip = (c: LdClause): Omit<LdClause, '_id'> => ({ contextKind: c.contextKind ?? 'user', attribute: c.attribute, op: c.op, values: [...c.values], negate: c.negate });
  const out: SemanticInstruction[] = [];
  if (!findRuleByClauses(env, [o.holdoutClause])) {
    const uniform = toUnits(o.arms.map(() => 1 / o.arms.length), LD_WEIGHT_TOTAL, o.arms.map(() => 0));
    // The holdout must be evaluated before the allocator's segment rules; existing non-allocator
    // rules (e.g. internal testers) keep precedence.
    const firstSegmentRule = o.ruleClauses.map((c) => findRuleByClauses(env, c)).find((r) => r !== undefined);
    out.push({
      kind: 'addRule',
      clauses: [strip(o.holdoutClause)],
      ...(firstSegmentRule ? { beforeRuleId: firstSegmentRule._id } : {}),
      rolloutWeights: rolloutWeightsForFlag(o.flag, new Map(o.arms.map((a, i) => [a, uniform[i]!]))),
      rolloutBucketBy: o.rolloutBucketBy,
      rolloutContextKind: o.rolloutContextKind,
    });
  }
  for (const clauses of o.ruleClauses) {
    if (findRuleByClauses(env, clauses)) continue;
    out.push({
      kind: 'addRule',
      clauses: clauses.map(strip),
      rolloutWeights: rolloutWeightsForFlag(o.flag, o.initialUnits),
      rolloutBucketBy: o.rolloutBucketBy,
      rolloutContextKind: o.rolloutContextKind,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory emulator of the instructions above (tests and the 60-day simulation)
// ---------------------------------------------------------------------------

function rolloutFrom(flag: LdFlag, p: RolloutParams): LdRollout {
  const ids = new Set(flag.variations.map((v) => v._id));
  let total = 0;
  for (const [id, w] of Object.entries(p.rolloutWeights)) {
    if (!ids.has(id)) throw new Error(`unknown variation id ${id}`);
    if (!Number.isInteger(w) || w < 0) throw new Error(`invalid weight ${w}`);
    total += w;
  }
  if (total !== LD_WEIGHT_TOTAL) throw new Error(`rollout weights total ${total}, expected 100000`);
  return {
    variations: flag.variations.map((v, i) => ({ variation: i, weight: p.rolloutWeights[v._id] ?? 0 })),
    bucketBy: p.rolloutBucketBy ?? 'key',
    contextKind: p.rolloutContextKind ?? 'user',
  };
}

function variationIndex(flag: LdFlag, id: string): number {
  const i = flag.variations.findIndex((v) => v._id === id);
  if (i < 0) throw new Error(`unknown variation id ${id}`);
  return i;
}

/** Apply instructions all-or-nothing to a copy of the flag, like the REST API does. */
export function applySemanticPatch(flag: LdFlag, environmentKey: string, instructions: readonly SemanticInstruction[]): LdFlag {
  const next = structuredClone(flag);
  const env = environmentOf(next, environmentKey);
  let added = env.rules.length;
  for (const ins of instructions) {
    if (ins.kind === 'updateFallthroughVariationOrRollout') {
      env.fallthrough = 'variationId' in ins ? { variation: variationIndex(next, ins.variationId) } : { rollout: rolloutFrom(next, ins) };
    } else if (ins.kind === 'updateRuleVariationOrRollout') {
      const rule = env.rules.find((r) => r._id === ins.ruleId);
      if (!rule) throw new Error(`no rule ${ins.ruleId} in ${flag.key}/${environmentKey}`);
      delete rule.variation;
      delete rule.rollout;
      if ('variationId' in ins) rule.variation = variationIndex(next, ins.variationId);
      else rule.rollout = rolloutFrom(next, ins);
    } else if (ins.kind === 'addRule') {
      added += 1;
      const rule: LdRule = {
        _id: `emulated-rule-${added}`,
        clauses: ins.clauses.map((c, j) => ({ ...c, _id: `emulated-clause-${added}-${j}` })),
        rollout: rolloutFrom(next, ins),
      };
      const at = ins.beforeRuleId ? env.rules.findIndex((r) => r._id === ins.beforeRuleId) : env.rules.length;
      if (at < 0) throw new Error(`no rule ${ins.beforeRuleId} to insert before`);
      env.rules.splice(at, 0, rule);
    } else {
      throw new Error(`unsupported instruction ${(ins as { kind: string }).kind}`);
    }
  }
  env.version += 1;
  if (next._version !== undefined) next._version += 1;
  return next;
}

// ---------------------------------------------------------------------------
// Client: dry-run by default; live mode is gated and never exercised in tests
// ---------------------------------------------------------------------------

export type LdMode = 'dry-run' | 'live';
export const LIVE_ENV_FLAG = 'LD_ALLOCATOR_ALLOW_LIVE_WRITES';
export const LIVE_ENV_VALUE = 'yes-write-to-launchdarkly';

export interface LdTransport {
  send(request: LdHttpRequest): Promise<{ status: number; body: unknown }>;
}

export type SubmitResult =
  | { mode: 'dry-run'; request: LdHttpRequest }
  | { mode: 'live'; request: LdHttpRequest; status: number; body: unknown };

type Env = Record<string, string | undefined>;

export function assertLiveAllowed(env: Env): void {
  if (env[LIVE_ENV_FLAG] !== LIVE_ENV_VALUE) {
    throw new Error(`live LaunchDarkly writes are disabled: set ${LIVE_ENV_FLAG}=${LIVE_ENV_VALUE} to enable them explicitly`);
  }
  if (!env.LD_API_TOKEN) throw new Error('live LaunchDarkly writes need LD_API_TOKEN (a writer-scoped access token)');
}

export function formatRequest(req: LdHttpRequest): string {
  const headers = Object.entries(req.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `${req.method} ${req.url}\n${headers}${req.body === undefined ? '' : `\n\n${JSON.stringify(req.body, null, 2)}`}`;
}

export class LaunchDarklyClient {
  private readonly mode: LdMode;
  private readonly env: Env;
  private readonly transport: LdTransport | undefined;
  private readonly log: (line: string) => void;

  constructor(opts: { mode: LdMode; env?: Env; transport?: LdTransport; log?: (line: string) => void }) {
    this.mode = opts.mode;
    this.env = opts.env ?? process.env;
    this.transport = opts.transport;
    this.log = opts.log ?? ((line) => console.log(line));
    if (this.mode === 'live') {
      assertLiveAllowed(this.env);
      if (!this.transport) throw new Error('live mode needs an explicitly injected transport');
    }
  }

  async submit(request: LdHttpRequest): Promise<SubmitResult> {
    if (this.mode === 'dry-run') {
      this.log(`--- DRY RUN: this LaunchDarkly request was NOT sent ---\n${formatRequest(request)}`);
      return { mode: 'dry-run', request };
    }
    const res = await this.transport!.send({ ...request, headers: { ...request.headers, Authorization: this.env.LD_API_TOKEN! } });
    if (res.status === 405) {
      throw new Error('LaunchDarkly returned 405: this environment requires approvals; set approvals.mode = "approval"');
    }
    if (res.status >= 400) throw new Error(`LaunchDarkly returned ${res.status}: ${JSON.stringify(res.body)}`);
    return { mode: 'live', request, status: res.status, body: res.body };
  }
}

/** fetch()-based transport for live mode (constructed only by the CLI in live mode). */
export function fetchTransport(): LdTransport {
  return {
    async send(request) {
      const res = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // keep the raw text
      }
      return { status: res.status, body };
    },
  };
}
