/**
 * Small document-store port used for the webhook inbox, Stripe join state, lead state,
 * parked events and the outbox. Production adapter: Firestore (REST, see
 * firestore-document-store.ts); tests and local runs: InMemoryDocumentStore.
 *
 * Only top-level scalar fields are queryable, which keeps the Firestore mapping trivial
 * and the in-memory semantics identical.
 */

export type Scalar = string | number | boolean | null;

/**
 * Retention: a top-level `expire_at` (RFC 3339 UTC string) marks when a document may be deleted.
 * FirestoreDocumentStore stores it as a Firestore Timestamp so a TTL policy on the field deletes
 * the document (infra/conversion-service/firestore.indexes.json); InMemoryDocumentStore.purgeExpired
 * is the local stand-in.
 */
export const TTL_FIELD = 'expire_at';

export interface StoredDoc<T> {
  key: string;
  data: T;
  /** Monotonic version for optimistic concurrency (Firestore: updateTime). */
  version: number | string;
}

export interface Filter {
  field: string;
  op: '==' | '<' | '<=' | '>' | '>=' | 'in';
  value: Scalar | Scalar[];
}

export interface QueryOptions {
  orderBy?: string;
  limit?: number;
}

export interface DocumentStore {
  get<T>(collection: string, key: string): Promise<StoredDoc<T> | null>;
  /** Create only if absent. Resolves false when the key already exists. */
  create<T>(collection: string, key: string, data: T): Promise<boolean>;
  /** Replace only if the stored version still equals expectedVersion. Resolves false on conflict. */
  replace<T>(collection: string, key: string, data: T, expectedVersion: number | string): Promise<boolean>;
  /** Unconditional upsert. */
  put<T>(collection: string, key: string, data: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  query<T>(collection: string, filters: Filter[], options?: QueryOptions): Promise<StoredDoc<T>[]>;
}

/** Firestore document ids must be non-empty, <=1500 bytes, contain no '/', and not be '.' or '..' or match __.*__. */
export function assertValidKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1500 || key.includes('/') || key === '.' || key === '..' || /^__.*__$/.test(key)) {
    throw new Error(`invalid document key: ${JSON.stringify(key)}`);
  }
}

function matches(value: unknown, filter: Filter): boolean {
  switch (filter.op) {
    case '==':
      return value === filter.value;
    case '<':
      return typeof value === 'number' && typeof filter.value === 'number' && value < filter.value;
    case '<=':
      return typeof value === 'number' && typeof filter.value === 'number' && value <= filter.value;
    case '>':
      return typeof value === 'number' && typeof filter.value === 'number' && value > filter.value;
    case '>=':
      return typeof value === 'number' && typeof filter.value === 'number' && value >= filter.value;
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(value as Scalar);
    default: {
      const never: never = filter.op;
      throw new Error(`unsupported op ${String(never)}`);
    }
  }
}

export class InMemoryDocumentStore implements DocumentStore {
  private readonly collections = new Map<string, Map<string, { data: unknown; version: number }>>();
  private clock = 0;

  private col(name: string): Map<string, { data: unknown; version: number }> {
    let c = this.collections.get(name);
    if (!c) {
      c = new Map();
      this.collections.set(name, c);
    }
    return c;
  }

  async get<T>(collection: string, key: string): Promise<StoredDoc<T> | null> {
    assertValidKey(key);
    const hit = this.col(collection).get(key);
    return hit ? { key, data: structuredClone(hit.data) as T, version: hit.version } : null;
  }

  async create<T>(collection: string, key: string, data: T): Promise<boolean> {
    assertValidKey(key);
    const c = this.col(collection);
    if (c.has(key)) return false;
    c.set(key, { data: structuredClone(data), version: ++this.clock });
    return true;
  }

  async replace<T>(collection: string, key: string, data: T, expectedVersion: number | string): Promise<boolean> {
    assertValidKey(key);
    const c = this.col(collection);
    const hit = c.get(key);
    if (!hit || hit.version !== expectedVersion) return false;
    c.set(key, { data: structuredClone(data), version: ++this.clock });
    return true;
  }

  async put<T>(collection: string, key: string, data: T): Promise<void> {
    assertValidKey(key);
    this.col(collection).set(key, { data: structuredClone(data), version: ++this.clock });
  }

  async delete(collection: string, key: string): Promise<void> {
    assertValidKey(key);
    this.col(collection).delete(key);
  }

  async query<T>(collection: string, filters: Filter[], options: QueryOptions = {}): Promise<StoredDoc<T>[]> {
    const out: StoredDoc<T>[] = [];
    for (const [key, hit] of this.col(collection)) {
      const data = hit.data as Record<string, unknown>;
      if (filters.every((f) => matches(data[f.field], f))) {
        out.push({ key, data: structuredClone(hit.data) as T, version: hit.version });
      }
    }
    if (options.orderBy) {
      const field = options.orderBy;
      out.sort((a, b) => {
        const av = (a.data as Record<string, unknown>)[field] as number | string;
        const bv = (b.data as Record<string, unknown>)[field] as number | string;
        if (av === bv) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        return av < bv ? -1 : 1;
      });
    } else {
      out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    return options.limit !== undefined ? out.slice(0, options.limit) : out;
  }

  /** Local stand-in for a Firestore TTL policy: deletes documents whose expire_at is at or before nowMs. */
  purgeExpired(nowMs: number): number {
    let removed = 0;
    for (const c of this.collections.values()) {
      for (const [key, hit] of c) {
        const at = (hit.data as Record<string, unknown> | null)?.[TTL_FIELD];
        if (typeof at === 'string' && Date.parse(at) <= nowMs) {
          c.delete(key);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** Test helper: every document in a collection. */
  dump<T>(collection: string): Array<{ key: string; data: T }> {
    return [...this.col(collection).entries()].map(([key, v]) => ({ key, data: structuredClone(v.data) as T }));
  }
}
