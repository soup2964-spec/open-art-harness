/**
 * Firestore (Native mode) DocumentStore over the REST API v1, so no extra dependency is
 * needed: an access token comes from google-auth-library in live wiring, requests go through
 * an injected fetch. Reference: https://cloud.google.com/firestore/docs/reference/rest/v1
 *
 *   get      GET    …/documents/{collection}/{key}
 *   create   POST   …/documents/{collection}?documentId={key}          (409 ALREADY_EXISTS -> false)
 *   replace  PATCH  …/documents/{collection}/{key}?currentDocument.updateTime={version}
 *   put      PATCH  …/documents/{collection}/{key}                      (creates or replaces)
 *   delete   DELETE …/documents/{collection}/{key}
 *   query    POST   …/documents:runQuery  structuredQuery {from, where, orderBy, limit}
 *
 * Encoding: the whole value is one `__json` string field (exact round trip, no type
 * surprises), plus every top-level scalar mirrored as a typed field so it can be filtered and
 * ordered. `expire_at` is mirrored as a Timestamp, the only type a Firestore TTL policy acts on.
 * GET and DELETE are sent without a body (Node 22's fetch rejects a GET body) and no request
 * follows a redirect. Queries on (status, next_attempt_at_ms) and (status, lease_until_ms) need the
 * composite indexes in infra/conversion-service/firestore.indexes.json.
 */

import type { FetchInit, FetchLike } from '../outbox/transport.js';
import { BODYLESS_METHODS } from '../outbox/transport.js';
import { TTL_FIELD, assertValidKey } from './document-store.js';
import type { DocumentStore, Filter, QueryOptions, Scalar, StoredDoc } from './document-store.js';

export const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values: FsValue[] } };

export function toFsValue(v: Scalar): FsValue {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

function encode(data: unknown): Record<string, FsValue> {
  const fields: Record<string, FsValue> = { __json: { stringValue: JSON.stringify(data) } };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (k === '__json') continue;
      if (k === TTL_FIELD && typeof v === 'string' && /Z$/.test(v) && Number.isFinite(Date.parse(v))) {
        fields[k] = { timestampValue: v };
        continue;
      }
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) fields[k] = toFsValue(v);
    }
  }
  return fields;
}

const OPS: Record<Filter['op'], string> = {
  '==': 'EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  in: 'IN',
};

export interface FirestoreOptions {
  projectId: string;
  databaseId?: string;
  /** Prefix for collection ids, so the service can share a database safely. */
  collectionPrefix?: string;
  fetch: FetchLike;
  accessToken: () => Promise<string>;
  timeoutMs?: number;
}

interface FsDocument {
  name: string;
  fields?: Record<string, FsValue>;
  updateTime?: string;
}

export class FirestoreDocumentStore implements DocumentStore {
  private readonly root: string;
  private readonly prefix: string;

