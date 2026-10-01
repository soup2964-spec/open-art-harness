/**
 * Daily allocation job (Cloud Run Job, triggered by Cloud Scheduler after the warehouse run):
 *
 *   1. read fct_experiment_profit_by_arm (BigQuery; JSONL in tests/demo) and the allocation log
 *      (the rollout weights LaunchDarkly actually served, per day and target),
 *   2. read the current flag configuration (LaunchDarkly GET; snapshot files in dry-run),
 *   3. per flag: safety checks (flag on, holdout rule present and first, no LaunchDarkly
 *      Experimentation rollout, no traffic on unmanaged variations), then the data checks, all of
 *      which FAIL CLOSED (no patch + an alert): holdout share vs the key predicate, sample-ratio
 *      mismatch of the holdout AND of every bandit target against the logged weights, differential
 *      scoring coverage, missing reward / guardrail / allocation-log inputs,
 *   4. per allocation target (each existing per-segment rule, then the fallthrough): IPW + decay
 *      posteriors (estimate.ts), the always-valid stop-loss and guardrail tests, Thompson with the
 *      guardrails (thompson.ts),
 *   5. emit ONE semantic patch per flag (or an approval request) with a comment explaining the
 *      change, plus a human-readable report of why every weight moved and every alert.
 * One flag's failure never loses the others: each flag is isolated and reported as `error`.
 *
 * Dry-run is the default and the only mode tests use. Live mode needs
 * LD_ALLOCATOR_ALLOW_LIVE_WRITES=yes-write-to-launchdarkly and LD_API_TOKEN. The CLI exits 2 when
 * the run raised alerts, so Cloud Run / Scheduler alerting fires.
 *
 *   npx tsx src/job.ts --demo                      # fixture cohort + fixture flags, dry run
 *   npx tsx src/job.ts --rows rows.jsonl --allocation-log log.jsonl --date 2026-09-29 --out out/
 *   npx tsx src/job.ts --daily-mart daily.jsonl --allocation-intervals intervals.jsonl --date 2026-09-29
 *   npx tsx src/job.ts --demo --setup              # one-time holdout/segment-rule setup request
 *   npx tsx src/job.ts --readout readout.json --date 2026-09-28   # today's readout mart: holds (no holdout slice)
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Hex } from '@openart-signal/contracts';
import { z } from 'zod';
import { AllocationLog, constantAllocationLog, expectedHoldoutShare, KEY_ALPHABETS, type AllocationLogRow } from './allocation-log.js';
import { exposuresFromCohort, fitScoreModel, loadFixtureCohort, martRowsFromCohort, outcomesFromCohort } from './cohort-inputs.js';
import { epochStartFor, estimateFlag, GUARDRAIL_METRICS, REWARD_MODELS, type FlagEstimate, type TargetSpec } from './estimate.js';
import {
  environmentOf,
  fetchTransport,
  findRuleByClauses,
  flagApprovalRequest,
  flagPatchRequest,
  getFlagRequest,
  HOLDOUT_KEY_PATTERN,
  holdoutSetupInstructions,
  LaunchDarklyClient,
  parseLdFlag,
  reassignedShare,
  rolloutUnitsByArm,
  rolloutWeightsForFlag,
  type LdFlag,
  type LdHttpRequest,
  type LdRule,
  type LdTransport,
  type LdVariationOrRollout,
  type SemanticInstruction,
} from './launchdarkly.js';
import { SeededRng } from './rng.js';
import { ACQUISITION_CHANNELS, COUNTRY_BUCKETS, DEVICES, type SegmentMatch } from './segments.js';
import { srmCheck, type SrmResult } from './srm.js';
import { decideTarget, LD_WEIGHT_TOTAL, toUnits, type ArmObservation, type TargetDecision } from './thompson.js';
import { allocationLogFromIntervals, rowsFromDailyMart } from './warehouse-daily.js';
import { rowsFromArmReadout } from './warehouse-readout.js';
import {
  addDays,
  daysBetween,
  EXPERIMENT_PROFIT_BY_ARM_COLUMNS,
  OPTIONAL_EXPERIMENT_COLUMNS,
  parseExperimentProfitRows,
  type ExperimentProfitByArmRow,
} from './warehouse.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ClauseConfig = z.strictObject({
  contextKind: z.string().min(1),
  attribute: z.string().min(1),
  op: z.string().min(1),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
  negate: z.boolean(),
});

const MatchConfig = z.strictObject({
  country_bucket: z.array(z.enum(COUNTRY_BUCKETS)).optional(),
  device: z.array(z.enum(DEVICES)).optional(),
  acquisition_channel: z.array(z.enum(ACQUISITION_CHANNELS)).optional(),
});

const FlagConfigSchema = z.strictObject({
  flagKey: z.string().min(1),
  arms: z.array(z.string().min(1)).min(2),
  rolloutContextKind: z.string().min(1),
  rolloutBucketBy: z.string().min(1),
  holdout: z.strictObject({ clause: ClauseConfig }),
  ruleTargets: z.array(
    z.strictObject({
      // "fallthrough" and "holdout" name the two targets the allocator manages itself.
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).refine((n) => n !== 'fallthrough' && n !== 'holdout', 'reserved target name'),
      match: MatchConfig,
      clauses: z.array(ClauseConfig).min(1),
    }),
  ),
});

const unit = z.number().gt(0).lt(1);
const share = z.number().min(0).lt(1);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const AllocatorConfigSchema = z
  .strictObject({
    _comment: z.string().optional(),
    projectKey: z.string().min(1),
    environmentKey: z.string().min(1),
    reward: z.enum(REWARD_MODELS),
    lookbackDays: z.number().int().min(1),
    halfLifeDays: z.number().gt(0).nullable(),
    sequentialWindowDays: z.number().int().min(1),
    seed: z.string().min(1),
    prior: z.strictObject({ meanPseudoCount: z.number().gt(0), variancePseudoCount: z.number().gt(0) }),
    shrinkageStrength: z.number().gt(0),
    rewardModel: z.strictObject({ valuePerConversionUsd: z.number().gt(0).nullable(), cuped: z.boolean() }),
    guardrails: z.strictObject({
      minExplorationShare: share,
      warmStartShare: share,
      maxDailyChange: unit,
      minSamplesPerArm: z.number().int().min(1),
      minimumDetectableEffect: z.number().gt(0),
      mdeAlpha: unit,
      power: unit,
      minExpectedLossToMove: z.number().min(0),
      minChangeToPatch: z.number().min(0).lt(1),
      thompsonDraws: z.number().int().min(100),
      stopLoss: z.strictObject({
        enabled: z.boolean(),
        alpha: unit,
        tau: z.number().gt(0),
        control: z.union([z.strictObject({ kind: z.literal('holdout_mean') }), z.strictObject({ kind: z.literal('arm'), arm: z.string().min(1) })]),
        minControlSamples: z.number().int().min(1),
        minArmSamples: z.number().int().min(1),
      }),
    }),
    guardrailMetrics: z.strictObject({
      enabled: z.boolean(),
      requireData: z.boolean(),
      alpha: unit,
      activationMargin: share,
      refundMargin: share,
      failedGenerationMargin: share,
      minTreatmentN: z.number().int().min(1),
      minControlN: z.number().int().min(1),
    }),
    srm: z.strictObject({
      alpha: unit,
      minHoldoutUsers: z.number().int().min(1),
      minTargetUsers: z.number().int().min(1),
      holdoutKeyAlphabet: z.enum(['base62', 'hex']),
      /** Overrides the share derived from the holdout key predicate and the key alphabet. */
      expectedHoldoutShare: unit.nullable(),
    }),
    coverage: z.strictObject({ maxSpread: unit, minAgeDays: z.number().int().min(1), minExposed: z.number().int().min(1) }),
    resets: z.array(z.strictObject({ date: z.string().regex(DATE), flagKey: z.string().min(1).nullable(), reason: z.string().min(1) })),
    approvals: z.strictObject({ mode: z.enum(['direct', 'approval']), notifyMemberIds: z.array(z.string()), notifyTeamKeys: z.array(z.string()) }),
    flags: z
      .array(
        FlagConfigSchema.refine((f) => new Set(f.ruleTargets.map((t) => t.name)).size === f.ruleTargets.length, 'rule target names must be unique').refine(
          (f) => new Set(f.arms).size === f.arms.length,
          'arms must be unique',
        ),
      )
      .min(1)
      .refine((fs) => new Set(fs.map((f) => f.flagKey)).size === fs.length, 'flag keys must be unique'),
  })
  .superRefine((c, ctx) => {
    // Guardrail feasibility, checked up front so a bad config fails at load time, not mid-run.
    const g = c.guardrails;
    if (g.maxDailyChange < g.minExplorationShare) {
      ctx.addIssue({ code: 'custom', path: ['guardrails', 'maxDailyChange'], message: `maxDailyChange ${g.maxDailyChange} < minExplorationShare ${g.minExplorationShare}: an arm at 0% could not reach the exploration floor in one day (projection infeasible)` });
    }
    if (g.warmStartShare < g.minExplorationShare) {
      ctx.addIssue({ code: 'custom', path: ['guardrails', 'warmStartShare'], message: 'warmStartShare must be >= minExplorationShare' });
    }
    if (c.sequentialWindowDays < c.lookbackDays) {
      ctx.addIssue({ code: 'custom', path: ['sequentialWindowDays'], message: 'sequentialWindowDays must be >= lookbackDays' });
    }
    for (const [i, f] of c.flags.entries()) {
      const k = f.arms.length;
      if (g.minExplorationShare * k > 1 + 1e-12) {
        ctx.addIssue({ code: 'custom', path: ['flags', i, 'arms'], message: `minExplorationShare ${g.minExplorationShare} x ${k} arms of ${f.flagKey} exceeds 100%` });
      }
      if (g.warmStartShare * k > 1 + 1e-12) {
        ctx.addIssue({ code: 'custom', path: ['flags', i, 'arms'], message: `warmStartShare ${g.warmStartShare} x ${k} arms of ${f.flagKey} exceeds 100%` });
      }
      if (g.stopLoss.control.kind === 'arm' && !f.arms.includes(g.stopLoss.control.arm)) {
        ctx.addIssue({ code: 'custom', path: ['guardrails', 'stopLoss', 'control'], message: `control arm ${g.stopLoss.control.arm} is not an arm of ${f.flagKey}` });
      }
    }
  });

