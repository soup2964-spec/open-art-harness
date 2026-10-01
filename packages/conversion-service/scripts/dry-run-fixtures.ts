/**
 * Replays every contracts fixture through the service exactly like the e2e test (real HTTP
 * server on 127.0.0.1, signed Stripe webhooks, HMAC-signed /events, dry-run transport) and
 * copies the resulting request files to an output directory for inspection.
 *
 *   npm run dry-run:fixtures -- ./dry-run-out
 *
 * Network is disabled for the whole process: global fetch throws.
 */

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startHarness, timeline } from '../test/e2e/harness.js';

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in dry-run script (attempted ${String(input)})`);
}) as typeof fetch;

async function run(): Promise<void> {
  const out = resolve(process.argv[2] ?? 'dry-run-out');
  const h = await startHarness({}, '2026-06-01T00:00:00Z');
  h.config.google.multiSourceConfirmed = true;
  h.config.google.adjustments = 'data_manager_restatement';
  h.config.microsoft.adjustments = 'online_conversion_adjustments';
  for (const d of timeline()) {
    // Cloud Scheduler drains between deliveries (held sends waiting for their purchase-time value, expiring holds).
    await h.advanceTo(d.at);
    h.clock.set(d.at);
    const res = d.kind === 'stripe' ? await h.postStripe(JSON.stringify(d.event)) : await h.postEvents(d.body);
    if (res.status !== 200) throw new Error(`${d.label}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  await h.advanceTo(Date.parse('2026-09-25T00:05:00Z'));
  mkdirSync(out, { recursive: true });
  cpSync(join(h.outDir, 'requests'), join(out, 'requests'), { recursive: true });
  const decisions = (await h.app.outbox.all()).map((r) => `${r.key} -> ${r.status}${r.reason ? ` (${r.reason})` : ''}`).sort();
  writeFileSync(join(out, 'outbox-decisions.txt'), `${decisions.join('\n')}\n`);
  writeFileSync(join(out, 'ledger.jsonl'), `${h.ledger.all().map((r) => JSON.stringify(r)).join('\n')}\n`);
  await h.close();
  process.stdout.write(`wrote ${h.transport.written.length} dry-run requests to ${join(out, 'requests')}\n`);
}

run().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
