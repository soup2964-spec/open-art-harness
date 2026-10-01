/**
 * Transports: how a built PlatformRequest leaves (or does not leave) the process.
 *
 *   DryRunTransport   writes the exact request (URL, non-secret headers, body) to
 *                     <outDir>/requests/<platform>/<ULID>-<instance>-<action>.json. Default for
 *                     everything. Names are unique across instances and restarts; the bucket's
 *                     lifecycle rule (infra/conversion-service/dry-run-bucket-lifecycle.json)
 *                     removes the files after 30 days.
 *   LiveTransport     authenticates and sends with an INJECTED fetch. Only constructed in live
 *                     mode (see live.ts) and only used for platforms listed in LIVE_PLATFORMS.
 *   RoutingTransport  picks live or dry-run per platform.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@openart-signal/contracts';
import { PLATFORM_MODULES } from '../platforms/registry.js';
import { credentialRetry } from '../platforms/types.js';
import type { AuthKind, PlatformRequest, SendOutcome } from '../platforms/types.js';
import { ulid } from '../ulid.js';

export interface Transport {
  send(request: PlatformRequest): Promise<SendOutcome>;
}

export interface WrittenRequest {
  file: string;
  request: PlatformRequest;
}

export interface DryRunOptions {
  /** Distinguishes instances writing to one bucket. Default: <hostname>-<pid>-<random>. */
  instanceId?: string;
  /** Unique, time-sortable id per request file. Default: a ULID. */
  newId?: () => string;
  /** How many written requests to keep in memory (tests and scripts). Default 0: none. */
  retainWritten?: number;
}

function defaultInstanceId(): string {
  const host = hostname().replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'host';
  return `${host}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

export class DryRunTransport implements Transport {
  /** The most recent requests (at most retainWritten); empty unless retention was asked for. */
  readonly written: WrittenRequest[] = [];
  private readonly instanceId: string;
  private readonly newId: () => string;
  private readonly retain: number;

  constructor(
    private readonly outDir: string,
    options: DryRunOptions = {},
  ) {
    this.instanceId = options.instanceId ?? defaultInstanceId();
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(this.instanceId)) throw new Error(`invalid dry-run instance id: ${this.instanceId}`);
    this.newId = options.newId ?? (() => ulid());
    this.retain = options.retainWritten ?? 0;
  }

  async send(request: PlatformRequest): Promise<SendOutcome> {
    const dir = join(this.outDir, 'requests', request.platform);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${this.newId()}-${this.instanceId}-${request.action}.json`);
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      auth: `${request.auth} (added by the live transport; never written)`,
      body: request.body,
    };
    // 'wx': never overwrite an existing request file.
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    if (this.retain > 0) {
      this.written.push({ file, request: structuredClone(request) });
      if (this.written.length > this.retain) this.written.splice(0, this.written.length - this.retain);
    }
    return { kind: 'ok', status: 200, dryRun: true };
  }
}

export interface AppliedAuth {
  url: string;
  headers: Record<string, string>;
}

/** Adds credentials for a request (live mode only). */
export interface AuthProvider {
  apply(request: PlatformRequest): Promise<AppliedAuth>;
}

/** The subset of the WHATWG fetch init this service uses. Node 22's global fetch satisfies FetchLike without a cast. */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  /** Omitted for GET/HEAD/DELETE: Node 22's fetch (undici) throws "Request with GET/HEAD method cannot have body". */
  body?: string;
  signal?: AbortSignal;
  /** Always 'error' in this service: a redirect from an ad platform or Firestore is never followed. */
  redirect?: 'error' | 'follow' | 'manual';
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (input: string, init: FetchInit) => Promise<FetchResponseLike>;

/** Methods that must not carry a request body. */
export const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE']);

/** Strip credentials that could appear in URLs or echoed request lines before anything is stored or logged. */
export function redactSecrets(text: string): string {
  return text.replace(/(access_token=)[^&\s"']+/gi, '$1[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/g, '$1[redacted]');
}

export class LiveTransport implements Transport {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly auth: AuthProvider,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(request: PlatformRequest): Promise<SendOutcome> {
    let applied: AppliedAuth;
    try {
      applied = await this.auth.apply(request);
    } catch (err) {
      // A missing or unrefreshable credential is systemic: wait for the fix instead of dead-lettering.
      return credentialRetry(null, redactSecrets(`auth: ${(err as Error).message}`));
    }
    let status: number;
    let text: string;
    let retryAfter: string | null;
    try {
      const res = await this.fetchImpl(applied.url, {
        method: request.method,
        headers: applied.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Never follow a redirect: the credential header would go wherever it points.
        redirect: 'error',
      });
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      text = await res.text();
    } catch (err) {
      // Network error or timeout: the platform may or may not have the batch; every platform here
      // dedupes on our event ids, so a retry is the safe side.
      return { kind: 'retry', status: null, error: redactSecrets(`network: ${(err as Error).message}`) };
    }
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body: keep the text for the error message.
    }
    const outcome = PLATFORM_MODULES[request.platform].classifyResponse(status, body, retryAfter);
    return outcome.kind === 'ok' ? outcome : { ...outcome, error: redactSecrets(outcome.error) };
  }
}

export class RoutingTransport implements Transport {
  constructor(
    private readonly dryRun: Transport,
    private readonly live: Transport | null,
    private readonly livePlatforms: ReadonlySet<Platform>,
  ) {}

  send(request: PlatformRequest): Promise<SendOutcome> {
    if (this.live && this.livePlatforms.has(request.platform)) return this.live.send(request);
    return this.dryRun.send(request);
  }
}

/** Secret names per auth kind (values come from Secret Manager env vars in live mode). */
export const SECRETS_BY_AUTH: Readonly<Record<AuthKind, readonly string[]>> = {
  google_oauth: [],
  meta_access_token: ['META_CAPI_ACCESS_TOKEN'],
  tiktok_access_token: ['TIKTOK_EVENTS_ACCESS_TOKEN'],
  reddit_bearer: ['REDDIT_CONVERSION_ACCESS_TOKEN'],
  linkedin_bearer: ['LINKEDIN_ACCESS_TOKEN'],
  x_oauth1: ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'],
  microsoft_uet_bearer: ['MICROSOFT_UET_CAPI_TOKEN'],
  microsoft_ads_api: ['MICROSOFT_ADS_ACCESS_TOKEN', 'MICROSOFT_ADS_DEVELOPER_TOKEN'],
};
