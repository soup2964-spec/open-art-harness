// Batch orchestration must preserve attribution even when vendor requests contain no test ID.
// The browser harness is mocked here; replay-seal.int.test.ts exercises the actual network seal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateContract, loadContract } from '../src/contract.js';
import { syntheticData } from '../src/markers.js';
import { runReplay, type ReplayOptions } from '../src/replay/replay.js';
import type { ReplayScenario } from '../src/replay/scenarios.js';
import type { RunSealedReplayOptions, SealedRun } from '../src/legacy/sealed_replay.cjs';

const harness = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/legacy/sealed_replay.cjs', async (original) => ({
  ...await original<typeof import('../src/legacy/sealed_replay.cjs')>(),
  runSealedReplay: harness.run,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const scenario = (id: string): ReplayScenario => ({ id, desc: id, code: '({pushed:true})', context: {}, source: 'unit test' });
const ready = { hasContainer: true, gtag: 'function', ttqLoaded: true, twqExe: true, lintrk: 'function' };

function capture(scenarioId: string, url: string, t = 10) {
  return { t, iso: new Date(t).toISOString(), scenario: scenarioId, url, method: 'GET', resourceType: 'Image', postData: null, postDataEntriesB64: null, failRequest: 'ok', layer: 'fetch-target', networkId: `network-${t}` };
}

function sealedRun(options: RunSealedReplayOptions, captures: ReturnType<typeof capture>[] = []): SealedRun {
  const id = options.scenarioList![0]!;
  const now = new Date().toISOString();
  return {
    meta: { runName: options.runName, pageUrl: options.pageUrl, outFile: options.outFile, scenarioList: options.scenarioList },
    load: { status: 'load' }, versions: {}, readiness: { ...ready },
    seal: { startedAt: now }, sealProbes: [], wrap: {},
    timeline: [{ scenario: id, desc: id, start: now, end: now, before: {}, result: { pushed: true }, after: {} }],
    captures, net: [], jsTrace: [], console: [], targets: [], final: {},
    proxy: { sealedAt: now, log: [], postSealAttempts: 0, postSealAllowed: 0 },
    teardown: { profileDeleted: true },
  };
}

