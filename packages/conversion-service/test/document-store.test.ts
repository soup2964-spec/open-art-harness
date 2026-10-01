import { describe, expect, it } from 'vitest';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';

describe('InMemoryDocumentStore', () => {
  it('create is create-if-absent (the idempotency primitive)', async () => {
    const s = new InMemoryDocumentStore();
    expect(await s.create('outbox', 'meta:SEND:purchase_in_1', { status: 'pending' })).toBe(true);
    expect(await s.create('outbox', 'meta:SEND:purchase_in_1', { status: 'sent' })).toBe(false);
    expect((await s.get<{ status: string }>('outbox', 'meta:SEND:purchase_in_1'))?.data.status).toBe('pending');
  });

  it('replace enforces optimistic concurrency on the version', async () => {
    const s = new InMemoryDocumentStore();
    await s.create('c', 'k', { n: 1 });
    const doc = (await s.get<{ n: number }>('c', 'k'))!;
    expect(await s.replace('c', 'k', { n: 2 }, doc.version)).toBe(true);
    expect(await s.replace('c', 'k', { n: 3 }, doc.version)).toBe(false);
    expect((await s.get<{ n: number }>('c', 'k'))?.data.n).toBe(2);
  });

  it('returns deep copies so callers cannot mutate stored state by accident', async () => {
    const s = new InMemoryDocumentStore();
    await s.put('c', 'k', { nested: { a: 1 } });
    const doc = (await s.get<{ nested: { a: number } }>('c', 'k'))!;
    doc.data.nested.a = 99;
    expect((await s.get<{ nested: { a: number } }>('c', 'k'))?.data.nested.a).toBe(1);
  });

  it('queries top-level fields with ==, <=, <, in, ordering and limit', async () => {
    const s = new InMemoryDocumentStore();
    await s.put('o', 'a', { status: 'pending', due: 30 });
    await s.put('o', 'b', { status: 'pending', due: 10 });
    await s.put('o', 'c', { status: 'sent', due: 5 });
    await s.put('o', 'd', { status: 'held', due: 20 });
    const due = await s.query<{ status: string; due: number }>(
      'o',
      [
        { field: 'status', op: 'in', value: ['pending', 'held'] },
        { field: 'due', op: '<=', value: 25 },
      ],
      { orderBy: 'due', limit: 10 },
    );
    expect(due.map((d) => d.key)).toEqual(['b', 'd']);
    expect((await s.query('o', [{ field: 'status', op: '==', value: 'pending' }], { orderBy: 'due', limit: 1 })).map((d) => d.key)).toEqual(['b']);
  });

  it('purgeExpired drops documents whose expire_at has passed (the in-memory stand-in for a Firestore TTL policy)', async () => {
    const s = new InMemoryDocumentStore();
    await s.put('outbox', 'old', { expire_at: '2026-01-01T00:00:00Z' });
    await s.put('outbox', 'new', { expire_at: '2027-01-01T00:00:00Z' });
    await s.put('outbox', 'forever', { status: 'x' });
    expect(s.purgeExpired(Date.parse('2026-06-01T00:00:00Z'))).toBe(1);
    expect(s.dump('outbox').map((d) => d.key).sort()).toEqual(['forever', 'new']);
  });

  it('rejects keys that would be illegal in Firestore document ids', async () => {
    const s = new InMemoryDocumentStore();
    await expect(s.put('c', 'a/b', {})).rejects.toThrow(/key/);
    await expect(s.put('c', '', {})).rejects.toThrow(/key/);
  });
});
