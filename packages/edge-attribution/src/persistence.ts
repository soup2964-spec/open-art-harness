// Persistence adapters. They run inside ctx.waitUntil and never delay the response.
import { base64urlToBytes, utf8 } from "./core/base64url.js";
import { TTL } from "./core/constants.js";
import type { AttributionRecord } from "./core/model.js";
import { buildAdClickIdsPayload, toClickIdStoreRecordExtended } from "./core/record.js";
import { hmacSign } from "./crypto.js";

/** Structural subset of Workers KV used here (a real KVNamespace satisfies it). */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface PersistInput {
  /** The record, with `deviceId` set to the key it is stored under. */
  record: AttributionRecord;
  deviceId: string;
  env: object;
  now: number;
}

export interface ForgetInput {
  deviceId: string;
  env: object;
  now: number;
}

export interface AttributionPersistence {
  /** Used in onError stages: `persist:<name>` / `forget:<name>`. */
  readonly name: string;
  persist(input: PersistInput): Promise<void>;
  /** Called on an explicit consent withdrawal: delete the device-keyed record. */
  forget?(input: ForgetInput): Promise<void>;
}

export interface KvPersistenceOptions {
  /** Env binding name. Default "ATTRIBUTION_KV". */
  binding?: string;
  /** Default 90 days. */
  ttlSeconds?: number;
  /** Default "dev:" -> key "dev:<oa_device_id>". */
  keyPrefix?: string;
}

/** Writes the record as JSON under `dev:<oa_device_id>` with a 90-day TTL. */
export function kvPersistence(options: KvPersistenceOptions = {}): AttributionPersistence {
  const binding = options.binding ?? "ATTRIBUTION_KV";
  const ttl = options.ttlSeconds ?? TTL.kvSeconds;
  const prefix = options.keyPrefix ?? "dev:";
  return {
    name: "kv",
    async persist({ record, deviceId, env }) {
      const kv = (env as Record<string, unknown>)[binding] as KVNamespaceLike | undefined;
      if (!kv || typeof kv.put !== "function") throw new Error(`KV binding ${binding} is not bound`);
      await kv.put(`${prefix}${deviceId}`, JSON.stringify(record), { expirationTtl: ttl });
    },
    async forget({ deviceId, env }) {
      const kv = (env as Record<string, unknown>)[binding] as KVNamespaceLike | undefined;
      if (!kv || typeof kv.delete !== "function") throw new Error(`KV binding ${binding} cannot delete`);
      await kv.delete(`${prefix}${deviceId}`);
    },
  };
}

export interface OriginEndpointOptions {
  /** Absolute URL of the backend endpoint (see README "Backend change"). */
  url: string;
  /** Injected for tests or custom routing. Default: global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Default 5000 ms. */
  timeoutMs?: number;
  /** Env binding holding the HMAC key for the request signature. Default "ATTRIBUTION_SECRET". */
  secretBinding?: string;
  /** Extra headers (e.g. a Cloudflare Access service token). */
  headers?: Record<string, string>;
  /**
   * "extended" (default): the extended /api/user/ad-click-ids body with device_id and attribution.
   * "contract": exactly packages/contracts ClickIdStoreRecordExtended; the device id then travels in
   * X-OA-Device-Id and is covered by the signature.
   */
  format?: "extended" | "contract";
}

/**
 * Signature input for origin POSTs; the prefix keeps it from ever validating as an oa_attr tag.
 * v1 signs the body (device id inside it); v2 also binds the X-OA-Device-Id header.
 */
export function originSigningInput(timestamp: string, body: string, deviceId?: string): string {
  return deviceId === undefined ? `oa_attr_origin.1.${timestamp}.${body}` : `oa_attr_origin.2.${timestamp}.${deviceId}.${body}`;
}

/**
 * POSTs the record to OpenArt's backend in the extended /api/user/ad-click-ids shape (plus
 * `device_id`), signed: X-OA-Attribution-Timestamp (ms) and X-OA-Attribution-Signature
 * `v1=<base64url HMAC-SHA256(secret, "oa_attr_origin.1.<timestamp>.<body>")>`.
 */
export function originEndpointPersistence(options: OriginEndpointOptions): AttributionPersistence {
  const timeoutMs = options.timeoutMs ?? 5000;
  const secretBinding = options.secretBinding ?? "ATTRIBUTION_SECRET";
  /** One signed POST channel for both writes and forgets. */
  const post = async (env: object, now: number, body: string, deviceId?: string): Promise<void> => {
    const secret = (env as Record<string, unknown>)[secretBinding];
    if (typeof secret !== "string" || !secret) throw new Error(`secret binding ${secretBinding} is not set`);
    const timestamp = String(now);
    const signature = `v1=${await hmacSign(secret, originSigningInput(timestamp, body, deviceId))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`origin endpoint timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
      const res = await doFetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oa-attribution-timestamp": timestamp,
          "x-oa-attribution-signature": signature,
          ...(deviceId === undefined ? {} : { "x-oa-device-id": deviceId }),
          ...(options.headers ?? {}),
        },
        body,
        signal: controller.signal,
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`origin endpoint responded ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    name: "origin",
    persist: ({ record, deviceId, env, now }) =>
      options.format === "contract"
        ? post(env, now, JSON.stringify(toClickIdStoreRecordExtended(record)), deviceId)
        : post(env, now, JSON.stringify(buildAdClickIdsPayload(record))),
    /** Same signed channel; the backend deletes device_attribution[device_id]. */
    forget: ({ deviceId, env, now }) => post(env, now, JSON.stringify({ device_id: deviceId, forget: true })),
  };
}

/**
 * Reference verifier for the backend (port it to the backend's language): checks the
 * timestamp window, then the HMAC in constant time.
 */
export async function verifyOriginSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  now: number,
  toleranceMs = 5 * 60_000,
  /** The X-OA-Device-Id header, for "contract"-format posts. */
  deviceId?: string,
): Promise<boolean> {
  const ts = Number(timestamp);
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - ts) > toleranceMs) return false;
  const m = /^v1=([A-Za-z0-9_-]{43})$/.exec(signature);
  if (!m) return false;
  const tag = base64urlToBytes(m[1]!);
  if (!tag) return false;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, tag, utf8(originSigningInput(timestamp, body, deviceId)));
}

export function resolvePersistence(option: AttributionPersistence | AttributionPersistence[] | false | undefined, env: object): AttributionPersistence[] {
  if (option === false) return [];
  if (option === undefined) {
    const kv = (env as Record<string, unknown>).ATTRIBUTION_KV;
    return kv ? [kvPersistence()] : [];
  }
  return Array.isArray(option) ? option : [option];
}
