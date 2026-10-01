// Third-party transport of the collection seal. The browser has no route to any third-party host
// (the gatekeeper proxy tunnels to first-party openart.ai hosts only), so every third-party request
// the policy ALLOWS — SDK scripts, fonts, a few images — is fetched here, by the watchdog itself,
// as a plain GET, and handed to Chrome with Fetch.fulfillRequest. Consequences:
//   * a request that bypasses the Fetch domain (browser-process traffic, a future Chrome channel)
//     cannot reach an ad platform: the proxy refuses the CONNECT before any socket exists;
//   * the watchdog, not the page, chooses exactly what leaves: GET only, no cookies, no conditional
//     or credential headers, redirects handed back to Chrome (so every hop is decided again).
import type { Protocol } from 'puppeteer-core';

export interface FetchedResponse {
  status: number;
  headers: Protocol.Fetch.HeaderEntry[];
  body: Buffer;
}

/** Request headers never forwarded: hop-by-hop, cookies/credentials, conditionals, encodings. */
const DROP_REQUEST_HEADERS = /^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|content-type|cookie|authorization|accept-encoding|if-none-match|if-modified-since|if-match|if-unmodified-since|if-range|sec-purpose|purpose|priority)$/i;
/** Response headers never passed to Chrome: framing/encoding (the body is decoded) and reporting setup. */
const DROP_RESPONSE_HEADERS = /^(content-encoding|content-length|transfer-encoding|connection|keep-alive|alt-svc|nel|report-to|reporting-endpoints|strict-transport-security)$/i;

export const MAX_THIRD_PARTY_BYTES = 12 * 1024 * 1024;

export function forwardableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.startsWith(':') || DROP_REQUEST_HEADERS.test(k)) continue;
    if (/[\r\n\0]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export async function nodeFetchGet(
  url: string,
  requestHeaders: Record<string, string> | undefined,
  opts: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchedResponse> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`refusing to fetch ${u.protocol} URL`);
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'GET',
    headers: forwardableHeaders(requestHeaders),
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const headers: Protocol.Fetch.HeaderEntry[] = [];
  res.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie' || DROP_RESPONSE_HEADERS.test(name)) return;
    headers.push({ name, value });
  });
  const setCookies = typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function' ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie() : [];
  for (const c of setCookies) headers.push({ name: 'Set-Cookie', value: c });
  const max = opts.maxBytes ?? MAX_THIRD_PARTY_BYTES;
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new Error(`third-party response larger than ${max} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: res.status, headers, body: Buffer.concat(chunks) };
}

/** Per-session cache (a real browser would serve repeated SDK/font requests from its HTTP cache). */
export class ThirdPartyCache {
  private readonly m = new Map<string, FetchedResponse>();
  get(url: string): FetchedResponse | undefined {
    return this.m.get(url);
  }
  put(url: string, type: string, r: FetchedResponse): void {
    if (r.status !== 200 || !['Script', 'Stylesheet', 'Font', 'Image'].includes(type)) return;
    if (r.headers.some((h) => h.name.toLowerCase() === 'cache-control' && /no-store/i.test(h.value))) return;
    if (r.headers.some((h) => h.name.toLowerCase() === 'set-cookie')) return;
    this.m.set(url, r);
  }
}
