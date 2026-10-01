import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';

/**
 * Resolve a path next to a test file. Uses node:url explicitly because suites that run
 * under happy-dom replace the global URL class.
 */
export function fixturePath(importMetaUrl: string, relative: string): string {
  return fileURLToPath(new NodeURL(relative, importMetaUrl));
}

export function readFixture(importMetaUrl: string, relative: string): string {
  return readFileSync(fixturePath(importMetaUrl, relative), 'utf8');
}
