/**
 * ILLUSTRATIVE simulation: today's fixed split vs three bandits that run this package's real daily
 * job, against the contracts cohort generator's behaviour params (@openart-signal/contracts/cohort/
 * params). Every behavioural number in those params is an assumption, so every result here is
 * illustrative, not a forecast for OpenArt.
 *
 * What each bandit sees, and when (the delays the warehouse has):
 *   - day +1: the 24h score, a SIGNALS-ONLY predicted-profit model fit on reference users generated
 *     before the experiment (uniform allocation), and the 24h guardrail metrics;
 *   - day +H (default 14): matured outcomes at the fixed horizon (conversion, winsorized value,
 *     measured serving cost, refunds). Nothing about a user's 90-day profit is ever fed back.
 * Policies:
 *   fixed_split        today's equal split, never changed
 *   conversion_bandit  reward = matured conversion (Beta-Binomial)
 *   profit_bandit      reward = p x V - C on matured outcomes (the default)
 *   score_bandit       reward = the 24h score
 *   oracle             the best fixed arm pair by true 90-day profit (large calibration run)
 * Every policy sees the same simulated people (common random numbers). Bandits run runAllocation
 * with the logged allocation, SRM, guardrails and stop-loss, and apply its patch through the
 * in-memory LaunchDarkly emulator. Policies are scored on REALIZED 90-day profit, with 95%
 * confidence intervals across replications and paired comparisons between policies.
 *
 *   npx tsx src/simulate.ts                                 # 60 days x 2,000 users/day x 10 reps
 *   npx tsx src/simulate.ts --replications 12 --out out/
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_MODEL_FLAGS } from '@openart-signal/contracts';
import { generateCohort } from '@openart-signal/contracts/cohort';
import { ARM_DEFAULT_GENERATION, COHORT_PARAMS, type CohortParams } from '@openart-signal/contracts/cohort/params';
import { AllocationLog, expectedHoldoutShare, KEY_ALPHABETS, type AllocationLogRow } from './allocation-log.js';
import {
  DEFAULT_VALUE_CAP_USD,
  exposuresFromCohort,
  fitScoreModel,
  loadModelCosts,
  martRowsFromCohort,
  outcomesFromCohort,
  PROFIT_ASSUMPTIONS,
  type CostLookup,
  type ScoreModel,
  type UserOutcome,
} from './cohort-inputs.js';
import type { RewardModel } from './estimate.js';
import { loadAllocatorConfig, loadFlagSnapshots, runAllocation, type AllocatorConfig } from './job.js';
import { applySemanticPatch, environmentOf, HOLDOUT_KEY_PATTERN, rolloutUnitsByArm, type LdFlag, type SemanticInstruction } from './launchdarkly.js';
import { SeededRng } from './rng.js';
import { studentTQuantile } from './stats.js';
import { LD_WEIGHT_TOTAL, toUnits, type GuardrailConfig } from './thompson.js';
import { addDays, MATURED_COLUMNS, type ExperimentProfitByArmRow } from './warehouse.js';

const IMG = DEFAULT_MODEL_FLAGS.createImage;
const VID = DEFAULT_MODEL_FLAGS.createVideo;
const FLAGS = [IMG, VID] as const;
type FlagKey = (typeof FLAGS)[number];
const ARMS: Record<FlagKey, string[]> = {
  [IMG]: Object.keys(COHORT_PARAMS.armWeights[IMG]),
  [VID]: Object.keys(COHORT_PARAMS.armWeights[VID]),
};

export const POLICIES = ['fixed_split', 'conversion_bandit', 'profit_bandit', 'score_bandit', 'oracle'] as const;
export type PolicyName = (typeof POLICIES)[number];
export type BanditPolicy = Extract<PolicyName, `${string}_bandit`>;
const BANDIT_REWARD: Record<BanditPolicy, RewardModel> = { conversion_bandit: 'conversion', profit_bandit: 'decomposed_profit', score_bandit: 'predicted_profit' };
const isBandit = (p: PolicyName): p is BanditPolicy => p.endsWith('_bandit');

/** Named parameter scenarios. `default` is the contracts cohort exactly as published. */
export const SCENARIOS: Record<string, { description: string; armConversionMultiplier?: Record<string, number> }> = {
  default: { description: 'contracts cohort params unchanged (ILLUSTRATIVE)' },
};

export interface SimulationOptions {
  days: number;
  usersPerDay: number;
  replications: number;
  scenario: string;
  /** Extra per-arm conversion multipliers on top of the scenario (sensitivity runs). */
  armConversionMultiplier?: Record<string, number>;
  startDate: string;
  calibrationUsersPerArm: number;
  seed: string;
  /** Fixed horizon of the matured outcomes, in days after exposure. */
  outcomeHorizonDays: number;
  /** Monte-Carlo draws per Thompson decision (the production default is 20,000). */
  thompsonDraws: number;
  guardrails?: Partial<GuardrailConfig>;
  /** Last word on each bandit's allocator config (tests shrink the minimums with it). */
  configure?: (config: AllocatorConfig, policy: BanditPolicy) => AllocatorConfig;
}

