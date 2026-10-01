/**
 * The Firestore adapter against an in-process fake of the Firestore REST endpoints it uses
 * (no network: the fake is the injected fetch). The same behavioural contract runs against
 * InMemoryDocumentStore, so both stores are interchangeable.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryDocumentStore } from '../src/adapters/document-store.js';
import type { DocumentStore } from '../src/adapters/document-store.js';
import { FirestoreDocumentStore } from '../src/adapters/firestore-document-store.js';
import type { FetchLike } from '../src/outbox/transport.js';

type FsValue = Record<string, any>;

function fromFs(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromFs);
  throw new Error(`unsupported value ${JSON.stringify(v)}`);
}

/** Minimal Firestore REST emulator for the calls the adapter makes. */
class FakeFirestore {
  readonly docs = new Map<string, { fields: Record<string, FsValue>; updateTime: string }>();
  readonly calls: Array<{ method: string; url: string; body: any; auth: string | undefined }> = [];
  readonly requests: Array<{ method: string; hasBody: boolean; redirect: string; init: Record<string, unknown> }> = [];
  private tick = 0;
  private readonly root = 'https://firestore.googleapis.com/v1/projects/oa-proj/databases/(default)/documents';

  private respond(status: number, json: unknown) {
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  }

  private nextTime(): string {
    this.tick += 1;
    return `2026-09-30T00:00:00.${String(this.tick).padStart(6, '0')}Z`;
  }

  readonly fetch: FetchLike = async (url, init) => {
    // Real undici Request semantics (no network): Node 22's fetch throws on a GET/HEAD body,
    // so constructing the Request here fails exactly where production would.
    const real = new Request(url, init);
    this.requests.push({ method: real.method, hasBody: real.body !== null, redirect: real.redirect, init: { ...init } });
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method: init.method, url, body, auth: init.headers.Authorization });
    const u = new URL(url);
    const rootPath = new URL(this.root).pathname.replace('(default)', encodeURIComponent('(default)'));
    const path = decodeURIComponent(u.pathname);
    const rel = path.slice(decodeURIComponent(rootPath).length);
    if (init.method === 'POST' && rel === ':runQuery') return this.respond(200, this.runQuery(body.structuredQuery));
    const [, collection, key] = rel.split('/');
    if (init.method === 'POST') {
      const id = `${collection}/${u.searchParams.get('documentId')}`;
      if (this.docs.has(id)) return this.respond(409, { error: { code: 409, status: 'ALREADY_EXISTS' } });
      const updateTime = this.nextTime();
      this.docs.set(id, { fields: body.fields, updateTime });
      return this.respond(200, { name: `${this.root}/${id}`, fields: body.fields, updateTime });
    }
    const id = `${collection}/${key}`;
    const doc = this.docs.get(id);
    if (init.method === 'GET') return doc ? this.respond(200, { name: `${this.root}/${id}`, ...doc }) : this.respond(404, { error: { status: 'NOT_FOUND' } });
    if (init.method === 'DELETE') {
      this.docs.delete(id);
      return this.respond(200, {});
    }
    if (init.method === 'PATCH') {
      const expected = u.searchParams.get('currentDocument.updateTime');
      if (expected !== null && (!doc || doc.updateTime !== expected)) return this.respond(400, { error: { status: 'FAILED_PRECONDITION' } });
      const updateTime = this.nextTime();
      this.docs.set(id, { fields: body.fields, updateTime });
      return this.respond(200, { name: `${this.root}/${id}`, fields: body.fields, updateTime });
    }
    return this.respond(400, { error: { status: 'INVALID_ARGUMENT' } });
  };

  private runQuery(q: any): unknown[] {
    const collection = q.from[0].collectionId;
    const filters: any[] = q.where?.compositeFilter ? q.where.compositeFilter.filters : q.where ? [q.where] : [];
    const out = [...this.docs.entries()]
      .filter(([id]) => id.startsWith(`${collection}/`))
      .filter(([, d]) =>
        filters.every(({ fieldFilter: f }) => {
          const raw = d.fields[f.field.fieldPath];
          const actual = raw ? fromFs(raw) : undefined;
          const want = fromFs(f.value);
          if (f.op === 'EQUAL') return actual === want;
          if (f.op === 'LESS_THAN') return (actual as number) < (want as number);
          if (f.op === 'LESS_THAN_OR_EQUAL') return (actual as number) <= (want as number);
          if (f.op === 'GREATER_THAN') return (actual as number) > (want as number);
          if (f.op === 'GREATER_THAN_OR_EQUAL') return (actual as number) >= (want as number);
          if (f.op === 'IN') return (want as unknown[]).includes(actual);
          throw new Error(`op ${f.op}`);
        }),
      );
    if (q.orderBy) {
      const field = q.orderBy[0].field.fieldPath;
      out.sort(([ai, a], [bi, b]) => {
        const av = fromFs(a.fields[field]!) as number;
        const bv = fromFs(b.fields[field]!) as number;
        return av === bv ? (ai < bi ? -1 : 1) : av < bv ? -1 : 1;
      });
    }
    const limited = q.limit !== undefined ? out.slice(0, q.limit) : out;
    return [...limited.map(([id, d]) => ({ document: { name: `${this.root}/${id}`, ...d }, readTime: 'x' })), { readTime: 'x' }];
  }
}