export type AllocatorConfig = Omit<z.infer<typeof AllocatorConfigSchema>, '_comment'>;
export type FlagConfig = z.infer<typeof FlagConfigSchema>;

const readText = (p: string | URL) => readFileSync(p instanceof URL ? fileURLToPath(p) : p, 'utf8');

/** Validate a config object (a file's JSON, or a config with CLI overrides applied). */
export function validateAllocatorConfig(raw: unknown): AllocatorConfig {
  const parsed = AllocatorConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid allocator config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const { _comment, ...config } = parsed.data;
  void _comment;
  return config;
}

export function loadAllocatorConfig(path: string | URL): AllocatorConfig {
  return validateAllocatorConfig(JSON.parse(readText(path)));
}

/** Every *.json flag snapshot in a directory, keyed by flag key. */
export function loadFlagSnapshots(dir: string | URL): Record<string, LdFlag> {
  const root = dir instanceof URL ? fileURLToPath(dir) : dir;
  const out: Record<string, LdFlag> = {};
  for (const file of readdirSync(root).filter((f) => f.endsWith('.json')).sort()) {
    const flag = parseLdFlag(JSON.parse(readFileSync(join(root, file), 'utf8')));
    out[flag.key] = flag;
  }
  return out;
}

export function isHoldoutUser(contextKey: string, pattern: string = HOLDOUT_KEY_PATTERN): boolean {
  return new RegExp(pattern).test(contextKey);
}

// ---------------------------------------------------------------------------
// Row sources
// ---------------------------------------------------------------------------

const readJsonl = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);

export class JsonlRowSource {
  constructor(private readonly path: string) {}

  async load(): Promise<ExperimentProfitByArmRow[]> {
    return parseExperimentProfitRows(readJsonl(this.path));
  }
}

/** The allocation log as JSONL (one AllocationLogRow per line). */
export function loadAllocationLog(path: string): AllocationLog {
  return new AllocationLog(readJsonl(path) as AllocationLogRow[]);
}

/** The subset of @google-cloud/bigquery's BigQuery client this source uses. */
export interface BigQueryLike {
  query(options: { query: string; params: Record<string, unknown>; location?: string }): Promise<[unknown[], ...unknown[]]>;
}

const INT_COLUMNS = new Set<string>([
  'exposed_users',
  'scored_users',
  'converted_users',
  'matured_users',
  'matured_converted_users',
  'matured_refunded_users',
  'activated_users',
  'generations_24h',
  'failed_generations_24h',
]);
const FLOAT_COLUMNS = new Set<string>([...EXPERIMENT_PROFIT_BY_ARM_COLUMNS, ...OPTIONAL_EXPERIMENT_COLUMNS].filter((c) => c.startsWith('sum_')));

