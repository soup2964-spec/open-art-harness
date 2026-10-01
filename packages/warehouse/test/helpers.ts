import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WAREHOUSE = fileURLToPath(new URL('..', import.meta.url));
export const EXPORT_DIR = join(WAREHOUSE, 'target', 'contract_export');
export const CONTRACTS_FIXTURES = join(WAREHOUSE, '..', 'contracts', 'fixtures');

export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes). */
export function readCsv(path: string): Array<Record<string, string>> {
  const text = readFileSync(path, 'utf8');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header!.map((h, i) => [h, cells[i] ?? ''])));
}

/**
 * The export is produced by scripts/export_contract_rows.py after `dbt build`. Without it the
 * suite is skipped (so `npm test` at the repo root still runs for people who never built the
 * warehouse); scripts/build.sh sets WAREHOUSE_REQUIRE_EXPORT=1, which turns a missing export
 * into a failure instead.
 */
export function exportAvailable(): boolean {
  const ok = existsSync(join(EXPORT_DIR, 'MANIFEST.json'));
  if (!ok && process.env.WAREHOUSE_REQUIRE_EXPORT === '1') {
    throw new Error(`${EXPORT_DIR} missing: run packages/warehouse/scripts/build.sh`);
  }
  return ok;
}