  constructor(private readonly opts: FirestoreOptions) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(opts.projectId)) throw new Error(`invalid GCP project id: ${opts.projectId}`);
    const db = opts.databaseId ?? '(default)';
    if (!/^(\(default\)|[a-z][a-z0-9-]{2,62})$/.test(db)) throw new Error(`invalid Firestore database id: ${db}`);
    this.root = `https://firestore.googleapis.com/v1/projects/${opts.projectId}/databases/${encodeURIComponent(db)}/documents`;
    this.prefix = opts.collectionPrefix ?? 'conversion_service_';
  }

  private collection(name: string): string {
    const c = `${this.prefix}${name}`;
    if (!/^[A-Za-z0-9_]{1,100}$/.test(c)) throw new Error(`invalid collection id: ${c}`);
    return c;
  }

  private docPath(collection: string, key: string): string {
    assertValidKey(key);
    return `${this.root}/${this.collection(collection)}/${encodeURIComponent(key)}`;
  }

  private async call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const token = await this.opts.accessToken();
    const init: FetchInit = {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      redirect: 'error',
    };
    if (body !== undefined && !BODYLESS_METHODS.has(method)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.opts.fetch(url, init);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  private static fail(op: string, res: { status: number; json: any }): never {
    const status = res.json?.error?.status ?? '';
    throw new Error(`firestore ${op} failed: HTTP ${res.status} ${status}`.trim());
  }

  private static decode<T>(key: string, doc: FsDocument): StoredDoc<T> {
    const raw = doc.fields?.__json;
    if (!raw || !('stringValue' in raw)) throw new Error(`firestore document ${key} has no __json field`);
    return { key, data: JSON.parse(raw.stringValue) as T, version: doc.updateTime ?? '' };
  }

  async get<T>(collection: string, key: string): Promise<StoredDoc<T> | null> {
    const res = await this.call('GET', this.docPath(collection, key));
    if (res.status === 404) return null;
    if (res.status !== 200) FirestoreDocumentStore.fail('get', res);
    return FirestoreDocumentStore.decode<T>(key, res.json as FsDocument);
  }

  async create<T>(collection: string, key: string, data: T): Promise<boolean> {
    assertValidKey(key);
    const url = `${this.root}/${this.collection(collection)}?documentId=${encodeURIComponent(key)}`;
    const res = await this.call('POST', url, { fields: encode(data) });
    if (res.status === 409) return false;
    if (res.status !== 200) FirestoreDocumentStore.fail('create', res);
    return true;
  }

  async replace<T>(collection: string, key: string, data: T, expectedVersion: number | string): Promise<boolean> {
    const url = `${this.docPath(collection, key)}?currentDocument.updateTime=${encodeURIComponent(String(expectedVersion))}`;
    const res = await this.call('PATCH', url, { fields: encode(data) });
    if (res.status === 200) return true;
    const status = res.json?.error?.status;
    if (res.status === 404 || status === 'FAILED_PRECONDITION' || status === 'ABORTED' || status === 'NOT_FOUND') return false;
    FirestoreDocumentStore.fail('replace', res);
  }

  async put<T>(collection: string, key: string, data: T): Promise<void> {
    const res = await this.call('PATCH', this.docPath(collection, key), { fields: encode(data) });
    if (res.status !== 200) FirestoreDocumentStore.fail('put', res);
  }

  async delete(collection: string, key: string): Promise<void> {
    const res = await this.call('DELETE', this.docPath(collection, key));
    if (res.status !== 200 && res.status !== 404) FirestoreDocumentStore.fail('delete', res);
  }

  async query<T>(collection: string, filters: Filter[], options: QueryOptions = {}): Promise<StoredDoc<T>[]> {
    const fieldFilters = filters.map((f) => ({
      fieldFilter: {
        field: { fieldPath: f.field },
        op: OPS[f.op],
        value: Array.isArray(f.value) ? { arrayValue: { values: f.value.map(toFsValue) } } : toFsValue(f.value),
      },
    }));
    const structuredQuery: Record<string, unknown> = { from: [{ collectionId: this.collection(collection) }] };
    if (fieldFilters.length === 1) structuredQuery.where = fieldFilters[0];
    if (fieldFilters.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: fieldFilters } };
    if (options.orderBy) structuredQuery.orderBy = [{ field: { fieldPath: options.orderBy }, direction: 'ASCENDING' }];
    if (options.limit !== undefined) structuredQuery.limit = options.limit;
    const res = await this.call('POST', `${this.root}:runQuery`, { structuredQuery });
    if (res.status !== 200) FirestoreDocumentStore.fail('query', res);
    const rows = (Array.isArray(res.json) ? res.json : []) as Array<{ document?: FsDocument }>;
    return rows
      .filter((r): r is { document: FsDocument } => Boolean(r.document))
      .map((r) => FirestoreDocumentStore.decode<T>(decodeURIComponent(r.document.name.split('/').pop() ?? ''), r.document));
  }
}
