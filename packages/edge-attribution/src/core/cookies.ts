// Cookie header parsing and Set-Cookie serialization (RFC 6265).

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** cookie-octet = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E */
const COOKIE_OCTETS_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const DOMAIN_RE = /^\.?[A-Za-z0-9.-]+$/;
/** Chrome caps cookie lifetimes at 400 days; nothing here should ask for more. */
export const MAX_AGE_CAP_SECONDS = 400 * 86_400;

export function isCookieOctets(value: string): boolean {
  return COOKIE_OCTETS_RE.test(value);
}

/**
 * Parses a Cookie request header. The first occurrence of a name wins, matching both
 * `document.cookie.match(/(?:^|;\s*)name=([^;]*)/)` in OpenArt's client code and browsers'
 * most-specific-path-first ordering. Values are returned raw (no percent-decoding).
 */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out.set(name, value);
  }
  return out;
}

export interface CookieAttributes {
  /** Omitted for host-only cookies. */
  domain?: string | null;
  path?: string;
  maxAgeSeconds: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Serializes a Set-Cookie header value; throws on anything that could inject attributes or headers. */
export function serializeSetCookie(name: string, value: string, attrs: CookieAttributes): string {
  if (!TOKEN_RE.test(name)) throw new Error(`invalid cookie name: ${name}`);
  if (!isCookieOctets(value)) throw new Error(`invalid cookie value for ${name}`);
  const parts = [`${name}=${value}`];
  if (attrs.domain) {
    if (!DOMAIN_RE.test(attrs.domain)) throw new Error(`invalid cookie domain: ${attrs.domain}`);
    parts.push(`Domain=${attrs.domain}`);
  }
  parts.push(`Path=${attrs.path ?? "/"}`);
  const maxAge = Number.isFinite(attrs.maxAgeSeconds) ? Math.min(MAX_AGE_CAP_SECONDS, Math.max(0, Math.ceil(attrs.maxAgeSeconds))) : 0;
  parts.push(`Max-Age=${maxAge}`);
  if (attrs.secure !== false) parts.push("Secure");
  if (attrs.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${attrs.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Name of the cookie a Set-Cookie line sets. */
export function setCookieName(line: string): string {
  const eq = line.indexOf("=");
  return (eq === -1 ? line : line.slice(0, eq)).trim();
}

/** Value of a named cookie set by a list of Set-Cookie lines (last write wins), or null. */
export function findSetCookieValue(lines: readonly string[], name: string): string | null {
  let found: string | null = null;
  for (const line of lines) {
    if (setCookieName(line) !== name) continue;
    const first = line.split(";", 1)[0] ?? "";
    found = first.slice(first.indexOf("=") + 1).trim();
  }
  return found;
}