export const DEFAULT_SIMULATION: SimulationOptions = {
  days: 60,
  usersPerDay: 2000,
  replications: 10,
  scenario: 'default',
  startDate: '2026-06-01',
  calibrationUsersPerArm: 50_000,
  seed: 'openart-signal/bandit-sim/v2',
  outcomeHorizonDays: PROFIT_ASSUMPTIONS.outcomeHorizonDays,
  thompsonDraws: 4000,
};

type Weights = Record<FlagKey, Record<string, number>>;

/**
 * Generator params for one simulated day. COHORT_PARAMS is declared `as const`, so its type pins
 * literal values; the generator only reads them as numbers/strings, hence the cast.
 */
function dayParams(weights: Weights, day: string, multipliers: Record<string, number> | undefined): CohortParams {
  return {
    ...COHORT_PARAMS,
    armWeights: { [IMG]: weights[IMG], [VID]: weights[VID] },
    armConversionMultiplier: { ...COHORT_PARAMS.armConversionMultiplier, ...(multipliers ?? {}) },
    signupStart: `${day}T00:00:00Z`,
    signupWindowDays: 1,
    simulationEnd: `${addDays(day, 92)}T00:00:00Z`,
  } as unknown as CohortParams;
}

const uniform = (flag: FlagKey): Record<string, number> => Object.fromEntries(ARMS[flag].map((a) => [a, 1]));
const oneHot = (flag: FlagKey, arm: string): Record<string, number> => Object.fromEntries(ARMS[flag].map((a) => [a, a === arm ? 1 : 0]));

function normalized(w: Weights): Weights {
  const out = {} as Weights;
  for (const flag of FLAGS) {
    const total = Object.values(w[flag]).reduce((a, b) => a + b, 0);
    out[flag] = Object.fromEntries(Object.entries(w[flag]).map(([a, x]) => [a, x / total]));
  }
  return out;
}

interface Batch {
  outcomes: UserOutcome[];
  /** Rows as the mart shows them once the horizon has elapsed. */
  matured: ExperimentProfitByArmRow[];
  /** The same rows before that: matured columns all 0. */
  immature: ExperimentProfitByArmRow[];
}

function immature(r: ExperimentProfitByArmRow): ExperimentProfitByArmRow {
  const out: ExperimentProfitByArmRow = { ...r, converted_users: 0 };
  for (const c of MATURED_COLUMNS) out[c] = 0;
  return out;
}

function simulateBatch(o: { weights: Weights; day: string; users: number; seed: string; slice: 'holdout' | 'bandit'; multipliers: Record<string, number> | undefined; costOf: CostLookup; score: ScoreModel | null; horizon: number }): Batch {
  if (o.users <= 0) return { outcomes: [], matured: [], immature: [] };
  const cohort = generateCohort({ users: o.users, seed: o.seed, params: dayParams(o.weights, o.day, o.multipliers) });
  const outcomes = outcomesFromCohort(cohort, { ...PROFIT_ASSUMPTIONS, outcomeHorizonDays: o.horizon }, o.costOf);
  if (!o.score) return { outcomes, matured: [], immature: [] };
  const matured = martRowsFromCohort(outcomes, exposuresFromCohort(cohort), { sliceOf: () => o.slice, score: o.score, valueCapUsd: DEFAULT_VALUE_CAP_USD });
  return { outcomes, matured, immature: matured.map(immature) };
}

// ---------------------------------------------------------------------------
// Calibration: true expected profit / conversion / serving cost per arm (marginal per flag)
// ---------------------------------------------------------------------------

export interface ArmTruth {
  arm: string;
  users: number;
  profitPerUser: number;
  profitSe: number;
  /** Paired (common-random-number) difference to the best arm and its standard error. */
  profitGapToBest: number;
  profitGapSe: number;
  conversionRate: number;
  conversionSe: number;
  activationRate: number;
  servingCostPerUser: number;
  /** Mean 90-day profit of users who subscribed / did not (profit = p*P + (1-p)*F). */
  profitPerConverter: number;
  profitPerNonConverter: number;
  defaultCredits: number;
  defaultListCostUsd: number;
}

/**
 * Where conversion and profit would rank a pair of arms differently. For an arm E whose default
 * generation costs more than arm C's: profit_E = p_E * P_E + (1 - p_E) * F_E, so E matches C's
 * profit once p_E >= (profit_C - F_E) / (P_E - F_E). Between p_C and that rate E converts better
 * but earns less: the only region where a conversion-rewarded bandit is misled.
 */
export interface DivergenceBand {
  flag: FlagKey;
  expensiveArm: string;
  cheaperArm: string;
  cheaperConversion: number;
  expensiveConversion: number;
  breakEvenConversion: number;
  /** Width of the disagreement band in percentage points (0 when it does not exist). */
  bandPp: number;
}

export interface Calibration {
  users: number;
  image: ArmTruth[];
  video: ArmTruth[];
  oracle: Record<FlagKey, string>;
  conversionBest: Record<FlagKey, string>;
  divergence: DivergenceBand[];
  /** Pooled value per conversion at the fixed horizon (winsorized), from the reference users. */
  historicalValuePerConversion: number;
  score: ScoreModel;
}