function contract(name: string, make: () => DocumentStore) {
  describe(`${name}: DocumentStore contract`, () => {
    it('create-if-absent, get, put, delete', async () => {
      const s = make();
      expect(await s.create('outbox', 'meta:SEND:purchase_in_1', { status: 'pending', n: 1 })).toBe(true);
      expect(await s.create('outbox', 'meta:SEND:purchase_in_1', { status: 'sent', n: 2 })).toBe(false);
      expect((await s.get<{ status: string }>('outbox', 'meta:SEND:purchase_in_1'))?.data).toEqual({ status: 'pending', n: 1 });
      await s.put('outbox', 'meta:SEND:purchase_in_1', { status: 'sent', nested: { a: [1, 2] } });
      expect((await s.get('outbox', 'meta:SEND:purchase_in_1'))?.data).toEqual({ status: 'sent', nested: { a: [1, 2] } });
      await s.delete('outbox', 'meta:SEND:purchase_in_1');
      expect(await s.get('outbox', 'meta:SEND:purchase_in_1')).toBeNull();
    });

    it('replace only wins against the version it read', async () => {
      const s = make();
      await s.create('c', 'k', { n: 1 });
      const v1 = (await s.get<{ n: number }>('c', 'k'))!;
      expect(await s.replace('c', 'k', { n: 2 }, v1.version)).toBe(true);
      expect(await s.replace('c', 'k', { n: 3 }, v1.version)).toBe(false);
      expect((await s.get<{ n: number }>('c', 'k'))?.data.n).toBe(2);
    });

    it('query: lower bounds (> and >=) for time-window reads', async () => {
      const s = make();
      await s.put('o', 'a', { occurred_at_ms: 10 });
      await s.put('o', 'b', { occurred_at_ms: 20 });
      await s.put('o', 'c', { occurred_at_ms: 30 });
      expect((await s.query('o', [{ field: 'occurred_at_ms', op: '>=', value: 20 }], { orderBy: 'occurred_at_ms' })).map((d) => d.key)).toEqual(['b', 'c']);
      expect((await s.query('o', [{ field: 'occurred_at_ms', op: '>', value: 20 }], { orderBy: 'occurred_at_ms' })).map((d) => d.key)).toEqual(['c']);
    });

    it('query: equality + range + IN, ordered and limited', async () => {
      const s = make();
      await s.put('o', 'a', { status: 'pending', due: 30 });
      await s.put('o', 'b', { status: 'pending', due: 10 });
      await s.put('o', 'c', { status: 'sent', due: 5 });
      await s.put('o', 'd', { status: 'held', due: 20.5 });
      const got = await s.query('o', [{ field: 'status', op: 'in', value: ['pending', 'held'] }, { field: 'due', op: '<=', value: 25 }], { orderBy: 'due', limit: 10 });
      expect(got.map((d) => d.key)).toEqual(['b', 'd']);
      expect((await s.query('o', [{ field: 'status', op: '==', value: 'pending' }], { orderBy: 'due', limit: 1 })).map((d) => d.key)).toEqual(['b']);
    });
  });
}

contract('InMemoryDocumentStore', () => new InMemoryDocumentStore());
contract('FirestoreDocumentStore (REST, fake Firestore)', () => {
  const fake = new FakeFirestore();
  return new FirestoreDocumentStore({ projectId: 'oa-proj', collectionPrefix: '', fetch: fake.fetch, accessToken: async () => 'ya29.test-token' });
});

