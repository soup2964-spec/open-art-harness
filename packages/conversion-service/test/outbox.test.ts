import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { backoffMs } from '../src/outbox/outbox.js';
import { DryRunTransport, LiveTransport, RoutingTransport } from '../src/outbox/transport.js';
import type { PlatformRequest } from '../src/platforms/types.js';
import { CASH_14, enrichedFrom, testConfig } from './helpers/enriched.js';
import { goldenLedgerRows } from './helpers/fixtures.js';
import { ScriptedTransport, outboxHarness as harness } from './helpers/outbox-harness.js';

const golden = goldenLedgerRows();
const g = (id: string): ConversionLedgerEvent => structuredClone(golden.find((r) => r.event_id === id)!);

const renewalEvent = () => enrichedFrom(g('purchase_in_1SynthU01Inv0002Cycle'), { email: 'synth.u01@example.test', value: CASH_14 });

describe('Outbox idempotency', () => {
  it('dispatching the same canonical event twice queues each (platform, event_id) exactly once', async () => {
    const h = harness();
    await h.dispatcher.dispatch(renewalEvent());
    await h.dispatcher.dispatch(renewalEvent());
    const keys = (await h.outbox.all()).map((r) => r.key).sort();
    expect(keys).toEqual([
      'google_ads:SEND:purchase_in_1SynthU01Inv0002Cycle',
      'linkedin:SEND:purchase_in_1SynthU01Inv0002Cycle',
      'meta:SEND:purchase_in_1SynthU01Inv0002Cycle',
      'microsoft:SEND:purchase_in_1SynthU01Inv0002Cycle',
      'reddit:SEND:purchase_in_1SynthU01Inv0002Cycle',
      'tiktok:SEND:purchase_in_1SynthU01Inv0002Cycle',
      'x:SEND:purchase_in_1SynthU01Inv0002Cycle',
    ]);
    const report = await h.drainer.drain();
    expect(report.dry_run).toBe(5); // linkedin and x do not receive renewals (mapping)
    expect((await h.drainer.drain()).requests).toBe(0);
  });

  it('two drains racing for the same record: only one claims it (optimistic concurrency)', async () => {
    const h = harness();
    await h.dispatcher.dispatch(renewalEvent());
    const [a, b] = await Promise.all([h.drainer.drain(), h.drainer.drain()]);
    expect(a.dry_run + b.dry_run).toBe(5);
    expect((h.transport as ScriptedTransport).requests.length).toBe(5);
  });

  it('backoff is exponential with jitter, floored at the base and capped', () => {
    expect(backoffMs(1, 30_000, 3_600_000, () => 0.5)).toBe(30_000);
    expect(backoffMs(3, 30_000, 3_600_000, () => 0.5)).toBe(60_000);
    expect(backoffMs(20, 30_000, 3_600_000, () => 1)).toBe(3_600_000);
  });
});

