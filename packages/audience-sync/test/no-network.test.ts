import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

const take = () => (globalThis as unknown as { __takeNetworkAttempts: () => string[] }).__takeNetworkAttempts();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('zero network calls', () => {
  it('the guard blocks and records network attempts', async () => {
    await expect(fetch('https://datamanager.googleapis.com/v1/audienceMembers:ingest', { method: 'POST' })).rejects.toThrow(/network access is disabled/);
    expect(() => https.request('https://graph.facebook.com/v25.0/1/users')).toThrow(/network access is disabled/);
    expect(take().length).toBe(2);
  });

  it('the package contains no sender: no fetch, http(s), sockets or SDK clients in src/', () => {
    const offenders = sourceFiles(fileURLToPath(new URL('../src/', import.meta.url))).filter((f) =>
      /\bfetch\s*\(|node:https?['"]|node:net['"]|node:tls['"]|undici|axios|google-ads-api|facebook-nodejs-business-sdk/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the end-to-end dry run (fixture cohort -> plan -> printed requests) makes no network attempt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = mkdtempSync(join(tmpdir(), 'audience-sync-'));
    const lines: string[] = [];
    const plan = await main(['--demo', '--out', out], { log: (l) => lines.push(l) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(plan.requests.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/DRY RUN: this google_ads request was NOT sent/);
    const files = readdirSync(out).sort();
    expect(files).toEqual([`audience-ids-${plan.runId}.json`, `changes-${plan.runId}.jsonl`, `plan-${plan.runId}.md`, `requests-${plan.runId}.json`, `snapshot-${plan.runId}.jsonl`]);
  });
});

describe('finding 10: dry-run outputs (hashes, uids, values) are git-ignored at package level', () => {
  it('ignores out/, snapshot directories and every CLI output file name', () => {
    const rules = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    for (const rule of ['out/', 'snapshots/', 'snapshot*/', 'plan-*.md', 'requests-*.json', 'changes-*.jsonl', 'snapshot-*.jsonl', 'audience-ids-*.json']) expect(rules).toContain(rule);
    // The committed test fixtures must stay tracked.
    for (const rule of rules) expect(rule.includes('fixtures')).toBe(false);
  });
});
