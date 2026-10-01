/**
 * Writes the synthetic cohort to fixtures/cohort/ (or a directory given as argv[2]).
 *   npm run generate:cohort -w @openart-signal/contracts                 # default 2,000 users
 *   npx tsx src/cohort/cli.ts /tmp/cohort 500 my-seed                    # custom dir, size, seed
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cohortFiles, generateCohort } from './generate.js';

const dir = process.argv[2] ?? fileURLToPath(new URL('../../fixtures/cohort/', import.meta.url));
const users = process.argv[3] ? Number(process.argv[3]) : undefined;
const seed = process.argv[4];

const out = generateCohort({ ...(users ? { users } : {}), ...(seed ? { seed } : {}) });
mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(cohortFiles(out))) {
  writeFileSync(join(dir, name), content);
  console.log(`wrote ${join(dir, name)} (${Buffer.byteLength(content)} bytes)`);
}
console.log(JSON.stringify(out.manifest.counts));
