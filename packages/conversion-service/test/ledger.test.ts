import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import { BigQueryLedger, FileLedger, InMemoryLedger, fromBigQueryRow, toBigQueryRow } from '../src/adapters/ledger.js';
import { FakeBigQuery } from './helpers/fake-bigquery.js';
import { goldenLedgerRows } from './helpers/fixtures.js';

const golden = goldenLedgerRows();
const purchaseFirst = golden.find((r) => r.event_name === 'purchase_first')!;
const renewal = golden.find((r) => r.event_name === 'purchase_renewal')!;

describe('InMemoryLedger', () => {
  it('is first-write-wins per event_id and reports duplicates', async () => {
    const l = new InMemoryLedger();
    expect(await l.write([purchaseFirst])).toEqual({ written: [purchaseFirst.event_id], duplicates: [] });
    const altered = { ...purchaseFirst, cash_value_minor: 1 };
    expect(await l.write([altered])).toEqual({ written: [], duplicates: [purchaseFirst.event_id] });
    expect((await l.get(purchaseFirst.event_id))?.cash_value_minor).toBe(1400);
  });

  it('answers "did this user purchase before?" strictly before a time, excluding the event itself', async () => {
    const l = new InMemoryLedger();
    await l.write([purchaseFirst, renewal]);
    const uid = purchaseFirst.user_id!;
    expect(await l.hasPurchaseBefore(uid, Date.parse(purchaseFirst.occurred_at), 'x')).toBe(false);
    expect(await l.hasPurchaseBefore(uid, Date.parse(renewal.occurred_at), renewal.event_id)).toBe(true);
    // Excluding the first purchase, only the renewal remains, and it is not strictly before itself.
    expect(await l.hasPurchaseBefore(uid, Date.parse(renewal.occurred_at), purchaseFirst.event_id)).toBe(false);
    expect(await l.hasPurchaseBefore('someone-else', Date.parse(renewal.occurred_at) + 1, 'x')).toBe(false);
  });
});

describe('ledger erasure (local ledgers)', () => {
  it('in-memory ledger deletes every row of the user', async () => {
    const l = new InMemoryLedger();
    await l.write(golden);
    expect(await l.eraseUser('SynthU01StarterMonA1')).toBe('deleted');
    expect(l.all().some((r) => r.user_id === 'SynthU01StarterMonA1')).toBe(false);
    expect(l.all().length).toBeGreaterThan(0);
  });
});

describe('FileLedger', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends JSONL, survives a restart, and stays first-write-wins', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const a = new FileLedger(path);
    await a.write([purchaseFirst, renewal]);
    const b = new FileLedger(path);
    expect(await b.write([purchaseFirst])).toEqual({ written: [], duplicates: [purchaseFirst.event_id] });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as ConversionLedgerEvent).event_id)).toEqual([purchaseFirst.event_id, renewal.event_id]);
    expect(await b.get(renewal.event_id)).toEqual(renewal);
  });

  it('erasure rewrites the file without the user', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const a = new FileLedger(path);
    await a.write(golden);
    expect(await a.eraseUser('SynthU01StarterMonA1')).toBe('deleted');
    expect(readFileSync(path, 'utf8')).not.toContain('SynthU01StarterMonA1');
    expect(new FileLedger(path).all().some((r) => r.user_id === 'SynthU01StarterMonA1')).toBe(false);
  });
});

