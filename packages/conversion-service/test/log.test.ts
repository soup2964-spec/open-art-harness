import { describe, expect, it } from 'vitest';
import { MemoryLogger, jsonLogger } from '../src/log.js';

describe('log scrubbing', () => {
  it('redacts sensitive keys at any depth, inside arrays too', () => {
    const lines: string[] = [];
    const log = jsonLogger((line) => lines.push(line));
    log.error('outbox.dead_letter', {
      key: 'meta:SEND:purchase_in_1',
      request: { headers: { Authorization: 'Bearer secret-token' }, user: { email: 'someone@example.test', client_ip_address: '203.0.113.9' } },
      attempts: [{ access_token: 'EAAB-token' }, { note: 'ok' }],
    });
    const entry = JSON.parse(lines[0]!);
    expect(entry.request.headers.Authorization).toBe('[redacted]');
    expect(entry.request.user).toEqual({ email: '[redacted]', client_ip_address: '[redacted]' });
    expect(entry.attempts).toEqual([{ access_token: '[redacted]' }, { note: 'ok' }]);
    expect(lines[0]).not.toMatch(/secret-token|someone@example|203\.0\.113\.9|EAAB-token/);
    expect(entry.key).toBe('meta:SEND:purchase_in_1');
  });

  it('survives cycles and very deep objects without throwing', () => {
    const log = new MemoryLogger();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { token: 'x' };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(() => log.info('m', { cyclic, deep })).not.toThrow();
    expect(JSON.stringify(log.entries[0]!.fields)).not.toContain('"token":"x"');
  });
});