describe('Drainer failure handling', () => {
  it('retries retryable failures with backoff, then dead-letters after max attempts', async () => {
    const t = new ScriptedTransport(() => ({ kind: 'retry', status: 503, error: 'HTTP 503' }));
    const config = testConfig({ enabledPlatforms: new Set(['google_ads'] as const), outbox: { ...testConfig().outbox, maxAttempts: 3 } });
    const h = harness({ transport: t, config });
    await h.dispatcher.dispatch(renewalEvent());
    const key = 'google_ads:SEND:purchase_in_1SynthU01Inv0002Cycle';
    expect((await h.drainer.drain()).retried).toBe(1);
    const after1 = (await h.outbox.get(key))!.data;
    expect(after1).toMatchObject({ status: 'pending', attempts: 1, reason: 'retry_scheduled', last_error: 'HTTP 503' });
    expect(after1.next_attempt_at_ms).toBe(h.clock.now() + 30_000);
    h.clock.advance(31_000);
    await h.drainer.drain();
    h.clock.advance(3_600_000);
    const final = await h.drainer.drain();
    expect(final.dead).toBe(1);
    expect((await h.outbox.get(key))!.data).toMatchObject({ status: 'dead', reason: 'retries_exhausted', attempts: 3 });
  });

  it('a rejected multi-event batch is split so only the poison event dies', async () => {
    const t = new ScriptedTransport((req) => {
      const events = (req.body.data as Array<{ event_id: string }>) ?? [];
      return events.some((e) => e.event_id === 'purchase_in_1SynthU01Inv0003Cycle')
        ? { kind: 'fail', status: 400, error: 'HTTP 400: invalid event' }
        : { kind: 'ok', status: 200, dryRun: false };
    });
    const h = harness({ transport: t, config: testConfig({ enabledPlatforms: new Set(['meta'] as const) }), now: '2026-08-03T17:06:00Z' });
    const good = enrichedFrom({ ...g('purchase_in_1SynthU01Inv0002Cycle'), occurred_at: '2026-08-03T17:00:00Z' }, { value: CASH_14 });
    const poison = enrichedFrom(
      { ...g('purchase_in_1SynthU01Inv0002Cycle'), event_id: 'purchase_in_1SynthU01Inv0003Cycle', order_id: 'sub_in_1SynthU01Inv0003Cycle', invoice_id: 'in_1SynthU01Inv0003Cycle', occurred_at: '2026-08-03T17:04:11Z' },
      { value: CASH_14 },
    );
    await h.dispatcher.dispatch(good);
    await h.dispatcher.dispatch(poison);
    const first = await h.drainer.drain();
    expect(first).toMatchObject({ requests: 1, retried: 2 });
    const second = await h.drainer.drain();
    expect(second).toMatchObject({ requests: 2, sent: 1, dead: 1 });
    expect((await h.outbox.get('meta:SEND:purchase_in_1SynthU01Inv0003Cycle'))!.data).toMatchObject({ status: 'dead', reason: 'rejected_by_platform' });
    expect((await h.outbox.get('meta:SEND:purchase_in_1SynthU01Inv0002Cycle'))!.data.status).toBe('sent');
  });

  it('an item that breaks the platform schema is dead-lettered before sending; the rest of the batch goes', async () => {
    const t = new ScriptedTransport(() => ({ kind: 'ok', status: 200, dryRun: true }));
    const h = harness({ transport: t, config: testConfig({ enabledPlatforms: new Set(['meta'] as const) }) });
    await h.dispatcher.dispatch(renewalEvent());
    const other = enrichedFrom({ ...g('purchase_in_1SynthU01Inv0002Cycle'), event_id: 'purchase_in_1SynthU01Inv0009Cycle', order_id: 'sub_in_1SynthU01Inv0009Cycle', invoice_id: 'in_1SynthU01Inv0009Cycle' }, { value: CASH_14 });
    await h.dispatcher.dispatch(other);
    const doc = (await h.outbox.get('meta:SEND:purchase_in_1SynthU01Inv0009Cycle'))!;
    await h.store.replace('outbox', doc.key, { ...doc.data, item: { ...(doc.data.item as object), event_time: 1780506251000 } }, doc.version);
    const report = await h.drainer.drain();
    expect(report).toMatchObject({ dead: 1, dry_run: 1, requests: 1 });
    expect((await h.outbox.get(doc.key))!.data).toMatchObject({ status: 'dead', reason: 'request_schema_invalid' });
    expect(t.requests[0]!.body.data).toHaveLength(1);
  });

  it('re-checks the send-by deadline right before sending (a queued Meta event that turns 8 days old is never sent)', async () => {
    const t = new ScriptedTransport(() => ({ kind: 'retry', status: 500, error: 'HTTP 500' }));
    const h = harness({ transport: t, config: testConfig({ enabledPlatforms: new Set(['meta'] as const) }) });
    await h.dispatcher.dispatch(renewalEvent());
    await h.drainer.drain();
    h.clock.advance(8 * 86_400_000);
    await h.drainer.drain();
    expect((await h.outbox.get('meta:SEND:purchase_in_1SynthU01Inv0002Cycle'))!.data).toMatchObject({ status: 'dead', reason: 'retry_window_exhausted' });
    expect(t.requests).toHaveLength(1);
  });

  it('reclaims records whose lease expired (a crashed drain), never ones still leased', async () => {
    const h = harness({ config: testConfig({ enabledPlatforms: new Set(['google_ads'] as const) }) });
    await h.dispatcher.dispatch(renewalEvent());
    const key = 'google_ads:SEND:purchase_in_1SynthU01Inv0002Cycle';
    const doc = (await h.outbox.get(key))!;
    await h.outbox.transition(doc, 'in_flight', { attempts: 1, lease_until_ms: h.clock.now() + 120_000 });
    expect((await h.drainer.drain()).requests).toBe(0);
    h.clock.advance(121_000);
    expect((await h.drainer.drain()).dry_run).toBe(1);
    expect((await h.outbox.get(key))!.data.attempts).toBe(2);
  });
});

