/**
 * value-health report command (read-only).
 *
 *   npm run value-health -- --from-json ./outbox.jsonl
 *       an export of outbox records (JSON array or JSONL)
 *   STORE_BACKEND=firestore FIRESTORE_PROJECT_ID=<project> FIRESTORE_DATABASE=conversion-service npm run value-health
 *       reads the outbox of the last --window-days (default 14) from Firestore
 *
 * Options: --window-days N, --now <RFC 3339>, --statuses sent,validated,dry_run, --fail-on-threshold
 * (exit 1 when Meta has purchases but misses a value-optimisation threshold; for a scheduled check).
 * Prints the JSON report on stdout.
 */

import { readFileSync } from 'node:fs';
import { FIRESTORE_SCOPE, FirestoreDocumentStore } from '../src/adapters/firestore-document-store.js';
import { googleAccessTokenProvider } from '../src/live.js';
import { OUTBOX_COLLECTION } from '../src/outbox/outbox.js';
import { parseValueHealthArgs, valueHealth } from '../src/reports/value-health.js';
import type { OutboxRecord } from '../src/types.js';
import { loadStorageConfig } from '../src/wiring.js';

function readRecords(path: string): OutboxRecord[] {
  const text = readFileSync(path, 'utf8').trim();
  if (text.startsWith('[')) return JSON.parse(text) as OutboxRecord[];
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as OutboxRecord);
}

async function run(): Promise<void> {
  const args = parseValueHealthArgs(process.argv.slice(2));
  const nowMs = args.nowMs ?? Date.now();
  const windowDays = args.windowDays ?? 14;
  let records: OutboxRecord[];
  if (args.fromJson) {
    records = readRecords(args.fromJson);
  } else {
    const storage = loadStorageConfig(process.env);
    if (!storage.firestore) throw new Error('set STORE_BACKEND=firestore and FIRESTORE_PROJECT_ID, or pass --from-json <file>');
    const store = new FirestoreDocumentStore({ ...storage.firestore, fetch: globalThis.fetch, accessToken: await googleAccessTokenProvider([FIRESTORE_SCOPE]) });
    const since = nowMs - windowDays * 86_400_000;
    records = (await store.query<OutboxRecord>(OUTBOX_COLLECTION, [{ field: 'occurred_at_ms', op: '>=', value: since }])).map((d) => d.data);
  }
  const report = valueHealth(records, {
    nowMs,
    windowDays,
    reportingCurrency: process.env.REPORTING_CURRENCY ?? 'USD',
    ...(args.statuses ? { statuses: args.statuses } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const meta = report.platforms.find((p) => p.platform === 'meta');
  if (args.failOnThreshold && meta && meta.conversions > 0 && !meta.meta_thresholds.ok) process.exitCode = 1;
}

run().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(2);
});