describe('BigQueryLedger (streaming insert through a fake BigQuery client: no network)', () => {
  it('streams rows with insertId = event_id and JSON-encodes the map columns', async () => {
    const bq = new FakeBigQuery();
    const l = new BigQueryLedger(bq, { projectId: 'oa-proj', dataset: 'conversions', table: 'conversion_ledger' }, () => Date.parse('2026-09-30T00:00:00Z'));
    await l.write([purchaseFirst]);
    expect(bq.inserts).toHaveLength(1);
    const [call] = bq.inserts;
    expect(call).toMatchObject({ dataset: 'conversions', table: 'conversion_ledger' });
    expect(call!.rows[0]!.insertId).toBe(purchaseFirst.event_id);
    const json = call!.rows[0]!.json;
    expect(json.click_ids).toBe(JSON.stringify(purchaseFirst.click_ids));
    expect(json.experiment_arms).toBe(JSON.stringify(purchaseFirst.experiment_arms));
    expect(json.consent).toEqual(purchaseFirst.consent);
    expect(json.ingested_at).toBe('2026-09-30T00:00:00Z');
  });

  it('reads back through a parameterised query (no string-built SQL values)', async () => {
    const bq = new FakeBigQuery();
    bq.queryResults.push([toBigQueryRow(purchaseFirst, '2026-09-30T00:00:00Z')]);
    const l = new BigQueryLedger(bq, { projectId: 'oa-proj', dataset: 'conversions', table: 'conversion_ledger' });
    const row = await l.get(purchaseFirst.event_id);
    expect(row).toEqual(purchaseFirst);
    expect(bq.queries[0]!.sql).toContain('`oa-proj.conversions.conversion_ledger`');
    expect(bq.queries[0]!.sql).toContain('@event_id');
    expect(bq.queries[0]!.sql).not.toContain(purchaseFirst.event_id);
    expect(bq.queries[0]!.params).toMatchObject({ event_id: purchaseFirst.event_id });
  });

  it('get() is partition-bounded on occurred_at (the table is partitioned by DATE(occurred_at)) and names its columns', async () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    const bq = new FakeBigQuery();
    const l = new BigQueryLedger(bq, { projectId: 'oa-proj', dataset: 'conversions', table: 'conversion_ledger' }, () => now);
    await l.get(purchaseFirst.event_id);
    const q = bq.queries[0]!;
    expect(q.sql).not.toMatch(/SELECT \*/);
    expect(q.sql).toContain('occurred_at BETWEEN TIMESTAMP(@from) AND TIMESTAMP(@to)');
    expect(q.params).toEqual({ event_id: purchaseFirst.event_id, from: '2025-08-26T00:00:00Z', to: '2026-10-01T00:00:00Z' });
    await l.get(purchaseFirst.event_id, { fromMs: Date.parse('2026-06-01T00:00:00Z'), toMs: Date.parse('2026-06-05T00:00:00Z') });
    expect(bq.queries[1]!.params).toMatchObject({ from: '2026-06-01T00:00:00Z', to: '2026-06-05T00:00:00Z' });
  });

  it('consent round-trips gpc / opt_out_sale_sharing, and a NULL struct field is dropped (never an invalid null)', () => {
    const withGpc = { ...purchaseFirst, consent: { ...purchaseFirst.consent, gpc: true, opt_out_sale_sharing: false } };
    expect(fromBigQueryRow(toBigQueryRow(withGpc, '2026-09-30T00:00:00Z'))).toEqual(withGpc);
    const bqRow = toBigQueryRow(purchaseFirst, '2026-09-30T00:00:00Z');
    bqRow.consent = { ...(bqRow.consent as object), gpc: null, opt_out_sale_sharing: null };
    expect(fromBigQueryRow(bqRow).consent).toEqual(purchaseFirst.consent);
  });

  it('erasure: queues a request row for the scheduled ledger DELETE (streaming-buffer rows cannot be deleted at once)', async () => {
    const bq = new FakeBigQuery();
    const l = new BigQueryLedger(bq, { projectId: 'oa-proj', dataset: 'conversions', table: 'conversion_ledger' }, () => Date.parse('2026-09-30T00:00:00Z'), { dataset: 'conversions', table: 'erasure_requests' });
    expect(await l.eraseUser('SynthU01StarterMonA1')).toBe('queued');
    expect(bq.inserts[0]).toMatchObject({ dataset: 'conversions', table: 'erasure_requests', rows: [{ json: { user_id: 'SynthU01StarterMonA1', requested_at: '2026-09-30T00:00:00Z' } }] });
    const noTable = new BigQueryLedger(bq, { projectId: 'oa-proj', dataset: 'conversions', table: 'conversion_ledger' });
    expect(await noTable.eraseUser('x')).toBe('not_configured');
  });

  it('round-trips every golden row through the BigQuery row encoding', () => {
    for (const row of golden) expect(fromBigQueryRow(toBigQueryRow(row, '2026-09-30T00:00:00Z'))).toEqual(row);
  });

  it('refuses table identifiers that could inject SQL', () => {
    const bq = new FakeBigQuery();
    expect(() => new BigQueryLedger(bq, { projectId: 'p', dataset: 'd; DROP TABLE x', table: 't' })).toThrow(/identifier/);
  });
});