function calibrate(opts: SimulationOptions, multipliers: Record<string, number> | undefined, costOf: CostLookup): Calibration {
  const batchSize = 2000;
  const batches = Math.max(1, Math.round(opts.calibrationUsersPerArm / batchSize));
  const out = {} as Record<FlagKey, ArmTruth[]>;
  const reference: UserOutcome[] = [];
  for (const flag of FLAGS) {
    const other: FlagKey = flag === IMG ? VID : IMG;
    const perArm = new Map<string, UserOutcome[]>();
    for (const arm of ARMS[flag]) {
      const users: UserOutcome[] = [];
      for (let b = 0; b < batches; b += 1) {
        const weights = { [flag]: oneHot(flag, arm), [other]: uniform(other) } as Weights;
        users.push(...simulateBatch({ weights, day: opts.startDate, users: batchSize, seed: `${opts.seed}/calibration/${flag}/b${b}`, slice: 'bandit', multipliers, costOf, score: null, horizon: opts.outcomeHorizonDays }).outcomes);
      }
      perArm.set(arm, users);
      reference.push(...users);
    }
    const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const se = (xs: readonly number[]) => {
      const m = mean(xs);
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
    };
    const profitOf = (arm: string) => perArm.get(arm)!.map((u) => u.profit_usd);
    const best = [...ARMS[flag]].sort((a, b) => mean(profitOf(b)) - mean(profitOf(a)))[0]!;
    const bestProfits = profitOf(best);
    out[flag] = ARMS[flag].map((arm) => {
      const us = perArm.get(arm)!;
      const xs = us.map((u) => u.profit_usd);
      const conv = us.map((u) => (u.converted ? 1 : 0));
      const converters = us.filter((u) => u.converted);
      const others = us.filter((u) => !u.converted);
      const g = ARM_DEFAULT_GENERATION[arm]!;
      return {
        arm,
        users: xs.length,
        profitPerUser: mean(xs),
        profitSe: se(xs),
        profitGapToBest: mean(xs.map((x, i) => bestProfits[i]! - x)),
        profitGapSe: arm === best ? 0 : se(xs.map((x, i) => bestProfits[i]! - x)),
        conversionRate: mean(conv),
        conversionSe: se(conv),
        activationRate: mean(us.map((u) => (u.activated_24h ? 1 : 0))),
        servingCostPerUser: mean(us.map((u) => u.generation_cost_usd)),
        profitPerConverter: mean(converters.map((u) => u.profit_usd)),
        profitPerNonConverter: mean(others.map((u) => u.profit_usd)),
        defaultCredits: g.credits,
        defaultListCostUsd: costOf(g.businessType, g.credits),
      };
    });
  }
  const argmax = (xs: ArmTruth[], f: (t: ArmTruth) => number) => [...xs].sort((a, b) => f(b) - f(a))[0]!.arm;
  const converters = reference.filter((u) => u.converted_h);
  return {
    users: batches * batchSize,
    image: out[IMG],
    video: out[VID],
    oracle: { [IMG]: argmax(out[IMG], (t) => t.profitPerUser), [VID]: argmax(out[VID], (t) => t.profitPerUser) } as Record<FlagKey, string>,
    conversionBest: { [IMG]: argmax(out[IMG], (t) => t.conversionRate), [VID]: argmax(out[VID], (t) => t.conversionRate) } as Record<FlagKey, string>,
    divergence: divergenceBands({ [IMG]: out[IMG], [VID]: out[VID] } as Record<FlagKey, ArmTruth[]>),
    historicalValuePerConversion: converters.reduce((s, u) => s + Math.min(DEFAULT_VALUE_CAP_USD, u.value_h_usd), 0) / Math.max(1, converters.length),
    // The 24h score is fit on these pre-experiment reference users (uniform over arms): out of sample for the run.
    score: fitScoreModel(reference, { version: 'sim-24h-signals-v2' }),
  };
}