describe('FirestoreDocumentStore request shapes (Firestore REST v1 reference)', () => {
  it('uses documentId for create, currentDocument.updateTime for replace, :runQuery for queries, and a bearer token', async () => {
    const f = new FakeFirestore();
    const s = new FirestoreDocumentStore({ projectId: 'oa-proj', fetch: f.fetch, accessToken: async () => 'ya29.test-token' });
    await s.create('outbox', 'google_ads:SEND:purchase_in_1', { status: 'pending', next_attempt_at_ms: 1790000000000 });
    const doc = (await s.get('outbox', 'google_ads:SEND:purchase_in_1'))!;
    await s.replace('outbox', 'google_ads:SEND:purchase_in_1', { status: 'in_flight' }, doc.version);
    await s.query('outbox', [{ field: 'status', op: '==', value: 'pending' }, { field: 'next_attempt_at_ms', op: '<=', value: 1790000000001 }], { orderBy: 'next_attempt_at_ms', limit: 5 });
    const [create, , replace, query] = f.calls;
    expect(create!.url).toBe('https://firestore.googleapis.com/v1/projects/oa-proj/databases/(default)/documents/conversion_service_outbox?documentId=google_ads%3ASEND%3Apurchase_in_1');
    expect(create!.body.fields).toEqual({
      __json: { stringValue: JSON.stringify({ status: 'pending', next_attempt_at_ms: 1790000000000 }) },
      status: { stringValue: 'pending' },
      next_attempt_at_ms: { integerValue: '1790000000000' },
    });
    expect(replace!.method).toBe('PATCH');
    expect(replace!.url).toContain('?currentDocument.updateTime=');
    expect(query!.url).toBe('https://firestore.googleapis.com/v1/projects/oa-proj/databases/(default)/documents:runQuery');
    expect(query!.body.structuredQuery).toEqual({
      from: [{ collectionId: 'conversion_service_outbox' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } },
            { fieldFilter: { field: { fieldPath: 'next_attempt_at_ms' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: '1790000000001' } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'next_attempt_at_ms' }, direction: 'ASCENDING' }],
      limit: 5,
    });
    expect(f.calls.every((c) => c.auth === 'Bearer ya29.test-token')).toBe(true);
  });

  it('GET and DELETE carry no body (Node 22 fetch throws on a GET body); writes carry JSON; redirects are refused', async () => {
    const f = new FakeFirestore();
    const s = new FirestoreDocumentStore({ projectId: 'oa-proj', fetch: f.fetch, accessToken: async () => 'ya29.test-token' });
    await s.create('outbox', 'k1', { status: 'pending' });
    expect(await s.get('outbox', 'k1')).not.toBeNull();
    expect(await s.get('outbox', 'missing')).toBeNull();
    await s.put('outbox', 'k1', { status: 'sent' });
    await s.delete('outbox', 'k1');
    const byMethod = (m: string) => f.requests.filter((r) => r.method === m);
    expect(byMethod('GET').length).toBe(2);
    for (const r of [...byMethod('GET'), ...byMethod('DELETE')]) {
      expect(r.hasBody).toBe(false);
      expect('body' in r.init).toBe(false);
      expect(r.init.headers).not.toHaveProperty('Content-Type');
    }
    for (const r of [...byMethod('POST'), ...byMethod('PATCH')]) expect(r.hasBody).toBe(true);
    expect(f.requests.every((r) => r.redirect === 'error')).toBe(true);
  });

  it('stores expire_at as a Firestore Timestamp so a TTL policy can delete the document', async () => {
    const f = new FakeFirestore();
    const s = new FirestoreDocumentStore({ projectId: 'oa-proj', fetch: f.fetch, accessToken: async () => 't' });
    await s.put('outbox', 'k', { status: 'sent', expire_at: '2026-11-01T00:00:00Z' });
    const put = f.calls.find((c) => c.method === 'PATCH')!;
    expect(put.body.fields.expire_at).toEqual({ timestampValue: '2026-11-01T00:00:00Z' });
    expect((await s.get<{ expire_at: string }>('outbox', 'k'))?.data.expire_at).toBe('2026-11-01T00:00:00Z');
  });

  it('surfaces unexpected errors instead of swallowing them', async () => {
    const s = new FirestoreDocumentStore({
      projectId: 'oa-proj',
      fetch: async () => ({ status: 503, headers: { get: () => null }, text: async () => JSON.stringify({ error: { status: 'UNAVAILABLE' } }) }),
      accessToken: async () => 't',
    });
    await expect(s.get('c', 'k')).rejects.toThrow(/HTTP 503 UNAVAILABLE/);
    await expect(s.create('c', 'k', {})).rejects.toThrow(/HTTP 503/);
  });

  it('rejects unsafe project and database identifiers', () => {
    expect(() => new FirestoreDocumentStore({ projectId: 'x/../../evil', fetch: async () => { throw new Error('no'); }, accessToken: async () => 't' })).toThrow(/project/);
    expect(() => new FirestoreDocumentStore({ projectId: 'oa-proj', databaseId: '../x', fetch: async () => { throw new Error('no'); }, accessToken: async () => 't' })).toThrow(/database/);
  });
});

