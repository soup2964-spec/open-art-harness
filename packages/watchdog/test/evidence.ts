// Location of the saved 2026-09-29 evidence (crawl/sealed_evidence, crawl/teardown2, ...).
// Tests that read the original captures skip cleanly when it is absent (e.g. inside Docker/CI);
// the committed fixtures under test/fixtures/ are derived from it (scripts/build-fixtures.ts).
import fs from 'node:fs';
import path from 'node:path';

export const EVIDENCE_DIR = process.env.OPENART_EVIDENCE_DIR ?? '';
export const hasEvidence = EVIDENCE_DIR !== '' && fs.existsSync(path.join(EVIDENCE_DIR, 'crawl', 'teardown2')) && fs.existsSync(path.join(EVIDENCE_DIR, 'crawl', 'sealed_evidence'));
export const evidencePath = (...p: string[]) => path.join(EVIDENCE_DIR, ...p);
export const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
export const readJson = <T = any>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