describe('Transports', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dryrun-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dry-run writes the exact request without credentials and reports dryRun', async () => {
    const t = new DryRunTransport(dir, { instanceId: 'rev1-a', newId: () => '01JAAAAAAAAAAAAAAAAAAAAAAA' });
    const req: PlatformRequest = { platform: 'meta', action: 'SEND', method: 'POST', url: 'https://graph.facebook.com/v26.0/843671884361709/events', headers: { 'Content-Type': 'application/json' }, body: { data: [] }, auth: 'meta_access_token', validationOnly: false };
    expect(await t.send(req)).toEqual({ kind: 'ok', status: 200, dryRun: true });
    const files = readdirSync(join(dir, 'requests', 'meta'));
    expect(files).toEqual(['01JAAAAAAAAAAAAAAAAAAAAAAA-rev1-a-SEND.json']);
    const written = JSON.parse(readFileSync(join(dir, 'requests', 'meta', files[0]!), 'utf8'));
    expect(written).toMatchObject({ method: 'POST', url: req.url, body: { data: [] } });
    expect(JSON.stringify(written)).not.toMatch(/access_token=/);
  });

  it('dry-run file names never collide across instances or restarts (instance id + ULID), and written[] is bounded', async () => {
    const req: PlatformRequest = { platform: 'tiktok', action: 'SEND', method: 'POST', url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/', headers: {}, body: { data: [] }, auth: 'tiktok_access_token', validationOnly: false };
    const a = new DryRunTransport(dir);
    const b = new DryRunTransport(dir);
    for (let i = 0; i < 3; i += 1) {
      await a.send(req);
      await b.send(req);
    }
    const files = readdirSync(join(dir, 'requests', 'tiktok'));
    expect(files).toHaveLength(6);
    for (const f of files) expect(f).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}-[A-Za-z0-9_.-]+-SEND\.json$/);
    expect(a.written).toEqual([]); // nothing retained unless asked
    const kept = new DryRunTransport(dir, { retainWritten: 2 });
    for (let i = 0; i < 5; i += 1) await kept.send(req);
    expect(kept.written).toHaveLength(2);
  });

  it('routing sends only LIVE_PLATFORMS through the live transport; the live transport uses the injected fetch', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ events_received: 1, messages: [], fbtrace_id: 'x' }) };
    };
    const live = new LiveTransport(fakeFetch, { apply: async (r) => ({ url: `${r.url}?access_token=REDACTED`, headers: r.headers }) });
    const routing = new RoutingTransport(new DryRunTransport(dir), live, new Set(['meta'] as const));
    const meta: PlatformRequest = { platform: 'meta', action: 'SEND', method: 'POST', url: 'https://graph.facebook.com/v26.0/1/events', headers: {}, body: { data: [] }, auth: 'meta_access_token', validationOnly: false };
    const tiktok: PlatformRequest = { ...meta, platform: 'tiktok', url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/', auth: 'tiktok_access_token' };
    expect(await routing.send(meta)).toMatchObject({ kind: 'ok', dryRun: false });
    expect(await routing.send(tiktok)).toMatchObject({ kind: 'ok', dryRun: true });
    expect(calls).toEqual(['https://graph.facebook.com/v26.0/1/events?access_token=REDACTED']);
  });

  it('live transport: network errors and credential failures are retries (a broken token pauses sending, never dead-letters)', async () => {
    const boom = new LiveTransport(async () => { throw new Error('ECONNRESET'); }, { apply: async (r) => ({ url: r.url, headers: r.headers }) });
    const req: PlatformRequest = { platform: 'reddit', action: 'SEND', method: 'POST', url: 'https://ads-api.reddit.com/x', headers: {}, body: {}, auth: 'reddit_bearer', validationOnly: false };
    expect(await boom.send(req)).toMatchObject({ kind: 'retry' });
    const noAuth = new LiveTransport(async () => { throw new Error('unreachable'); }, { apply: async () => { throw new Error('missing REDDIT_CONVERSION_ACCESS_TOKEN'); } });
    expect(await noAuth.send(req)).toMatchObject({ kind: 'retry', auth: true, error: 'auth: missing REDDIT_CONVERSION_ACCESS_TOKEN' });
    // A Google token refresh failure (google-auth-library throws) is the same credential problem.
    const googleDown = new LiveTransport(async () => { throw new Error('unreachable'); }, { apply: async () => { throw new Error('invalid_grant'); } });
    expect(await googleDown.send({ ...req, platform: 'google_ads', auth: 'google_oauth' })).toMatchObject({ kind: 'retry', auth: true });
    // An HTTP 401 from the platform is a credential retry too.
    const expired = new LiveTransport(async () => ({ status: 401, headers: { get: () => null }, text: async () => '{"error":"expired"}' }), { apply: async (r) => ({ url: r.url, headers: r.headers }) });
    expect(await expired.send(req)).toMatchObject({ kind: 'retry', auth: true, status: 401 });
  });

  it('live transport never follows redirects and sends the JSON body', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const live = new LiveTransport(async (_url, init) => {
      seen.push({ ...init });
      return { status: 200, headers: { get: () => null }, text: async () => '{}' };
    }, { apply: async (r) => ({ url: r.url, headers: r.headers }) });
    await live.send({ platform: 'reddit', action: 'SEND', method: 'POST', url: 'https://ads-api.reddit.com/x', headers: {}, body: { a: 1 }, auth: 'reddit_bearer', validationOnly: false });
    expect(seen[0]).toMatchObject({ method: 'POST', redirect: 'error', body: '{"a":1}' });
  });
});