/** Disagreement bands for every (more expensive, cheaper) pair of default arms per flag. */
export function divergenceBands(arms: Record<FlagKey, ArmTruth[]>): DivergenceBand[] {
  const bands: DivergenceBand[] = [];
  for (const flag of FLAGS) {
    for (const e of arms[flag]) {
      for (const c of arms[flag]) {
        if (e.defaultListCostUsd <= c.defaultListCostUsd) continue;
        const denom = e.profitPerConverter - e.profitPerNonConverter;
        const breakEven = denom > 0 ? (c.profitPerUser - e.profitPerNonConverter) / denom : Number.POSITIVE_INFINITY;
        bands.push({
          flag,
          expensiveArm: e.arm,
          cheaperArm: c.arm,
          cheaperConversion: c.conversionRate,
          expensiveConversion: e.conversionRate,
          breakEvenConversion: breakEven,
          bandPp: Math.max(0, 100 * (breakEven - c.conversionRate)),
        });
      }
    }
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface PolicyMetrics {
  policy: PolicyName;
  users: number;
  profitPerUser: number;
  conversionRate: number;
  servingCostPerUser: number;
  /** Realized regret vs the oracle on the same simulated users, USD per 1,000 users. */
  regretPer1000: number;
  /** Expected (pseudo-)regret from calibrated per-arm means, USD per 1,000 users. */
  expectedRegretPer1000: number;
  armShare: Record<FlagKey, Record<string, number>>;
  finalWeights: Record<FlagKey, Record<string, number>>;
  /** Days on which the job emitted a patch. */
  patchDays: number;
  /** First simulated day with a patch (null: never). A guardrail stop can be the first patch. */
  firstPatchDay: number | null;
  /** First simulated day on which Thompson itself moved weights (null: never). */
  firstThompsonDay: number | null;
  /** (flag, target, arm) stops that took traffic away, over the run. */
  stops: number;
  /** Of those, stops by a non-profit guardrail (the rest are always-valid stop-losses). */
  guardrailStops: number;
  /** Flag-days the job held for a data check (SRM, coverage, missing inputs). */
  dataHolds: number;
}

function simFlags(config: AllocatorConfig): Record<string, LdFlag> {
  const fixtures = loadFlagSnapshots(fileURLToPath(new URL('../fixtures/flags/', import.meta.url)));
  const out: Record<string, LdFlag> = {};
  for (const flag of FLAGS) {
    const f = structuredClone(fixtures[flag]!);
    const env = environmentOf(f, config.environmentKey);
    env.rules = [env.rules[0]!];
    // Today's fixed split in the cohort params is equal allocation (ILLUSTRATIVE).
    const units = toUnits(ARMS[flag].map(() => 1 / ARMS[flag].length), LD_WEIGHT_TOTAL, ARMS[flag].map(() => 0));
    env.fallthrough = { rollout: { variations: f.variations.map((v, i) => ({ variation: i, weight: units[ARMS[flag].indexOf(String(v.value))]! })), bucketBy: 'key', contextKind: 'user' } };
    out[flag] = f;
  }
  return out;
}

function unitsOf(flags: Record<string, LdFlag>, env: string, flag: FlagKey, target: 'fallthrough' | 'holdout'): Map<string, number> {
  const f = flags[flag]!;
  const e = environmentOf(f, env);
  return rolloutUnitsByArm(f, target === 'fallthrough' ? e.fallthrough : e.rules[0]!, ARMS[flag]).units;
}

export interface Interval {
  mean: number;
  sd: number;
  lower: number;
  upper: number;
}

/** Mean with a two-sided 95% t interval across replications. */
export function interval95(xs: readonly number[]): Interval {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  if (n < 2) return { mean, sd: 0, lower: mean, upper: mean };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const h = studentTQuantile(0.975, n - 1) * (sd / Math.sqrt(n));
  return { mean, sd, lower: mean - h, upper: mean + h };
}

export interface PairwiseComparison {
  a: PolicyName;
  b: PolicyName;
  /** Realized regret of a minus b, USD per 1,000 users (paired by replication). */
  realized: Interval;
  expected: Interval;
  distinguishable: boolean;
}

export interface SimulationResult {
  illustrative: true;
  note: string;
  options: Omit<SimulationOptions, 'configure'>;
  scenario: { name: string; description: string; armConversionMultiplier: Record<string, number> };
  calibration: Omit<Calibration, 'score'>;
  replications: PolicyMetrics[][];
  summary: Array<{
    policy: PolicyName;
    mean: Omit<PolicyMetrics, 'policy'>;
    regret: Interval;
    expectedRegret: Interval;
    profitPerUser: Interval;
  }>;
  comparisons: PairwiseComparison[];
  finding: string;
}

export function runSimulation(partial: Partial<SimulationOptions> = {}): SimulationResult {
  const opts: SimulationOptions = { ...DEFAULT_SIMULATION, ...partial };
  const scenario = SCENARIOS[opts.scenario];
  if (!scenario) throw new Error(`unknown scenario ${opts.scenario}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  if (!(opts.replications >= 1)) throw new Error('replications must be >= 1');
  const multipliers = { ...(scenario.armConversionMultiplier ?? {}), ...(opts.armConversionMultiplier ?? {}) };
  const costOf = loadModelCosts();
  const calibration = calibrate(opts, multipliers, costOf);
  const truth = new Map<string, number>([...calibration.image, ...calibration.video].map((t) => [t.arm, t.profitPerUser]));
  const bestMean = { [IMG]: truth.get(calibration.oracle[IMG])!, [VID]: truth.get(calibration.oracle[VID])! } as Record<FlagKey, number>;
  const holdoutShare = expectedHoldoutShare(HOLDOUT_KEY_PATTERN, KEY_ALPHABETS.base62!);

  const base = loadAllocatorConfig(fileURLToPath(new URL('../fixtures/allocator.config.json', import.meta.url)));
  const configFor = (policy: BanditPolicy): AllocatorConfig => {
    const reward = BANDIT_REWARD[policy];
    // MDE, tau and the expected-loss gate are in reward units: USD for the profit rewards, a rate for conversion.
    const rateUnits = reward === 'conversion';
    const cfg: AllocatorConfig = {
      ...base,
      reward,
      rewardModel: { ...base.rewardModel, valuePerConversionUsd: calibration.historicalValuePerConversion },
      approvals: { mode: 'direct', notifyMemberIds: [], notifyTeamKeys: [] },
      guardrails: {
        ...base.guardrails,
        thompsonDraws: opts.thompsonDraws,
        ...(rateUnits ? { minimumDetectableEffect: 0.01, minExpectedLossToMove: 0.0002 } : {}),
        ...(opts.guardrails ?? {}),
        stopLoss: { ...base.guardrails.stopLoss, ...(rateUnits ? { tau: 0.01 } : {}), ...(opts.guardrails?.stopLoss ?? {}) },
      },
      flags: base.flags.map((f) => ({ ...f, ruleTargets: [] })),
    };
    return opts.configure ? opts.configure(cfg, policy) : cfg;
  };

  const replications: PolicyMetrics[][] = [];
  for (let rep = 0; rep < opts.replications; rep += 1) {
    // Holdout sizes: each user's key ends in [0-5] with probability 6/62 (common to every policy).
    const holdoutRng = new SeededRng(`${opts.seed}/rep${rep}/holdout-sizes`);
    const holdoutUsers = Array.from({ length: opts.days }, () => {
      let k = 0;
      for (let i = 0; i < opts.usersPerDay; i += 1) if (holdoutRng.next() < holdoutShare) k += 1;
      return k;
    });
    const perPolicy: PolicyMetrics[] = [];
    let oracleProfit = 0;
    for (const policy of ['oracle', 'fixed_split', 'conversion_bandit', 'profit_bandit', 'score_bandit'] as const) {
      const bandit = isBandit(policy);
      const config = bandit ? configFor(policy) : null;
      let flags = simFlags(config ?? base);
      const days: Array<{ matured: ExperimentProfitByArmRow[]; immature: ExperimentProfitByArmRow[] }> = [];
      const logRows: AllocationLogRow[] = [];
      let users = 0;
      let profit = 0;
      let conversions = 0;
      let serving = 0;
      let expectedRegret = 0;
      let patchDays = 0;
      let firstPatchDay: number | null = null;
      let firstThompsonDay: number | null = null;
      let stops = 0;
      let guardrailStops = 0;
      let dataHolds = 0;
      const armCounts = { [IMG]: {}, [VID]: {} } as Record<FlagKey, Record<string, number>>;
      let finalWeights = {} as Weights;
      for (let d = 0; d < opts.days; d += 1) {
        const day = addDays(opts.startDate, d);
        if (bandit && d > 0) {
          const rows = days.flatMap((x, t) => (d - t >= opts.outcomeHorizonDays ? x.matured : x.immature));
          const run = runAllocation({ rows, flags, config: config!, runDate: day, allocationLog: new AllocationLog(logRows) });
          for (const f of run.flags) {
            if (f.status === 'error') throw new Error(`simulation job error on ${day}: ${f.reasons.join('; ')}`);
            if (f.status === 'held') dataHolds += 1;
            for (const t of f.targets) {
              for (const a of t.decision.arms) {
                if (!a.stopped || a.currentWeight <= 0) continue;
                stops += 1;
                if (a.reasons.some((why) => why.startsWith('guardrail:'))) guardrailStops += 1;
              }
              if (t.instruction && t.decision.arms.some((a) => a.targetWeight !== null)) firstThompsonDay ??= d;
            }
            const ins = (f.request?.body as { instructions?: SemanticInstruction[] } | undefined)?.instructions;
            if (ins && ins.length > 0) flags = { ...flags, [f.flagKey]: applySemanticPatch(flags[f.flagKey]!, config!.environmentKey, ins) };
          }
          if (run.flags.some((f) => f.request)) {
            patchDays += 1;
            firstPatchDay ??= d;
          }
        }
        const env = (config ?? base).environmentKey;
        const fallthrough: Weights =
          policy === 'oracle'
            ? { [IMG]: oneHot(IMG, calibration.oracle[IMG]), [VID]: oneHot(VID, calibration.oracle[VID]) }
            : policy === 'fixed_split'
              ? { [IMG]: uniform(IMG), [VID]: uniform(VID) }
              : ({ [IMG]: Object.fromEntries(unitsOf(flags, env, IMG, 'fallthrough')), [VID]: Object.fromEntries(unitsOf(flags, env, VID, 'fallthrough')) } as Weights);
        finalWeights = normalized(fallthrough);
        const holdoutWeights: Weights = policy === 'oracle' ? fallthrough : { [IMG]: uniform(IMG), [VID]: uniform(VID) };
        if (bandit) {
          for (const flag of FLAGS) {
            for (const [target, units] of [['fallthrough', unitsOf(flags, env, flag, 'fallthrough')], ['holdout', unitsOf(flags, env, flag, 'holdout')]] as const) {
              for (const [arm, w] of units) logRows.push({ date: day, flag_key: flag, target, arm, weight_units: w });
            }
          }
        }
        // Same seeds for every policy (common random numbers).
        const nHoldout = holdoutUsers[d]!;
        const batches = [
          simulateBatch({ weights: holdoutWeights, day, users: nHoldout, seed: `${opts.seed}/rep${rep}/day${d}/holdout`, slice: 'holdout', multipliers, costOf, score: bandit ? calibration.score : null, horizon: opts.outcomeHorizonDays }),
          simulateBatch({ weights: fallthrough, day, users: opts.usersPerDay - nHoldout, seed: `${opts.seed}/rep${rep}/day${d}/bandit`, slice: 'bandit', multipliers, costOf, score: bandit ? calibration.score : null, horizon: opts.outcomeHorizonDays }),
        ];
        days.push({ matured: batches.flatMap((b) => b.matured), immature: batches.flatMap((b) => b.immature) });
        for (const b of batches) {
          for (const u of b.outcomes) {
            users += 1;
            profit += u.profit_usd;
            if (u.converted) conversions += 1;
            serving += u.generation_cost_usd;
            for (const flag of FLAGS) {
              const arm = u.arms[flag]!;
              armCounts[flag][arm] = (armCounts[flag][arm] ?? 0) + 1;
              expectedRegret += bestMean[flag] - truth.get(arm)!;
            }
          }
        }
      }
      if (policy === 'oracle') oracleProfit = profit;
      perPolicy.push({
        policy,
        users,
        profitPerUser: profit / users,
        conversionRate: conversions / users,
        servingCostPerUser: serving / users,
        // The oracle's own regret is 0 by definition (summation order would leave float noise).
        regretPer1000: policy === 'oracle' ? 0 : ((oracleProfit - profit) / users) * 1000,
        expectedRegretPer1000: (expectedRegret / users) * 1000,
        armShare: Object.fromEntries(FLAGS.map((f) => [f, Object.fromEntries(ARMS[f].map((a) => [a, (armCounts[f][a] ?? 0) / users]))])) as PolicyMetrics['armShare'],
        finalWeights,
        patchDays,
        firstPatchDay,
        firstThompsonDay,
        stops,
        guardrailStops,
        dataHolds,
      });
    }
    replications.push(POLICIES.map((p) => perPolicy.find((m) => m.policy === p)!));
  }

  const series = (policy: PolicyName, f: (m: PolicyMetrics) => number) => replications.map((r) => f(r.find((m) => m.policy === policy)!));
  const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const summary = POLICIES.map((policy) => {
    const ms = replications.map((r) => r.find((m) => m.policy === policy)!);
    const share = (key: 'armShare' | 'finalWeights') =>
      Object.fromEntries(FLAGS.map((f) => [f, Object.fromEntries(ARMS[f].map((a) => [a, avg(ms.map((m) => m[key][f][a] ?? 0))]))])) as PolicyMetrics['armShare'];
    const meanDay = (xs: Array<number | null>) => {
      const days = xs.filter((x): x is number => x !== null);
      return days.length ? avg(days) : null;
    };
    return {
      policy,
      mean: {
        users: avg(ms.map((m) => m.users)),
        profitPerUser: avg(ms.map((m) => m.profitPerUser)),
        conversionRate: avg(ms.map((m) => m.conversionRate)),
        servingCostPerUser: avg(ms.map((m) => m.servingCostPerUser)),
        regretPer1000: avg(ms.map((m) => m.regretPer1000)),
        expectedRegretPer1000: avg(ms.map((m) => m.expectedRegretPer1000)),
        armShare: share('armShare'),
        finalWeights: share('finalWeights'),
        patchDays: avg(ms.map((m) => m.patchDays)),
        firstPatchDay: meanDay(ms.map((m) => m.firstPatchDay)),
        firstThompsonDay: meanDay(ms.map((m) => m.firstThompsonDay)),
        stops: avg(ms.map((m) => m.stops)),
        guardrailStops: avg(ms.map((m) => m.guardrailStops)),
        dataHolds: avg(ms.map((m) => m.dataHolds)),
      },
      regret: interval95(series(policy, (m) => m.regretPer1000)),
      expectedRegret: interval95(series(policy, (m) => m.expectedRegretPer1000)),
      profitPerUser: interval95(series(policy, (m) => m.profitPerUser)),
    };
  });

  const pairs: Array<[PolicyName, PolicyName]> = [
    ['profit_bandit', 'fixed_split'],
    ['conversion_bandit', 'fixed_split'],
    ['score_bandit', 'fixed_split'],
    ['profit_bandit', 'conversion_bandit'],
    ['profit_bandit', 'score_bandit'],
  ];
  const comparisons: PairwiseComparison[] = pairs.map(([a, b]) => {
    const realized = interval95(series(a, (m) => m.regretPer1000).map((x, i) => x - series(b, (m) => m.regretPer1000)[i]!));
    const expected = interval95(series(a, (m) => m.expectedRegretPer1000).map((x, i) => x - series(b, (m) => m.expectedRegretPer1000)[i]!));
    return { a, b, realized, expected, distinguishable: opts.replications >= 2 && (realized.upper < 0 || realized.lower > 0) };
  });

  const { score: _score, ...calibrationOut } = calibration;
  void _score;
  const { configure: _configure, ...optionsOut } = opts;
  void _configure;
  const result: SimulationResult = {
    illustrative: true,
    note: 'ILLUSTRATIVE: behaviour comes from the contracts cohort params, which are assumptions, not OpenArt data. Bandits see a signals-only 24h score one day after exposure and matured outcomes only after the fixed horizon; policies are scored on realized 90-day profit.',
    options: optionsOut,
    scenario: { name: opts.scenario, description: scenario.description, armConversionMultiplier: { ...COHORT_PARAMS.armConversionMultiplier, ...multipliers } },
    calibration: calibrationOut,
    replications,
    summary,
    comparisons,
    finding: '',
  };
  result.finding = describeFinding(result);
  return result;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const ci = (i: Interval, digits = 0) => `${i.mean.toFixed(digits)} [${i.lower.toFixed(digits)}, ${i.upper.toFixed(digits)}]`;

/** Plain-language verdict, driven by the confidence intervals, not by point estimates. */
export function describeFinding(r: SimulationResult): string {
  const cmp = (a: PolicyName, b: PolicyName) => r.comparisons.find((c) => c.a === a && c.b === b)!;
  const reg = (p: PolicyName) => r.summary.find((s) => s.policy === p)!;
  const say = (a: PolicyName, b: PolicyName) => {
    const c = cmp(a, b);
    const verdict = c.distinguishable ? (c.realized.mean < 0 ? `${a} has LOWER regret (distinguishable)` : `${a} has HIGHER regret (distinguishable)`) : 'NOT distinguishable';
    return `${a} - ${b}: ${ci(c.realized)} $/1k users realized (${verdict}); expected-regret difference ${ci(c.expected)}.`;
  };
  const parts = [
    `${r.options.replications} replications of ${r.options.days} days x ${r.options.usersPerDay} users/day; 95% t intervals across replications.`,
    `Realized regret vs the oracle ($ per 1,000 users): fixed split ${ci(reg('fixed_split').regret)}, conversion bandit ${ci(reg('conversion_bandit').regret)}, profit bandit ${ci(reg('profit_bandit').regret)}, 24h-score bandit ${ci(reg('score_bandit').regret)}.`,
    say('profit_bandit', 'fixed_split'),
    say('conversion_bandit', 'fixed_split'),
    say('score_bandit', 'fixed_split'),
    say('profit_bandit', 'conversion_bandit'),
    say('profit_bandit', 'score_bandit'),
  ];
  const day = (x: number | null) => (x === null ? 'never' : x.toFixed(0));
  const bandits = ['conversion_bandit', 'profit_bandit', 'score_bandit'] as const;
  parts.push(
    `Thompson first moves weights on day ${bandits.map((p) => day(reg(p).mean.firstThompsonDay)).join(' / ')} (conversion / profit / 24h score): matured outcomes need the ${r.options.outcomeHorizonDays}-day horizon plus the MDE-based sample, the 24h score only a day. ` +
      `Earlier patches are stops: ${bandits.map((p) => `${reg(p).mean.guardrailStops.toFixed(1)} guardrail and ${(reg(p).mean.stops - reg(p).mean.guardrailStops).toFixed(1)} stop-loss`).join(' / ')} per run.`,
  );
  return parts.join(' ');
}

export function renderSimulationReport(r: SimulationResult): string {
  const L: string[] = [];
  L.push('# ILLUSTRATIVE simulation: fixed split vs conversion, profit and 24h-score bandits');
  L.push('');
  L.push(`> **ILLUSTRATIVE.** ${r.note}`);
  L.push('');
  L.push(
    `Scenario \`${r.scenario.name}\` (${r.scenario.description}). ${r.options.days} days x ${r.options.usersPerDay} signups/day, holdout = keys ending in [0-5] (9.7%), ${r.options.replications} replication(s) with common random numbers across policies. Matured outcomes arrive ${r.options.outcomeHorizonDays} days after exposure; the 24h score one day after. ${r.options.thompsonDraws} Thompson draws per decision.`,
  );
  L.push('');
  L.push(`## Calibration (${r.calibration.users.toLocaleString('en-US')} simulated users per arm; other flag uniform)`);
  L.push('');
  L.push('| Flag | Arm | Default credits | List cost / default generation | Activation (24h) | Conversion | Serving cost / user | Profit / user (SE) | Gap to best (paired SE) |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [flag, arms] of [[IMG, r.calibration.image], [VID, r.calibration.video]] as const) {
    for (const t of arms) {
      L.push(
        `| ${flag === IMG ? 'image' : 'video'} | ${t.arm}${t.arm === r.calibration.oracle[flag] ? ' (profit-best)' : ''}${t.arm === r.calibration.conversionBest[flag] ? ' (conversion-best)' : ''} | ${t.defaultCredits} | $${t.defaultListCostUsd.toFixed(4)} | ${pct(t.activationRate)} | ${pct(t.conversionRate)} | ${usd(t.servingCostPerUser)} | ${usd(t.profitPerUser)} (${t.profitSe.toFixed(2)}) | ${usd(-t.profitGapToBest)} (${t.profitGapSe.toFixed(2)}) |`,
      );
    }
  }
  L.push('');
  L.push(`Historical value per conversion at the ${r.options.outcomeHorizonDays}-day horizon (winsorized at $${DEFAULT_VALUE_CAP_USD}): ${usd(r.calibration.historicalValuePerConversion)}.`);
  L.push('');
  L.push('### Where the two rewards could disagree (break-even conversion)');
  L.push('');
  L.push('| Flag | Expensive arm | Cheaper arm | Cheaper arm conversion | Expensive arm conversion (actual) | Break-even conversion | Band where rewards disagree |');
  L.push('|---|---|---|---:|---:|---:|---:|');
  for (const b of r.calibration.divergence) {
    L.push(
      `| ${b.flag === IMG ? 'image' : 'video'} | ${b.expensiveArm} | ${b.cheaperArm} | ${pct(b.cheaperConversion)} | ${pct(b.expensiveConversion)} | ${Number.isFinite(b.breakEvenConversion) ? pct(b.breakEvenConversion) : 'n/a'} | ${b.bandPp > 0 ? `${b.bandPp.toFixed(2)}pp` : 'none'} |`,
    );
  }
  L.push('');
  L.push('## Policies (mean over replications, [95% CI])');
  L.push('');
  L.push('| Policy | Profit / exposed user | Conversion | Serving cost / user | Realized regret vs oracle, $/1k users | Expected regret, $/1k users | Share on NB Pro | Share on NB 2 | Share on Seedance 2.5 | First Thompson move (day) | Stops (guardrail) | Data holds |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of r.summary) {
    const m = s.mean;
    L.push(
      `| ${s.policy} | ${usd(s.profitPerUser.mean)} [${usd(s.profitPerUser.lower)}, ${usd(s.profitPerUser.upper)}] | ${pct(m.conversionRate)} | ${usd(m.servingCostPerUser)} | ${ci(s.regret)} | ${ci(s.expectedRegret)} | ${pct(m.armShare[IMG]['nano-banana-pro'] ?? 0)} | ${pct(m.armShare[IMG]['nano-banana-2'] ?? 0)} | ${pct(m.armShare[VID]['byte-plus-seedance-2-5'] ?? 0)} | ${m.firstThompsonDay === null ? 'never' : m.firstThompsonDay.toFixed(1)} | ${m.stops.toFixed(1)} (${m.guardrailStops.toFixed(1)}) | ${m.dataHolds.toFixed(1)} |`,
    );
  }
  L.push('');
  L.push('## Paired comparisons (regret of A minus regret of B; negative = A better)');
  L.push('');
  L.push('| A | B | Realized, $/1k users [95% CI] | Expected, $/1k users [95% CI] | Distinguishable (realized) |');
  L.push('|---|---|---:|---:|---|');
  for (const c of r.comparisons) L.push(`| ${c.a} | ${c.b} | ${ci(c.realized)} | ${ci(c.expected)} | ${c.distinguishable ? 'yes' : 'no'} |`);
  L.push('');
  L.push('Final-day fallthrough weights (bandits; mean over replications):');
  L.push('');
  for (const s of r.summary.filter((x) => x.policy.endsWith('bandit'))) {
    for (const flag of FLAGS) L.push(`- ${s.policy}, ${flag}: ${Object.entries(s.mean.finalWeights[flag]).map(([a, w]) => `${a} ${pct(w)}`).join(', ')}`);
  }
  L.push('');
  L.push('## Finding');
  L.push('');
  L.push(r.finding);
  L.push('');
  return `${L.join('\n')}\n`;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<SimulationResult> {
  const num = (name: string) => (argValue(argv, name) === undefined ? undefined : Number(argValue(argv, name)));
  const partial: Partial<SimulationOptions> = {};
  for (const [flag, key] of [
    ['--days', 'days'],
    ['--users-per-day', 'usersPerDay'],
    ['--replications', 'replications'],
    ['--calibration-users', 'calibrationUsersPerArm'],
    ['--horizon', 'outcomeHorizonDays'],
    ['--draws', 'thompsonDraws'],
  ] as const) {
    const v = num(flag);
    if (v !== undefined) {
      if (!Number.isInteger(v) || v < 1) throw new Error(`${flag} must be a positive integer`);
      partial[key] = v;
    }
  }
  if (argValue(argv, '--scenario')) partial.scenario = argValue(argv, '--scenario')!;
  const mult = argValue(argv, '--multiplier'); // e.g. --multiplier nano-banana-pro=2.4
  if (mult) {
    const [arm, value] = mult.split('=');
    partial.armConversionMultiplier = { [arm!]: Number(value) };
  }
  const result = runSimulation(partial);
  const report = renderSimulationReport(result);
  console.log(report);
  const out = argValue(argv, '--out');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `simulation-${result.scenario.name}.md`), report);
    writeFileSync(join(out, `simulation-${result.scenario.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
