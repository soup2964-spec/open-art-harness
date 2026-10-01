// Options shared by the Worker (capture.ts) and the edge-sim, resolved once with defaults.
import { COOKIE, TTL } from "./constants.js";
import type { RequestLike } from "./parse.js";

export interface CoreOptions {
  /** Cookie Domain attribute. Default ".openart.ai" (what OpenArt's own cookies use). */
  cookieDomain?: string;
  /**
   * Extra referrer hosts that must never create a referral touch (payment/OAuth returns).
   * A string matches that host and its subdomains. Added to the defaults.
   */
  excludedReferrers?: Array<string | RegExp>;
  /** Extra path prefixes to ignore (added to the defaults). */
  skipPathPrefixes?: string[];
  /** Only act on these hosts ("openart.ai" exact, ".openart.ai" any subdomain). Default: every host. */
  hosts?: string[];
  /** Replace the built-in bot detection. */
  isBot?: (request: RequestLike) => boolean;
  /** With Cloudflare Bot Management, skip requests scoring below this. Default 2 (score 1 = automated). */
  minBotScore?: number;
  /** TTL for the server-set ttclid cookie. Clamped to 28..90 days. Default 28. */
  ttclidTtlDays?: number;
  /** Name of OpenArt's server-set device id cookie. Default "oa_device_id". */
  deviceIdCookie?: string;
}

export interface ResolvedCoreOptions {
  cookieDomain: string;
  cookieDomainRoot: string;
  excludedReferrers: Array<string | RegExp>;
  skipPathPrefixes: string[];
  hosts: string[] | null;
  isBot: ((request: RequestLike) => boolean) | null;
  minBotScore: number;
  ttclidTtlMs: number;
  deviceIdCookie: string;
}

/** Returns from Stripe Checkout and OAuth providers look like referrals; they are not. */
export const DEFAULT_EXCLUDED_REFERRERS: ReadonlyArray<string> = [
  "stripe.com",
  "accounts.google.com",
  "accounts.youtube.com",
  "appleid.apple.com",
];

/**
 * Paths that are never pages: framework assets (Astro, Next.js Suite/Legacy), APIs, Cloudflare
 * endpoints and OpenArt's Google tag gateway path (/4vu8/, 01 §2).
 */
export const DEFAULT_SKIP_PATH_PREFIXES: ReadonlyArray<string> = [
  "/_next/",
  "/suite/_next/",
  "/legacy/_next/",
  "/_astro/",
  "/cdn-cgi/",
  "/api/",
  "/suite/api/",
  "/legacy/api/",
  "/4vu8/",
  "/.well-known/",
];

const DAY_MS = 86_400_000;

export function resolveOptions(o: CoreOptions = {}): ResolvedCoreOptions {
  const cookieDomain = (o.cookieDomain ?? ".openart.ai").trim().toLowerCase();
  const days = Math.min(90, Math.max(TTL.ttclidMinMs / DAY_MS, o.ttclidTtlDays ?? 28));
  return {
    cookieDomain,
    cookieDomainRoot: cookieDomain.replace(/^\./, ""),
    excludedReferrers: [...DEFAULT_EXCLUDED_REFERRERS, ...(o.excludedReferrers ?? [])],
    skipPathPrefixes: [...DEFAULT_SKIP_PATH_PREFIXES, ...(o.skipPathPrefixes ?? [])],
    hosts: o.hosts?.map((h) => h.toLowerCase()) ?? null,
    isBot: o.isBot ?? null,
    minBotScore: o.minBotScore ?? 2,
    ttclidTtlMs: Math.round(days) * DAY_MS,
    deviceIdCookie: o.deviceIdCookie ?? COOKIE.deviceId,
  };
}

/** True when `host` is the cookie domain or one of its subdomains. */
export function hostInDomain(host: string, root: string): boolean {
  const h = host.toLowerCase();
  return h === root || h.endsWith(`.${root}`);
}