let dir: string;
beforeEach(() => {
  harness.run.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-batch-test-'));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function options(scenarios: ReplayScenario[]): ReplayOptions {
  return {
    pageUrl: 'https://openart.ai/home', scenarios, data: syntheticData('BATCH'),
    chromePath: '/unused/chrome', profileDir: path.join(dir, 'profiles'), rawDir: dir,
    intercept: { policy: { markers: ['WD_TEST'] }, patches: {}, isPatchHost: () => false },
    allowConnect: () => false, log: () => {},
  };
}

describe('parallel isolated replay', () => {
  it('waits for every sealed worker and preserves delayed marker-free request ownership', async () => {
    const firstArrived = deferred();
    const releaseSecond = deferred();
    const finishFirst = deferred();
    const launches: string[] = [];
    const calls: RunSealedReplayOptions[] = [];
    harness.run.mockImplementation(async (o: RunSealedReplayOptions) => {
      calls.push(o);
      const id = o.scenarioList![0]!;
      if (id === 'first_purchase') await releaseSecond.promise;
      else firstArrived.resolve();
      await o.beforeReplay!();
      launches.push(id);
      // The first worker produces its request after the other worker has finished.
      if (id === 'purchase') await finishFirst.promise;
      else finishFirst.resolve();
      return sealedRun(o, [capture('TAIL', `https://px.ads.linkedin.com/collect/?pid=123&conversionId=29290225&val=${id === 'purchase' ? '56' : '300'}`)]);
    });

    const pending = runReplay(options([scenario('purchase'), scenario('first_purchase')]));
    await firstArrived.promise;
    await Promise.resolve();
    expect(launches).toEqual([]);
    releaseSecond.resolve();
    const batch = await pending;

    expect(launches.sort()).toEqual(['first_purchase', 'purchase']);
    expect(batch.mode).toBe('parallel-isolated');
    expect(batch.runs).toHaveLength(2);
    expect(new Set(calls.map((o) => o.profileDir)).size).toBe(2);
    expect(new Set(calls.map((o) => o.outFile)).size).toBe(2);
    expect(batch.observation.hits.map((h) => ({ step: h.step, value: h.fields.val, eventId: h.fields.eventId }))).toEqual([
      { step: 'purchase', value: '56', eventId: undefined },
      { step: 'first_purchase', value: '300', eventId: undefined },
    ]);
    expect(new Set(batch.observation.requests.map((r) => r.id)).size).toBe(2);
    expect(batch.observation.requests.every((r) => r.action === 'fail')).toBe(true);
  });

  it('keeps the Google signup control and each worker readiness out of other scenario grades', async () => {
    harness.run.mockImplementation(async (o: RunSealedReplayOptions) => {
      await o.beforeReplay!();
      const id = o.scenarioList![0]!;
      const signupHit = 'https://www.googleadservices.com/pagead/conversion/11252321380/?label=rVk2CJ7Ot8EZEOSYw_Up&em=synthetic-hash';
      const run = sealedRun(o, id === 'new_user_signed_up' ? [capture('TAIL', signupHit)]
        : id === 'signup' ? [capture('WRAP', signupHit)] : []);
      if (id === 'purchase') run.readiness.lintrk = 'undefined';
      return run;
    });
    const batch = await runReplay(options([scenario('signup'), scenario('new_user_signed_up'), scenario('purchase')]));
    const checks = Object.fromEntries(evaluateContract(loadContract(), { replay: batch.observation, journeys: [], consentProbes: [] }).map((c) => [c.id, c]));
    expect(checks['signup.google_ads.user_data']!.status).toBe('FAIL');
    expect(checks['signup.google_ads.user_data']!.observed).toMatch(/no Google Ads conversion/);
    expect(checks['purchase.linkedin.value_and_event_id']!.status).toBe('ERROR');
    expect(checks['purchase.linkedin.value_and_event_id']!.observed).toMatch(/not ready/);
  });

  it('keeps scenario-code exceptions as local ERROR results while other scenarios finish', async () => {
    harness.run.mockImplementation(async (o: RunSealedReplayOptions) => {
      await o.beforeReplay!();
      const run = sealedRun(o);
      if (o.scenarioList![0] === 'signup') run.timeline[0]!.result = { __exception: 'ReferenceError: signup failed' };
      return run;
    });
    const batch = await runReplay(options([scenario('signup'), scenario('purchase')]));
    const checks = Object.fromEntries(evaluateContract(loadContract(), { replay: batch.observation, journeys: [], consentProbes: [] }).map((c) => [c.id, c]));
    expect(checks['signup.tiktok.event_id']!.status).toBe('ERROR');
    expect(checks['signup.tiktok.event_id']!.observed).toContain('signup failed');
    expect(checks['purchase.linkedin.value_and_event_id']!.status).toBe('FAIL');
  });

  it.each(['throw', 'returned error'] as const)('releases waiting workers when another worker fails before the barrier: %s', async (failure) => {
    const waiting = deferred();
    let released = false;
    harness.run.mockImplementation(async (o: RunSealedReplayOptions) => {
      if (o.scenarioList![0] === 'broken') {
        await waiting.promise;
        if (failure === 'throw') throw new Error('browser launch failed');
        const run = sealedRun(o);
        run.meta.error = 'browser launch failed';
        return run;
      }
      waiting.resolve();
      try { await o.beforeReplay!(); } finally { released = true; }
      return sealedRun(o);
    });
    await expect(runReplay(options([scenario('waiting'), scenario('broken')]))).rejects.toThrow(/browser launch failed/);
    expect(released).toBe(true);
  }, 2_000);

  it.each([
    { label: 'empty', scenarios: [] },
    { label: 'duplicate IDs', scenarios: [scenario('signup'), scenario('signup')] },
  ])('rejects $label before launching a browser', async ({ scenarios }) => {
    await expect(runReplay(options(scenarios))).rejects.toThrow();
    expect(harness.run).not.toHaveBeenCalled();
  });
});
