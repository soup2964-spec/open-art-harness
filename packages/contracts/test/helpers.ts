import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = join(PKG_ROOT, 'fixtures');

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** Every file under fixtures/<dir> with one of the given extensions (non-recursive). */
export function fixtureFiles(dir: string, extensions: string[]): string[] {
  const full = join(FIXTURES, dir);
  return readdirSync(full)
    .filter((f) => extensions.some((ext) => f.endsWith(ext)))
    .sort()
    .map((f) => join(full, f));
}

/** Records in a .json (object or array) or .jsonl fixture file. */
export function fixtureRecords(path: string): unknown[] {
  if (path.endsWith('.jsonl')) return readJsonl(path);
  const parsed = readJson(path);
  return Array.isArray(parsed) ? parsed : [parsed];
}
