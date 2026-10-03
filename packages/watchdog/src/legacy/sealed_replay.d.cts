import type { CDPSession } from 'puppeteer-core';

export interface ReplayScenarioDef {
  desc: string;
  code: string;
}

export interface PreSealContext {
  layer: 'fetch-target' | 'fetch-browser';
  label: string;
  scenario: string;
  t: number;
}

export interface PreSealHook {
  // Called for every Fetch.requestPaused BEFORE the full seal. Must resolve the request
  // (continue / fail / fulfill) and record it.
  handler: (session: CDPSession, event: any, ctx: PreSealContext) => Promise<void>;
  patterns: Array<{ urlPattern?: string; resourceType?: string; requestStage?: 'Request' | 'Response' }>;
  /** [watchdog] Script evaluated in every page/frame/worker before its own scripts (the in-page seal). */
  initScript?: string;
}

export interface RunSealedReplayOptions {
  runName?: string;
  pageUrl?: string;
  setName?: string;
  blockedMode?: 'both' | 'fetchonly';
  scenarios?: Record<string, ReplayScenarioDef>;
  scenarioList?: string[];
  needles?: { email: string; txn: string };
  profileDir: string;
  outFile?: string | null;
  bodiesDir?: string | null;
  screenshotPath?: string;
  chromePath?: string;
  extraArgs?: string[];
  userAgent?: string;
  userAgentMetadata?: unknown;
  preSeal?: PreSealHook | null;
  /** [watchdog] Chrome preferences written into the fresh profile before launch. */
  profilePrefs?: Record<string, unknown>;
  /** [watchdog] puppeteer default args to drop (default ['--enable-automation']). */
  ignoreDefaultArgs?: string[];
  allowConnect?: (host: string, port: number) => boolean;
  /** Wait at a shared launch barrier after the full seal and its probes are installed. */
  beforeReplay?: () => Promise<void>;
  scenarioGapMs?: number;
  tailMs?: number;
  settleMs?: number;
  log?: (msg: string) => void;
}

// The run object is the original harness's raw capture format (see research/11 §10).
export interface SealedRun {
  meta: Record<string, any>;
  load: Record<string, any>;
  versions: Record<string, any>;
  readiness: any;
  seal: Record<string, any>;
  sealProbes: Array<{ phase: string; at: string; result: Record<string, unknown> }>;
  wrap: any;
  timeline: Array<{ scenario: string; desc: string; start: string; end: string; before: any; result: any; after: any }>;
  captures: any[];
  net: any[];
  jsTrace: any[];
  console: any[];
  targets: any[];
  final: Record<string, any>;
  proxy: any;
  teardown: Record<string, any>;
  preSealDataLayer?: string;
}

export function runSealedReplay(opts: RunSealedReplayOptions): Promise<SealedRun>;
export function killChromeTree(pid: number, profile?: string): Promise<Record<string, any>>;
export function sealedLaunchArgs(proxyPort: number, extra?: string[]): string[];
export const SCENARIOS: Record<string, ReplayScenarioDef>;
export const SETS: Record<string, string[]>;
export const SEAL_PROBES: string;
export const WRAP_CODE: string;
export const READY_EXPR: string;
export const DESKTOP_UA: string;
export const DESKTOP_META: unknown;
export const DEFAULT_CHROME: string;
