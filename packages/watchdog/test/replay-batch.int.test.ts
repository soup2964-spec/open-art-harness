// Actual concurrent Chrome sessions against loopback. The receiver must see no conversions.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticData } from '../src/markers.js';
import { runReplay } from '../src/replay/replay.js';
import { replayEvidence } from '../src/run.js';
import { proveAll } from '../src/observe/leakproof.js';

const CHROME = process.env.WATCHDOG_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const received: string[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-batch-int-'));
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    // Ready stand-ins keep this a local harness test; no third-party SDK is downloaded.
    res.end(`<html><head><script>
      window.google_tag_manager={'GTM-56CMP8K':{}};
      window.ttq={_i:{},identify:function(){},track:function(){}};
      window.twq=function(){}; window.twq.exe=function(){};
      window.rdt=function(){}; window.rdt.sendEvent=function(){};
      window.lintrk=function(){};
      window.dataLayer=[];
    </script></head><body>local replay fixture</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(CHROME))('parallel replay seal (real Chrome, loopback)', () => {
  it('launches together, isolates state and delayed requests, and delivers zero conversions', async () => {
    const batch = await runReplay({
      pageUrl: `http://127.0.0.1:${port}/page`,
      scenarios: ['signup', 'new_user_signed_up', 'purchase', 'first_purchase', 'business_subscription', 'purchase_first'].map((id, index) => ({
        id, desc: id, source: 'loopback fixture', context: {},
        code: `(function(){
          var clean = !window.__otherScenario;
          window.__otherScenario=${JSON.stringify(id)};
          fetch('/collect/immediate', {method:'POST',body:'WD_TEST'}).catch(function(){});
          setTimeout(function(){ navigator.sendBeacon('/collect/delayed', 'WD_TEST'); }, ${200 + index * 400});
          return { clean: clean, firedAt: Date.now() };
        })()`,
      })),
      data: syntheticData('PARALLEL'), chromePath: CHROME,
      profileDir: path.join(dir, 'profile'), rawDir: path.join(dir, 'raw'),
      intercept: {
        policy: { markers: ['WD_TEST'], extraHosts: [/^127\.0\.0\.1$/], extraCollection: [{ id: 'test.collect', platform: 'test', host: /^127\.0\.0\.1$/, path: /^\/collect\// }] },
        patches: {}, isPatchHost: () => false,
      },
      allowConnect: (host) => host === '127.0.0.1', log: () => {},
    });
    expect(batch.startSpreadMs).not.toBeNull();
    expect(batch.startSpreadMs!).toBeLessThan(1000);
    const firedAt = batch.runs.map((r) => Number(r.run.timeline[0]!.result.firedAt));
    expect(Math.max(...firedAt) - Math.min(...firedAt)).toBeLessThan(1000);
    for (const rr of batch.runs) {
      const scenario = rr.observation.scenarios[0]!;
      const timeline = rr.run.timeline[0]!;
      expect(timeline.result.clean).toBe(true);
      expect(Date.parse(timeline.start)).toBeGreaterThanOrEqual(Date.parse(rr.run.seal.proxySealedAt));
      const captures = rr.observation.requests.filter((r) => r.url.includes('/collect/'));
      expect(new Set(captures.map((r) => new URL(r.url).pathname))).toEqual(new Set(['/collect/immediate', '/collect/delayed']));
      expect(captures.every((r) => r.step === scenario.id && r.action === 'fail' && r.failResult === 'ok')).toBe(true);
      expect(rr.run.proxy.postSealAllowed).toBe(0);
      expect(rr.run.teardown.profileDeleted).toBe(true);
      expect(rr.run.teardown.stillAlive).toEqual([]);
    }
    expect(received.filter((r) => r.includes('/collect/'))).toEqual([]);
    const evidence = batch.runs.flatMap((r) => replayEvidence(r, ['WD_TEST'])).map((e) => ({ ...e, extraAllowedHosts: [/^127\.0\.0\.1$/] }));
    expect(new Set(evidence.map((e) => e.id)).size).toBe(evidence.length);
    const proof = proveAll(evidence);
    expect(proof.status, JSON.stringify(proof)).toBe('PROVEN');
    const manifest = JSON.parse(fs.readFileSync(batch.rawFile, 'utf8'));
    expect(manifest.mode).toBe('parallel-isolated');
    expect(manifest.scenarios).toHaveLength(6);
    console.info(`Parallel replay verified: ${Math.max(...firedAt) - Math.min(...firedAt)} ms between scenario triggers; zero conversions received.`);
  }, 120_000);
});
