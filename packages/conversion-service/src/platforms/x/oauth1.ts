/**
 * OAuth 1.0a request signing (RFC 5849, HMAC-SHA1), as the X Ads API requires for custom
 * integrations. JSON bodies are not part of the signature base string (only
 * application/x-www-form-urlencoded bodies are, RFC 5849 §3.4.1.3.1). Used only by the live
 * transport; verified against X's own documented signing example in test/x-oauth1.test.ts.
 */

import { createHmac, randomBytes } from 'node:crypto';

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding (unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignOptions {
  method: string;
  url: string;
  /** Extra parameters that are part of the signature (query string or form body). */
  params?: Record<string, string>;
  nonce?: string;
  timestamp?: number;
}

export function oauth1Signature(creds: OAuth1Credentials, opts: SignOptions & { nonce: string; timestamp: number }): string {
  const url = new URL(opts.url);
  const params: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams) params.push([k, v]);
  for (const [k, v] of Object.entries(opts.params ?? {})) params.push([k, v]);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(opts.timestamp),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  for (const [k, v] of Object.entries(oauth)) params.push([k, v]);
  const normalized = params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const base = [opts.method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join('&');
  const key = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

/** Full `Authorization: OAuth …` header value. */
export function oauth1Header(creds: OAuth1Credentials, opts: SignOptions): string {
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = oauth1Signature(creds, { ...opts, nonce, timestamp });
  const fields: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature: signature,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  return `OAuth ${Object.entries(fields)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ')}`;
}
