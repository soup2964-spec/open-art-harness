// Hermetic regression test for the replay harness (src/legacy/sealed_replay.cjs): the in-page seal
// (SEAL_INIT) must be installed before the replay page's own first script — without Page.enable,
// Page.addScriptToEvaluateOnNewDocument was silently not applied (found in the 2026-09-30 baseline:
// the Google gateway registered a service worker and the full-seal probe created a WebSocket).
// Loopback only; the proxy refuses every other host; nothing leaves the machine.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IGNORED_DEFAULT_ARGS, QUIET_CHROME_FLAGS, SEALED_PROFILE_PREFS } from '../src/browser/harness.js';
import { SEAL_INIT } from '../src/browser/pagejs.js';
import { runSealedReplay } from '../src/legacy/sealed_replay.cjs';

const CHROME = process.env.WATCHDOG_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const received: string[] = [];
let server: http.Server;
let port = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-replay-seal-'));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><script>window.__early = typeof WebSocket.__wdBlocked;
      if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').then(function(){ window.__sw = 'registered'; }, function(e){ window.__sw = e.name; });</script></head><body>x</body></html>`);
  });
  server.on('upgrade', (req, socket) => {
    received.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(CHROME))('replay harness: in-page seal before the first page script (loopback)', () => {
  it('blocks WebSocket and service-worker registration on the replay page, including the full-seal probe', async () => {
    const run = await runSealedReplay({
      runName: 'seal-init', pageUrl: `http://127.0.0.1:${port}/`, setName: 'custom', blockedMode: 'fetchonly', chromePath: CHROME,
      scenarios: { probe: { desc: 'probe', code: "(function(){ return { installed: !!window.__wdSealInstalled, early: window.__early, sw: window.__sw }; })()" } },
      scenarioList: ['probe'], profileDir: path.join(dir, 'profile'), outFile: null, extraArgs: QUIET_CHROME_FLAGS, profilePrefs: SEALED_PROFILE_PREFS, ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      allowConnect: (h: string) => h === '127.0.0.1', scenarioGapMs: 500, tailMs: 500, settleMs: 1000,
      preSeal: { patterns: [{ urlPattern: '*', requestStage: 'Request' }], initScript: SEAL_INIT, handler: async (s: any, e: any) => { await s.send(/sw\.js/.test(e.request.url) ? 'Fetch.failRequest' : 'Fetch.continueRequest', /sw\.js/.test(e.request.url) ? { requestId: e.requestId, errorReason: 'BlockedByClient' } : { requestId: e.requestId }); } },
    });
    const probe = run.timeline[0]!.result as Record<string, unknown>;
    expect(probe).toEqual({ installed: true, early: 'boolean', sw: 'SecurityError' });
    expect(String((run.sealProbes[0]!.result as any).websocket)).toMatch(/^threw WebSocket blocked/);
    expect(run.net.filter((n: any) => /WebSocket/.test(n.type))).toEqual([]);
    expect(run.seal.heldTargets ?? []).toEqual([]);
    expect(run.seal.preSealSessions.find((x: any) => x.label === 'page')).toMatchObject({ fetch: 'enabled', init: 'ok' });
    expect(received.filter((r) => /sw\.js|UPGRADE/.test(r))).toEqual([]);
    expect(run.teardown.profileDeleted ?? !fs.existsSync(path.join(dir, 'profile'))).toBe(true);
  }, 120_000);
});
