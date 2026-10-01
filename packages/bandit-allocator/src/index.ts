/**
 * @openart-signal/bandit-allocator: profit-rewarded Thompson sampling for OpenArt's
 * suite-default-model-* LaunchDarkly flags. Emits dry-run semantic patches (or approval
 * requests) plus a report; never writes to LaunchDarkly unless live mode is explicitly enabled.
 */

export * from './rng.js';
export * from './stats.js';
export * from './thompson.js';
export * from './sequential.js';
export * from './allocation-log.js';
export * from './estimate.js';
export * from './srm.js';
export * from './segments.js';
export * from './warehouse.js';
export * from './warehouse-readout.js';
export * from './warehouse-daily.js';
export * from './launchdarkly.js';
export {
  AllocatorConfigSchema,
  BigQueryRowSource,
  DEMO_RUN_DATE,
  demoAllocationLog,
  demoRows,
  isHoldoutUser,
  JsonlRowSource,
  loadAllocationLog,
  loadAllocatorConfig,
  loadFlagSnapshots,
  parsePositiveInt,
  parsePositiveNumber,
  renderReport,
  runAllocation,
  validateAllocatorConfig,
  type AllocationRun,
  type AllocatorConfig,
  type BigQueryLike,
  type CoverageResult,
  type FlagConfig,
  type FlagResult,
  type TargetResult,
} from './job.js';
export {
  DEFAULT_VALUE_CAP_USD,
  exposuresFromCohort,
  fitScoreModel,
  loadFixtureCohort,
  loadModelCosts,
  martRowsFromCohort,
  outcomesFromCohort,
  predictedProfitRows,
  PROFIT_ASSUMPTIONS,
  scoreCell,
  segmentsFromAmplitude,
  type MartRowOptions,
  type ScoreModel,
  type UserOutcome,
} from './cohort-inputs.js';
export { DEFAULT_SIMULATION, divergenceBands, renderSimulationReport, runSimulation, type SimulationOptions, type SimulationResult } from './simulate.js';