export class BigQueryRowSource {
  private readonly table: string;

  constructor(
    private readonly client: BigQueryLike,
    table: string,
    private readonly location?: string,
    /** Select the optional column groups too (the mart must have them, NULL where unknown). */
    private readonly withOptionalColumns = true,
  ) {
    // Table names cannot be query parameters in BigQuery, so only a strict identifier is accepted.
    if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) throw new Error(`invalid BigQuery table id: ${table}`);
    this.table = table;
  }

  /** `lookbackDays` should cover the sequential window (the stop-loss uses every day since the reset). */
  async load(o: { runDate: string; lookbackDays: number }): Promise<ExperimentProfitByArmRow[]> {
    const names = [...EXPERIMENT_PROFIT_BY_ARM_COLUMNS, ...(this.withOptionalColumns ? OPTIONAL_EXPERIMENT_COLUMNS : [])];
    const columns = names.map((c) => (c === 'exposure_date' ? "FORMAT_DATE('%F', exposure_date) AS exposure_date" : c)).join(',\n  ');
    const query = `SELECT\n  ${columns}\nFROM \`${this.table}\`\nWHERE exposure_date >= DATE_SUB(DATE(@run_date), INTERVAL @lookback_days DAY)\n  AND exposure_date < DATE(@run_date)`;
    const [rows] = await this.client.query({ query, params: { run_date: o.runDate, lookback_days: o.lookbackDays }, ...(this.location ? { location: this.location } : {}) });
    return parseExperimentProfitRows(
      rows.map((raw) => {
        const r = { ...(raw as Record<string, unknown>) };
        for (const [k, v] of Object.entries(r)) {
          if (v && typeof v === 'object' && 'value' in (v as object)) r[k] = (v as { value: unknown }).value;
          if (INT_COLUMNS.has(k) && typeof r[k] === 'string') r[k] = Number.parseInt(r[k] as string, 10);
          if (FLOAT_COLUMNS.has(k) && typeof r[k] === 'string') r[k] = Number(r[k]);
        }
        return r;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

export interface TargetResult {
  name: string;
  ruleId: string | null;
  arms: string[];
  segments: string[];
  decision: TargetDecision;
  currentUnits: number[];
  proposedUnits: number[];
  /** Estimated share of this target's users LaunchDarkly re-buckets if the patch is applied. */
  reassignedShare: number;
  instruction: SemanticInstruction | null;
  /** Guardrail metric tests per arm (activation, refunds, failed generations) vs the holdout. */
  guardrails: Array<{ arm: string; metric: string; treatment: number | null; control: number | null; lower: number | null; upper: number | null; breach: string | null }>;
}

export interface CoverageResult {
  byArm: Record<string, { exposed: number; scored: number; coverage: number | null }>;
  spread: number | null;
}

export interface FlagResult {
  flagKey: string;
  status: 'patch' | 'no_change' | 'held' | 'error';
  reasons: string[];
  warnings: string[];
  /** Conditions a human must look at (fail-closed holds, stopped arms, errors). */
  alerts: string[];
  envVersion: number | null;
  checks: { srm: SrmResult | null; coverage: CoverageResult | null; holdoutShare: number | null };
  notes: string[];
  valuePerConversion: FlagEstimate['value'];
  targets: TargetResult[];
  /** One-time setup still missing (holdout rule / segment rules), as addRule instructions. */
  setupInstructions: SemanticInstruction[];
  request: LdHttpRequest | null;
}

export interface AllocationRun {
  runDate: string;
  reward: AllocatorConfig['reward'];
  dataWindow: { from: string; to: string };
  flags: FlagResult[];
  requests: LdHttpRequest[];
  /** Every flag's alerts, prefixed with the flag key; non-empty means the CLI exits 2. */
  alerts: string[];
  report: string;
}

const HOLDOUT_TARGET = 'holdout';

interface Target {
  name: string;
  rule: LdRule | null;
  vor: LdVariationOrRollout;
  match: SegmentMatch | null;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const pp = (x: number) => `${(100 * x).toFixed(1)}pp`;

function unitsInOrder(order: readonly number[], flag: LdFlag, byArm: ReadonlyMap<string, number>): number[] {
  return order.map((i) => byArm.get(String(flag.variations[i]!.value)) ?? 0);
}

function money(x: number, reward: AllocatorConfig['reward']): string {
  if (reward === 'conversion') return pct(x);
  const sign = x < 0 ? '-' : '';
  return `${sign}$${Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 2)}`;
}

function allocateFlag(fc: FlagConfig, flag: LdFlag | undefined, rows: readonly ExperimentProfitByArmRow[], log: AllocationLog | null, config: AllocatorConfig, runDate: string): FlagResult {
  const result: FlagResult = {
    flagKey: fc.flagKey,
    status: 'no_change',
    reasons: [],
    warnings: [],
    alerts: [],
    envVersion: null,
    checks: { srm: null, coverage: null, holdoutShare: null },
    notes: [],
    valuePerConversion: null,
    targets: [],
    setupInstructions: [],
    request: null,
  };
  /** Fail closed: no patch, and every reason is an alert. */
  const fail = (status: 'held' | 'error', ...why: string[]): FlagResult => {
    result.status = status;
    result.reasons.push(...why);
    result.alerts.push(...why);
    return result;
  };
  if (!flag) return fail('error', `no LaunchDarkly snapshot for ${fc.flagKey}`);
  const env = flag.environments[config.environmentKey];
  if (!env) return fail('error', `flag has no ${config.environmentKey} environment`);
  result.envVersion = env.version;

  const values = new Set(flag.variations.map((v) => String(v.value)));
  const missingArms = fc.arms.filter((a) => !values.has(a));
  if (missingArms.length > 0) return fail('error', `configured arms missing from the flag's variations: ${missingArms.join(', ')}`);

  const holdoutRule = findRuleByClauses(env, [fc.holdout.clause]);
  const fallthroughUnits = (() => {
    try {
      const r = rolloutUnitsByArm(flag, env.fallthrough, fc.arms);
      return r.unmanagedUnits === 0 && !r.isExperiment ? r.units : null;
    } catch {
      return null;
    }
  })();
  const uniform = toUnits(fc.arms.map(() => 1 / fc.arms.length), LD_WEIGHT_TOTAL, fc.arms.map(() => 0));
  result.setupInstructions = holdoutSetupInstructions({
    flag,
    environmentKey: config.environmentKey,
    arms: fc.arms,
    holdoutClause: fc.holdout.clause,
    ruleClauses: fc.ruleTargets.map((t) => t.clauses),
    initialUnits: fallthroughUnits ?? new Map(fc.arms.map((a, i) => [a, uniform[i]!])),
    rolloutContextKind: fc.rolloutContextKind,
    rolloutBucketBy: fc.rolloutBucketBy,
  });

  if (!env.on) return fail('held', `flag is off in ${config.environmentKey}: everyone gets the off variation, so rollout weights do nothing`);
  if (!holdoutRule) return fail('held', 'holdout rule missing: apply the one-time setup (setupInstructions) first; without it there is no clean control');

  // Targets in LaunchDarkly evaluation order: existing segment rules (first match wins), then the fallthrough.
  const holdoutIndex = env.rules.indexOf(holdoutRule);
  const ruleTargets: Target[] = [];
  for (const rt of fc.ruleTargets) {
    const rule = findRuleByClauses(env, rt.clauses);
    if (!rule) {
      result.warnings.push(`segment rule "${rt.name}" is not in LaunchDarkly yet (setup pending): its users are served by the fallthrough`);
      continue;
    }
    if (rule.disabled) {
      result.warnings.push(`segment rule "${rt.name}" is disabled in LaunchDarkly: its users are served by the fallthrough`);
      continue;
    }
    if (env.rules.indexOf(rule) < holdoutIndex) return fail('error', `segment rule "${rt.name}" sits above the holdout rule: holdout users matching it would bypass the holdout`);
    ruleTargets.push({ name: rt.name, rule, vor: rule, match: rt.match });
  }
  ruleTargets.sort((a, b) => env.rules.indexOf(a.rule!) - env.rules.indexOf(b.rule!));
  const targets: Target[] = [...ruleTargets, { name: 'fallthrough', rule: null, vor: env.fallthrough, match: null }];
  const specs: TargetSpec[] = targets.map((t) => ({ name: t.name, match: t.match }));

  const readings = new Map<string, ReturnType<typeof rolloutUnitsByArm>>();
  for (const t of [...targets, { name: HOLDOUT_TARGET, rule: holdoutRule, vor: holdoutRule, match: null }]) {
    const reading = rolloutUnitsByArm(flag, t.vor, fc.arms);
    if (reading.isExperiment) return fail('error', `${t.name} is a LaunchDarkly Experimentation rollout (seed/experimentAllocation): change it through the Experimentation UI, not the allocator`);
    if (reading.unmanagedUnits > 0) return fail('error', `${t.name} gives ${pct(reading.unmanagedUnits / LD_WEIGHT_TOTAL)} of its traffic to variations not managed by the allocator; retire them explicitly first`);
    const total = [...reading.units.values()].reduce((a, b) => a + b, 0);
    if (total !== LD_WEIGHT_TOTAL) return fail('error', `${t.name} rollout weights total ${total}, expected 100000`);
    readings.set(t.name, reading);
  }

  // --- data checks: every one fails closed ---------------------------------------------
  const armsInRows = new Set(rows.filter((r) => r.flag_key === fc.flagKey).map((r) => r.arm));
  for (const arm of armsInRows) if (!fc.arms.includes(arm)) result.warnings.push(`warehouse rows for arm ${arm}, which is not configured, are ignored`);

  const expectedShare = config.srm.expectedHoldoutShare ?? expectedHoldoutShare(String(fc.holdout.clause.values[0] ?? HOLDOUT_KEY_PATTERN), KEY_ALPHABETS[config.srm.holdoutKeyAlphabet]!);
  const srm = srmCheck(rows, {
    flagKey: fc.flagKey,
    arms: fc.arms,
    targets: specs,
    runDate,
    lookbackDays: config.lookbackDays,
    log,
    expectedHoldoutShare: expectedShare,
    alpha: config.srm.alpha,
    minHoldoutUsers: config.srm.minHoldoutUsers,
    minTargetUsers: config.srm.minTargetUsers,
  });
  result.checks.srm = srm;
  result.checks.holdoutShare = srm.holdoutShare?.observedShare ?? null;
  const holds: string[] = [
    ...srm.unevaluable.map((u) => `SRM check not evaluable (fail closed): ${u}`),
    ...srm.alarms.map((a) => `SRM alarm (fail closed): ${a}`),
  ];

  const coverage: CoverageResult = { byArm: {}, spread: null };
  for (const arm of fc.arms) coverage.byArm[arm] = { exposed: 0, scored: 0, coverage: null };
  for (const r of rows) {
    if (r.flag_key !== fc.flagKey || !coverage.byArm[r.arm]) continue;
    const age = daysBetween(r.exposure_date, runDate);
    if (age < config.coverage.minAgeDays || age > config.lookbackDays) continue;
    coverage.byArm[r.arm]!.exposed += r.exposed_users;
    coverage.byArm[r.arm]!.scored += r.scored_users;
  }
  const covs: number[] = [];
  for (const c of Object.values(coverage.byArm)) {
    if (c.exposed >= config.coverage.minExposed) {
      c.coverage = c.scored / c.exposed;
      covs.push(c.coverage);
    }
  }
  if (covs.length >= 2) {
    coverage.spread = Math.max(...covs) - Math.min(...covs);
    if (coverage.spread > config.coverage.maxSpread) {
      holds.push(`differential scoring coverage: scored/exposed differs by ${pct(coverage.spread)} across arms (> ${pct(config.coverage.maxSpread)}); unscored users would bias the comparison`);
    }
  }
  result.checks.coverage = coverage;
  if (holds.length > 0) return fail('held', ...holds);

  // --- estimation ------------------------------------------------------------------------
  const estimate = estimateFlag(rows, {
    flagKey: fc.flagKey,
    arms: fc.arms,
    targets: specs,
    runDate,
    lookbackDays: config.lookbackDays,
    halfLifeDays: config.halfLifeDays,
    sequentialWindowDays: config.sequentialWindowDays,
    epochStart: epochStartFor(config.resets, fc.flagKey, runDate),
    reward: config.reward,
    cuped: config.rewardModel.cuped,
    valuePerConversionFallback: config.rewardModel.valuePerConversionUsd,
    prior: config.prior,
    shrinkageStrength: config.shrinkageStrength,
    guardrails: config.guardrails,
    guardrailMetrics: config.guardrailMetrics,
    log: log!,
  });
  result.notes.push(...estimate.notes);
  result.valuePerConversion = estimate.value;
  if (estimate.holds.length > 0) return fail('held', ...estimate.holds.map((h) => `missing input (fail closed): ${h}`));

  const fmt = (x: number) => money(x, config.reward);
  const instructions: SemanticInstruction[] = [];
  for (const t of targets) {
    const te = estimate.targets.find((x) => x.name === t.name)!;
    const reading = readings.get(t.name)!;
    const observations: ArmObservation[] = te.arms.map((a) => ({
      arm: a.arm,
      posterior: a.posterior,
      effectiveN: a.effectiveN,
      rewardUsers: a.rewardUsers,
      currentWeight: reading.units.get(a.arm)! / LD_WEIGHT_TOTAL,
      stopLossTest: a.stopLossTest,
      guardrailBreaches: a.guardrails.flatMap((gr) => (gr.breach ? [gr.breach] : [])),
    }));
    const decision = decideTarget(observations, config.guardrails, new SeededRng(`${config.seed}|${runDate}|${fc.flagKey}|${t.name}`), {
      requiredN: te.requiredN,
      control: te.control,
      notes: te.notes,
      format: fmt,
    });
    for (const a of decision.arms) if (a.stopped && a.currentWeight > 0) result.alerts.push(`${t.name}: ${a.arm} stopped (${a.reasons.join('; ')})`);
    const currentUnits = fc.arms.map((a) => reading.units.get(a)!);
    const proposedUnits = decision.arms.map((a) => a.proposedUnits);
    const proposedMap = new Map(fc.arms.map((a, i) => [a, proposedUnits[i]!]));
    const reassigned = reassignedShare(unitsInOrder(reading.order, flag, reading.units), unitsInOrder(reading.order, flag, proposedMap));
    let instruction: SemanticInstruction | null = null;
    // Integer units, never floats, decide whether anything changes.
    if (decision.status === 'moved' && proposedUnits.some((u, i) => u !== currentUnits[i])) {
      const rollout = { rolloutWeights: rolloutWeightsForFlag(flag, proposedMap), rolloutBucketBy: fc.rolloutBucketBy, rolloutContextKind: fc.rolloutContextKind };
      instruction = t.rule ? { kind: 'updateRuleVariationOrRollout', ruleId: t.rule._id, ...rollout } : { kind: 'updateFallthroughVariationOrRollout', ...rollout };
      instructions.push(instruction);
    }
    const guardrails = te.arms.flatMap((a) =>
      a.guardrails.map((gr) => ({
        arm: a.arm,
        metric: gr.metric,
        treatment: gr.test?.treatmentMean ?? null,
        control: gr.test?.controlMean ?? null,
        lower: gr.test?.lower ?? null,
        upper: gr.test?.upper ?? null,
        breach: gr.breach,
      })),
    );
    result.targets.push({ name: t.name, ruleId: t.rule?._id ?? null, arms: [...fc.arms], segments: te.segments, decision, currentUnits, proposedUnits, reassignedShare: reassigned, instruction, guardrails });
  }

  if (instructions.length === 0) {
    result.status = 'no_change';
    return result;
  }
  // Guard: the allocator never emits an instruction for the holdout rule.
  if (instructions.some((i) => 'ruleId' in i && i.ruleId === holdoutRule._id)) throw new Error('internal error: holdout rule targeted');
  if (instructions.some((i) => i.kind === 'addRule')) throw new Error('internal error: the daily patch never adds rules');

  const comment = buildComment(fc.flagKey, result, config, runDate);
  const description = `Daily default-model allocation for ${fc.flagKey} (${runDate}), openart-signal bandit-allocator`;
  result.request =
    config.approvals.mode === 'approval'
      ? flagApprovalRequest({
          projectKey: config.projectKey,
          flagKey: fc.flagKey,
          environmentKey: config.environmentKey,
          instructions,
          description,
          comment,
          notifyMemberIds: config.approvals.notifyMemberIds,
          notifyTeamKeys: config.approvals.notifyTeamKeys,
        })
      : flagPatchRequest({ projectKey: config.projectKey, flagKey: fc.flagKey, environmentKey: config.environmentKey, instructions, comment });
  result.status = 'patch';
  return result;
}

const COMMENT_MAX = 1000;

/** The LaunchDarkly change comment: every arm whose INTEGER units change, with why. */
export function buildComment(flagKey: string, f: Pick<FlagResult, 'targets' | 'envVersion'>, config: AllocatorConfig, runDate: string): string {
  const parts: string[] = [];
  for (const t of f.targets) {
    if (!t.instruction) continue;
    const moves = t.decision.arms
      .map((a, i) => ({ a, cur: t.currentUnits[i]!, next: t.proposedUnits[i]! }))
      .filter((x) => x.next !== x.cur)
      .map(({ a, cur, next }) => `${a.arm} ${pct(cur / LD_WEIGHT_TOTAL)}->${pct(next / LD_WEIGHT_TOTAL)}${a.stopped ? ' (stopped)' : a.pBest !== null ? ` (P(best) ${pct(a.pBest)})` : a.phase === 'warming' ? ' (warm start)' : ''}`);
    parts.push(`${t.name === 'fallthrough' ? 'fallthrough' : `rule ${t.name}`}: ${moves.join(', ')}`);
  }
  const g = config.guardrails;
  const head = `openart-signal bandit-allocator ${runDate} on ${flagKey}: Thompson sampling, reward=${config.reward} (fct_experiment_profit_by_arm through ${addDays(runDate, -1)}), computed from env version ${f.envVersion}; holdout rule untouched. `;
  const tail = ` Guardrails: floor ${pct(g.minExplorationShare)}/arm, warm start ${pct(g.warmStartShare)}, cap ${pp(g.maxDailyChange)}/day, MDE ${money(g.minimumDetectableEffect, config.reward)}/user, always-valid stop-loss (alpha ${g.stopLoss.alpha}) vs control, SRM vs logged weights.`;
  let body = parts.join('; ');
  const budget = COMMENT_MAX - head.length - tail.length;
  if (body.length > budget) body = `${body.slice(0, Math.max(0, budget - 30))}... (see the job report)`;
  return `${head}${body}.${tail}`.slice(0, COMMENT_MAX);
}

export function runAllocation(input: {
  rows: readonly ExperimentProfitByArmRow[];
  flags: Record<string, LdFlag>;
  config: AllocatorConfig;
  runDate: string;
  /** Logged weights per day and target; without it every flag fails closed. */
  allocationLog?: AllocationLog | null;
}): AllocationRun {
  const { rows, flags, config, runDate } = input;
  const log = input.allocationLog ?? null;
  // Each flag is isolated: an exception in one becomes that flag's `error`, the others still run.
  const flagResults = config.flags.map((fc): FlagResult => {
    try {
      return allocateFlag(fc, flags[fc.flagKey], rows, log, config, runDate);
    } catch (err) {
      const message = `internal error: ${err instanceof Error ? err.message : String(err)}`;
      return {
        flagKey: fc.flagKey,
        status: 'error',
        reasons: [message],
        warnings: [],
        alerts: [message],
        envVersion: flags[fc.flagKey]?.environments[config.environmentKey]?.version ?? null,
        checks: { srm: null, coverage: null, holdoutShare: null },
        notes: [],
        valuePerConversion: null,
        targets: [],
        setupInstructions: [],
        request: null,
      };
    }
  });
  const run: AllocationRun = {
    runDate,
    reward: config.reward,
    dataWindow: { from: addDays(runDate, -config.lookbackDays), to: addDays(runDate, -1) },
    flags: flagResults,
    requests: flagResults.flatMap((f) => (f.request ? [f.request] : [])),
    alerts: flagResults.flatMap((f) => f.alerts.map((a) => `${f.flagKey}: ${a}`)),
    report: '',
  };
  run.report = renderReport(run, config);
  return run;
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

const REWARD_LABEL: Record<AllocatorConfig['reward'], string> = {
  decomposed_profit: 'p x V - C per exposed user: matured conversion x pooled (winsorized) value per conversion - measured serving cost (USD)',
  predicted_profit: 'predicted 24h profit per exposed user (USD, 90-day horizon)',
  conversion: 'matured conversion rate per exposed user',
};

export function renderReport(run: AllocationRun, config: AllocatorConfig): string {
  const g = config.guardrails;
  const fmt = (x: number) => money(x, config.reward);
  const lines: string[] = [];
  lines.push(`# Default-model allocation, ${run.runDate}`);
  lines.push('');
  if (run.alerts.length > 0) {
    lines.push(`## ALERTS (${run.alerts.length})`);
    lines.push('');
    for (const a of run.alerts) lines.push(`- ${a}`);
    lines.push('');
  }
  lines.push(
    `Reward: ${REWARD_LABEL[config.reward]}, from \`fct_experiment_profit_by_arm\`, exposure days ${run.dataWindow.from} to ${run.dataWindow.to}, ` +
      `${config.halfLifeDays ? `half-life ${config.halfLifeDays} d` : 'no decay'}, weighted by the logged allocation (IPW).`,
  );
  lines.push(
    `Guardrails: exploration floor ${pct(g.minExplorationShare)} per arm; warm-start share ${pct(g.warmStartShare)} for under-sampled arms; at most ${pp(g.maxDailyChange)} change per arm per day; holdout rule never edited; ` +
      `always-valid stop-loss vs the ${g.stopLoss.control.kind === 'arm' ? `arm ${g.stopLoss.control.arm}` : 'holdout'} (alpha ${g.stopLoss.alpha} over all daily looks, tau ${fmt(g.stopLoss.tau)}); ` +
      `Thompson moves an arm once it has the MDE-based minimum (${fmt(g.minimumDetectableEffect)} per user at alpha ${g.mdeAlpha}, power ${pct(g.power)}; at least ${g.minSamplesPerArm}) effective users, and only when the current split's expected loss is at least ${fmt(g.minExpectedLossToMove)} per user; ` +
      `changes under ${pp(g.minChangeToPatch)} are not patched. SRM, coverage and missing inputs fail closed.`,
  );
  for (const f of run.flags) {
    lines.push('');
    lines.push(`## ${f.flagKey}: ${f.status.toUpperCase().replace('_', ' ')}`);
    lines.push('');
    if (f.envVersion !== null) lines.push(`LaunchDarkly ${config.environmentKey} version ${f.envVersion}.`);
    for (const r of f.reasons) lines.push(`- **${f.status === 'error' ? 'Error' : 'Held'}:** ${r}`);
    for (const w of f.warnings) lines.push(`- Note: ${w}`);
    for (const n of f.notes) lines.push(`- Note: ${n}`);
    const c = f.checks;
    if (c.srm?.holdoutShare) {
      const h = c.srm.holdoutShare;
      lines.push(`- Holdout share of exposures: ${pct(h.observedShare)} vs expected ${pct(h.expectedShare)} (key predicate ${HOLDOUT_KEY_PATTERN}, ${config.srm.holdoutKeyAlphabet} keys): chi2=${h.chiSquare.toFixed(2)}, p=${h.pValue.toFixed(3)} -> ${h.pValue < config.srm.alpha ? 'ALARM' : 'OK'}.`);
    }
    for (const t of c.srm?.targets ?? []) {
      lines.push(
        `- SRM ${t.target} vs logged weights: ${t.skipped ? `not tested (${t.skipped})` : `chi2=${Number.isFinite(t.chiSquare) ? t.chiSquare.toFixed(2) : 'inf'}, df=${t.df}, p=${t.pValue.toFixed(3)}`} (${t.exposures} exposures).`,
      );
    }
    if (!c.srm && f.status !== 'error') lines.push('- SRM check: not evaluated.');
    if (c.coverage) lines.push(`- Scoring coverage spread across arms: ${c.coverage.spread === null ? 'n/a' : pct(c.coverage.spread)} -> ${c.coverage.spread !== null && c.coverage.spread > config.coverage.maxSpread ? 'ALARM' : 'OK'}.`);
    if (f.valuePerConversion) lines.push(`- Value per conversion V: $${f.valuePerConversion.mean.toFixed(2)} (SE $${f.valuePerConversion.se.toFixed(2)}; ${f.valuePerConversion.source}).`);
    for (const t of f.targets) {
      const d = t.decision;
      lines.push('');
      lines.push(`### ${t.name === 'fallthrough' ? 'Fallthrough (default rule)' : `Rule "${t.name}"`}${t.ruleId ? ` (ruleId ${t.ruleId})` : ''}: ${d.status}`);
      lines.push('');
      lines.push(`Covers ${t.segments.length} segment(s) with data${t.segments.length ? `: ${t.segments.slice(0, 6).join(', ')}${t.segments.length > 6 ? ', ...' : ''}` : ''}.`);
      lines.push(`Minimum sample (MDE-based): ${d.requiredN} effective users per active arm.`);
      lines.push(d.controlMean === null ? `Control: not available (${Math.round(d.controlN)} users).` : `Control: ${d.controlSource}, mean ${fmt(d.controlMean)} per user (n=${Math.round(d.controlN)}).`);
      if (d.expectedLossCurrent !== null) lines.push(`Expected loss of the current split among mature arms: ${fmt(d.expectedLossCurrent)} per user.`);
      for (const r of d.reasons) lines.push(`- ${r}`);
      lines.push('');
      lines.push('| Arm | Phase | Users | Effective n | Mean / user | 95% interval | P(best) | Expected loss | Stop-loss CS (arm - control) | Current | Proposed | Change |');
      lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
      d.arms.forEach((a, i) => {
        const cur = t.currentUnits[i]! / LD_WEIGHT_TOTAL;
        const next = t.proposedUnits[i]! / LD_WEIGHT_TOTAL;
        lines.push(
          `| ${a.arm} | ${a.phase} | ${Math.round(a.rewardUsers)} | ${Math.round(a.effectiveN)} | ${fmt(a.posteriorMean)} | ${fmt(a.lower95)} to ${fmt(a.upper95)} | ${a.pBest === null ? 'n/a' : pct(a.pBest)} | ${a.expectedLoss === null ? 'n/a' : fmt(a.expectedLoss)} | ${a.stopLoss ? `${fmt(a.stopLoss.lower)} to ${fmt(a.stopLoss.upper)}` : 'n/a'} | ${pct(cur)} | ${pct(next)} | ${next >= cur ? '+' : ''}${(100 * (next - cur)).toFixed(1)}pp |`,
        );
      });
      if (t.guardrails.length > 0) {
        lines.push('');
        lines.push('| Guardrail vs holdout | ' + GUARDRAIL_METRICS.join(' | ') + ' |');
        lines.push('|---|' + GUARDRAIL_METRICS.map(() => '---:').join('|') + '|');
        for (const arm of t.arms) {
          const cells = GUARDRAIL_METRICS.map((m) => {
            const gr = t.guardrails.find((x) => x.arm === arm && x.metric === m);
            if (!gr || gr.treatment === null) return 'n/a';
            return `${pct(gr.treatment)} vs ${pct(gr.control!)}${gr.breach ? ' BREACH' : ''}`;
          });
          lines.push(`| ${arm} | ${cells.join(' | ')} |`);
        }
      }
      lines.push('');
      lines.push('Why:');
      for (const a of d.arms) lines.push(`- ${a.arm}: ${a.reasons.length ? a.reasons.join('; ') : 'no change'}`);
      if (t.instruction) {
        lines.push(`- Estimated users re-bucketed by LaunchDarkly if applied: ${pct(t.reassignedShare)} of this target's traffic (LaunchDarkly reassigns contexts when rollout percentages change).`);
      }
    }
    if (f.setupInstructions.length > 0) {
      lines.push('');
      lines.push(`One-time setup still pending (${f.setupInstructions.length} addRule instruction(s)); print it with \`--setup\`.`);
    }
    if (f.request) {
      lines.push('');
      lines.push(`Request (${f.request.method} ${f.request.url}):`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(f.request.body, null, 2));
      lines.push('```');
    }
  }
  lines.push('');
  lines.push(`Report sha256: ${sha256Hex(lines.join('\n')).slice(0, 16)}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Demo inputs and CLI
// ---------------------------------------------------------------------------

export const DEMO_RUN_DATE = '2026-08-01';

/**
 * fct_experiment_profit_by_arm rows from the contracts' 2,000-user fixture cohort as the mart would
 * show them on the demo run date: the 24h score for everyone (a signals-only model fit on this same
 * cohort, so IN-SAMPLE; the simulation fits it on separate reference users), 14-day matured outcomes
 * only for users exposed at least 14 days earlier.
 */
export function demoRows(): ExperimentProfitByArmRow[] {
  const cohort = loadFixtureCohort();
  const outcomes = outcomesFromCohort(cohort);
  const score = fitScoreModel(outcomes, { version: 'illustrative-24h-signals-v1-in-sample' });
  return parseExperimentProfitRows(martRowsFromCohort(outcomes, exposuresFromCohort(cohort), { sliceOf: (uid) => (isHoldoutUser(uid) ? 'holdout' : 'bandit'), score, asOf: DEMO_RUN_DATE }));
}

/** The fixture cohort was generated with an equal split everywhere: that is its allocation log. */
export function demoAllocationLog(config: AllocatorConfig, rows: readonly ExperimentProfitByArmRow[]): AllocationLog {
  const out: AllocationLogRow[] = [];
  for (const fc of config.flags) {
    const dates = [...new Set(rows.filter((r) => r.flag_key === fc.flagKey).map((r) => r.exposure_date))].sort();
    const equal = toUnits(fc.arms.map(() => 1 / fc.arms.length), LD_WEIGHT_TOTAL, fc.arms.map(() => 0));
    const units = Object.fromEntries(fc.arms.map((a, i) => [a, equal[i]!]));
    const targets = Object.fromEntries([...fc.ruleTargets.map((t) => t.name), 'fallthrough', HOLDOUT_TARGET].map((t) => [t, units]));
    out.push(...constantAllocationLog({ dates, flagKey: fc.flagKey, targets }));
  }
  return new AllocationLog(out);
}

type Env = Record<string, string | undefined>;

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** A strictly positive integer CLI value (rejects NaN, 0, negatives, fractions and trailing junk). */
export function parsePositiveInt(value: string, name: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** A strictly positive finite number CLI value. */
export function parsePositiveNumber(value: string, name: string): number {
  const x = Number(value);
  if (value.trim() === '' || !Number.isFinite(x) || x <= 0) throw new Error(`${name} must be a positive number, got ${JSON.stringify(value)}`);
  return x;
}

export async function main(argv: readonly string[], io: { log?: (line: string) => void; env?: Env; transport?: LdTransport } = {}): Promise<AllocationRun | null> {
  const log = io.log ?? ((line: string) => console.log(line));
  const env = io.env ?? process.env;
  const mode = (argValue(argv, '--mode') ?? 'dry-run') as 'dry-run' | 'live';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`--mode must be dry-run or live, got ${String(mode)}`);
  // Constructing the client first means live mode fails fast without the explicit switch.
  const client = new LaunchDarklyClient(mode === 'live' ? { mode, env, transport: io.transport ?? fetchTransport(), log } : { mode, env, log });
  const transport = (): LdTransport => io.transport ?? fetchTransport();

  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  let config = loadAllocatorConfig(argValue(argv, '--config') ?? here('../fixtures/allocator.config.json'));
  const minSamples = argValue(argv, '--min-samples');
  const mde = argValue(argv, '--mde');
  if (minSamples !== undefined || mde !== undefined) {
    // Overrides go through the same schema (and feasibility checks) as the config file.
    config = validateAllocatorConfig({
      ...config,
      guardrails: {
        ...config.guardrails,
        ...(minSamples !== undefined ? { minSamplesPerArm: parsePositiveInt(minSamples, '--min-samples') } : {}),
        ...(mde !== undefined ? { minimumDetectableEffect: parsePositiveNumber(mde, '--mde') } : {}),
      },
    });
  }
  const demo = argv.includes('--demo');
  const runDate = argValue(argv, '--date') ?? (demo ? DEMO_RUN_DATE : new Date().toISOString().slice(0, 10));
  let flags: Record<string, LdFlag>;
  if (mode === 'live') {
    // Read-before-write: fetch the live configuration (never exercised in tests).
    flags = {};
    for (const fc of config.flags) {
      const res = await transport().send({ ...getFlagRequest({ projectKey: config.projectKey, flagKey: fc.flagKey, environmentKey: config.environmentKey }), headers: { Authorization: env.LD_API_TOKEN!, 'LD-API-Version': '20240415' } });
      if (res.status !== 200) throw new Error(`GET flag ${fc.flagKey} returned ${res.status}`);
      flags[fc.flagKey] = parseLdFlag(res.body);
    }
  } else {
    flags = loadFlagSnapshots(argValue(argv, '--flags') ?? here('../fixtures/flags/'));
  }

  if (argv.includes('--setup')) {
    for (const fc of config.flags) {
      const flag = flags[fc.flagKey];
      if (!flag) throw new Error(`no snapshot for ${fc.flagKey}`);
      const reading = rolloutUnitsByArm(flag, environmentOf(flag, config.environmentKey).fallthrough, fc.arms);
      const instructions = holdoutSetupInstructions({
        flag,
        environmentKey: config.environmentKey,
        arms: fc.arms,
        holdoutClause: fc.holdout.clause,
        ruleClauses: fc.ruleTargets.map((t) => t.clauses),
        initialUnits: reading.units,
        rolloutContextKind: fc.rolloutContextKind,
        rolloutBucketBy: fc.rolloutBucketBy,
      });
      if (instructions.length === 0) {
        log(`${fc.flagKey}: setup already applied`);
        continue;
      }
      await client.submit(
        flagApprovalRequest({
          projectKey: config.projectKey,
          flagKey: fc.flagKey,
          environmentKey: config.environmentKey,
          instructions,
          description: `One-time openart-signal setup for ${fc.flagKey}: fixed holdout rule (uniform split, never edited) + per-segment allocation rules`,
          comment: 'Adds the holdout rule first so holdout users are never re-weighted, then one rule per allocation segment starting at the current fallthrough weights.',
          notifyMemberIds: config.approvals.notifyMemberIds,
          notifyTeamKeys: config.approvals.notifyTeamKeys,
        }),
      );
    }
    return null;
  }

  const rowsPath = argValue(argv, '--rows');
  const dailyPath = argValue(argv, '--daily-mart');
  const readoutPath = argValue(argv, '--readout');
  const logPath = argValue(argv, '--allocation-log');
  const intervalsPath = argValue(argv, '--allocation-intervals');
  if (!demo && !rowsPath && !dailyPath && !readoutPath) {
    throw new Error(
      'pass --rows <native rows.jsonl> or --daily-mart <fct_experiment_profit_by_arm_daily.jsonl> with --allocation-log <log.jsonl> or --allocation-intervals <int_experiment__allocation_log.jsonl>, --readout <fct_experiment_profit_by_arm.json|jsonl> or --demo',
    );
  }
  let rows: ExperimentProfitByArmRow[];
  if (dailyPath) {
    rows = rowsFromDailyMart(readJsonl(dailyPath));
  } else if (readoutPath) {
    const text = readFileSync(readoutPath, 'utf8').trim();
    const raw = (text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))) as unknown[];
    rows = rowsFromArmReadout(raw, { runDate });
    // The readout has no segments: allocate the fallthrough only (it has no holdout either, so it holds).
    config = { ...config, flags: config.flags.map((f) => ({ ...f, ruleTargets: [] })) };
  } else {
    rows = rowsPath ? await new JsonlRowSource(rowsPath).load() : demoRows();
  }
  const allocationLog = logPath
    ? loadAllocationLog(logPath)
    : intervalsPath
      ? new AllocationLog(
          allocationLogFromIntervals(readJsonl(intervalsPath), {
            from: addDays(runDate, -Math.max(config.lookbackDays, config.sequentialWindowDays)),
            to: addDays(runDate, -1),
            ruleTargets: Object.fromEntries(config.flags.map((f) => [f.flagKey, f.ruleTargets.map((t) => t.name)])),
          }),
        )
      : demo && !rowsPath && !dailyPath
        ? demoAllocationLog(config, rows)
        : null;

  const run = runAllocation({ rows, flags, config, runDate, allocationLog });
  log(mode === 'dry-run' ? `DRY RUN (nothing is sent)\n\n${run.report}` : run.report);
  // The report and requests are written BEFORE any live submit, so a failed write is still on record.
  const out = argValue(argv, '--out');
  if (out) {
    mkdirSync(out, { recursive: true });
    const banner = mode === 'dry-run' ? '> DRY RUN: nothing was sent to LaunchDarkly.\n\n' : '';
    writeFileSync(join(out, `report-${runDate}.md`), `${banner}${run.report}`);
    writeFileSync(join(out, `requests-${runDate}.json`), `${JSON.stringify(run.requests, null, 2)}\n`);
  }
  for (const f of run.flags) {
    if (!f.request) continue;
    if (mode === 'live' && f.envVersion !== null) {
      // Semantic patch has no version precondition; re-read right before writing.
      const res = await transport().send({ ...getFlagRequest({ projectKey: config.projectKey, flagKey: f.flagKey, environmentKey: config.environmentKey }), headers: { Authorization: env.LD_API_TOKEN!, 'LD-API-Version': '20240415' } });
      const now = parseLdFlag(res.body).environments[config.environmentKey]?.version;
      if (now !== f.envVersion) throw new Error(`${f.flagKey} changed in LaunchDarkly since it was read (version ${f.envVersion} -> ${String(now)}); re-run`);
    }
    await client.submit(f.request);
  }
  if (run.alerts.length > 0) log(`ALERTS (${run.alerts.length}):\n${run.alerts.map((a) => `- ${a}`).join('\n')}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((run) => {
      // Alerts (fail-closed holds, stopped arms, errors) make the Cloud Run job fail visibly.
      if (run && run.alerts.length > 0) process.exitCode = 2;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
