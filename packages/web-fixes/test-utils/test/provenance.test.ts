import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every test fixture is either a verbatim capture or a verbatim extract of one. fixtures-provenance.json
 * records where each came from; this test keeps the record honest.
 *
 * `source` paths are relative to the research workspace `openart_2026-09-29/` (the evidence-path
 * convention of docs/integration-map.md): no absolute path and no user name is recorded. Source
 * hashes are checked when the workspace is present: set OPENART_RESEARCH_DIR to its folder, or keep
 * it at `openart_2026-09-29/` next to (or inside) the repository.
 */
interface Provenance {
  fixture: string;
  source: string;
  sourceSha256: string;
  fixtureSha256: string;
  extraction: string;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO = resolve(ROOT, '../..');
const WORKSPACE = 'openart_2026-09-29';
const RESEARCH_DIR =
  process.env.OPENART_RESEARCH_DIR ??
  [join(REPO, WORKSPACE), join(REPO, '..', WORKSPACE), join(REPO, '..', 'test', WORKSPACE)].find((dir) => existsSync(dir));
const PROVENANCE = JSON.parse(readFileSync(`${ROOT}fixtures-provenance.json`, 'utf8')) as Provenance[];
const FIXTURE_DIRS = ['app-patches/test/fixtures', 'gtm/test/fixtures', 'shim/test/fixtures', 'hubspot/test/fixtures'];
const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
/** A source entry may name several captures ("a + b") with one hash each ("h1 / h2"). */
const sourcesOf = (p: Provenance): Array<{ path: string; sha256: string }> => {
  const paths = p.source.split(' + ');
  const hashes = p.sourceSha256.split(' / ');
  return paths.map((path, i) => ({ path, sha256: hashes[i] ?? '' }));
};

describe('fixtures-provenance.json', () => {
  it('lists every fixture file exactly once', () => {
    const onDisk = FIXTURE_DIRS.flatMap((d) => readdirSync(`${ROOT}${d}`).map((n) => `${d}/${n}`)).sort();
    const listed = PROVENANCE.map((p) => p.fixture).sort();
    expect(listed).toEqual(onDisk);
  });

  it('records relative research-workspace paths only: no absolute path, no home directory, no user name (review finding)', () => {
    const raw = readFileSync(`${ROOT}fixtures-provenance.json`, 'utf8');
    expect(raw).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\\\|~\//);
    if (process.env.USER) expect(raw).not.toContain(process.env.USER);
    for (const p of PROVENANCE) {
      for (const { path, sha256: hash } of sourcesOf(p)) {
        expect(path.startsWith(`${WORKSPACE}/`), path).toBe(true);
        expect(path.split('/'), path).not.toContain('..');
        expect(hash, path).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('fixture hashes match the files in this package', () => {
    for (const p of PROVENANCE) expect(sha256(readFileSync(`${ROOT}${p.fixture}`)), p.fixture).toBe(p.fixtureSha256);
  });

  it('source hashes match the research captures (checked when the research workspace is present)', () => {
    const inWorkspace = (path: string) => (RESEARCH_DIR ? join(RESEARCH_DIR, path.slice(WORKSPACE.length + 1)) : null);
    for (const p of PROVENANCE) {
      for (const { path, sha256: hash } of sourcesOf(p)) {
        const file = inWorkspace(path);
        if (file && existsSync(file)) expect(sha256(readFileSync(file)), path).toBe(hash);
      }
    }
    // Whole-file fixtures are byte-identical to their source.
    for (const p of PROVENANCE.filter((x) => x.extraction.startsWith('whole file'))) expect(p.fixtureSha256, p.fixture).toBe(p.sourceSha256);
  });
});
