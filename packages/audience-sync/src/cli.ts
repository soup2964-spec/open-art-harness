/**
 * Dry-run audience sync. Nothing is ever sent: requests are printed and written to --out.
 *
 *   npx tsx src/cli.ts --demo                                  # fixture cohort, ILLUSTRATIVE CMP consent
 *   npx tsx src/cli.ts --demo --consent today_no_cmp           # OpenArt today: no consent signals
 *   npx tsx src/cli.ts --candidates rows.jsonl --previous snapshot.jsonl --audience-ids audience-ids.json --out out/
 *   npx tsx src/cli.ts --warehouse-rows fct_audience_candidates.jsonl --contacts contacts.jsonl
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DryRunAudienceClient } from './client.js';
import { candidatesFromCohort, loadFixtureCohort, type ConsentScenario } from './cohort-candidates.js';
import { parseAudienceIds, parseAudienceSyncConfig, parseSnapshot, planAudienceSync, renderPlanReport, snapshotRows, type AudienceSyncPlan, type Snapshot } from './plan.js';
import { parseAudienceCandidates, type AudienceCandidateRow } from './types.js';
import { candidatesFromWarehouseRows, type ContactRow } from './warehouse-candidates.js';

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const readJsonl = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);

export async function main(argv: readonly string[], io: { log?: (line: string) => void } = {}): Promise<AudienceSyncPlan> {
  const log = io.log ?? ((line: string) => console.log(line));
  const config = parseAudienceSyncConfig(JSON.parse(readFileSync(argValue(argv, '--config') ?? fileURLToPath(new URL('../fixtures/audience.config.json', import.meta.url)), 'utf8')));
  let candidates: AudienceCandidateRow[];
  let computedAt = argValue(argv, '--computed-at');
  if (argv.includes('--demo')) {
    const consent = (argValue(argv, '--consent') ?? 'illustrative_cmp') as ConsentScenario;
    if (consent !== 'illustrative_cmp' && consent !== 'today_no_cmp') throw new Error('--consent must be illustrative_cmp or today_no_cmp');
    const cohort = loadFixtureCohort();
    computedAt ??= cohort.simulationEnd;
    candidates = parseAudienceCandidates(candidatesFromCohort(cohort, { consent, computedAt }));
    log(
      consent === 'illustrative_cmp'
        ? 'ILLUSTRATIVE: synthetic cohort, realized profit to date as the score, and ASSUMED CMP consent rates. OpenArt has no CMP today; run with --consent today_no_cmp to see that nothing is uploadable.'
        : 'OpenArt today: no consent signals are recorded, so no user passes the consent gate.',
    );
  } else if (argValue(argv, '--warehouse-rows')) {
    // Today's packages/warehouse mart: one row per (user, list), contacts from a restricted table.
    const contactsPath = argValue(argv, '--contacts');
    const contacts = contactsPath ? (readJsonl(contactsPath) as ContactRow[]) : [];
    const adapted = candidatesFromWarehouseRows(readJsonl(argValue(argv, '--warehouse-rows')!), contacts);
    for (const w of adapted.warnings) log(`Note: ${w}`);
    candidates = adapted.candidates;
    computedAt ??= new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  } else {
    const path = argValue(argv, '--candidates');
    if (!path) throw new Error('pass --candidates <user-grain candidates.jsonl>, --warehouse-rows <fct_audience_candidates.jsonl> [--contacts <contacts.jsonl>] or --demo');
    candidates = parseAudienceCandidates(readJsonl(path));
    computedAt ??= new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const previousPath = argValue(argv, '--previous');
  const previous: Snapshot = previousPath ? parseSnapshot(readJsonl(previousPath)) : new Map();
  // The previous run's audience ids (a deleted TikTok audience is null there, even if the config still names it).
  const idsPath = argValue(argv, '--audience-ids');
  const audienceIds = idsPath ? parseAudienceIds(JSON.parse(readFileSync(idsPath, 'utf8'))) : undefined;

  const plan = planAudienceSync({ candidates, previous, config, computedAt, ...(audienceIds ? { audienceIds } : {}) });
  log(renderPlanReport(plan));
  const client = new DryRunAudienceClient(log);
  for (const r of plan.requests) await client.submit(r);

  const out = argValue(argv, '--out');
  if (out) {
    mkdirSync(out, { recursive: true });
    const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    writeFileSync(join(out, `plan-${plan.runId}.md`), renderPlanReport(plan));
    writeFileSync(join(out, `requests-${plan.runId}.json`), `${JSON.stringify(plan.requests, null, 2)}\n`);
    writeFileSync(join(out, `changes-${plan.runId}.jsonl`), jsonl(plan.changes));
    // Persist these as the next --previous / --audience-ids only after every request has succeeded.
    writeFileSync(join(out, `snapshot-${plan.runId}.jsonl`), jsonl(snapshotRows(plan.nextSnapshot)));
    writeFileSync(join(out, `audience-ids-${plan.runId}.json`), `${JSON.stringify(plan.nextAudienceIds, null, 2)}\n`);
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
