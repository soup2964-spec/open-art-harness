/**
 * In-app-browser handoff that keeps attribution, and Google OAuth handling in webviews.
 *
 * Today (Suite module 825073, ea9b966c01d84c18.js):
 *  - `em()` ("Option 2: Copy the link, open it in the browser") shows and copies
 *    `window.location.href` captured at mount. After the usual Astro landing -> /home hop that is
 *    `https://openart.ai/home`: no click ids, no UTMs (crawl/teardown2/T11a); the external
 *    browser starts with an empty cookie jar.
 *  - `eb()` renders all four OAuth buttons (google, apple, discord, twitter) enabled; in a
 *    detected webview only a hint appears under Google, although Google blocks OAuth in embedded
 *    webviews (`disallowed_useragent`).
 *
 * The fix builds the handoff URL from stored attribution:
 *  1. token mode (preferred): POST /api/attribution/handoff {path} on the edge-attribution
 *     Worker returns {token, url: "https://openart.ai/r/<token>", expiresAt, path}; opening that
 *     URL in the external browser restores the webview's attribution server-side (single use,
 *     30 min TTL). `path` is the pathname plus the attribution params only (handoffRequestPath):
 *     other query params can carry magic links, reset tokens or emails, and must never be sent
 *     to the server, which stores the target.
 *  2. param mode (fallback, no backend needed): the current URL plus every stored click id and
 *     UTM that is not already in it. It stays on the device (shown and copied, never sent).
 * and hides (default) or de-emphasises Google OAuth when the detector matches.
 */
import { AD_CLICK_ID_KEYS, isValidClickIdValue, type ClickIdKey } from './click-id-keys';
import { UTM_KEYS, cleanUtm, readAttributionSnapshot, type AttributionEnv, type AttributionSnapshot } from './attribution-snapshot';

/** Same lists as module 825073 `X` and `ee` (kept verbatim for parity). */
export const IN_APP_UA_PATTERNS: readonly RegExp[] = [
  /linkedinapp/,
  /instagram/,
  /\bfban|\bfbav|\bfb_iab|\bfbios|\bfbdv/,
  /musical_ly|bytedance|bytelocale|tiktok/,
  /micromessenger/,
  /twitter/,
  /\bline\//,
  /pinterest/,
  /snapchat/,
  /reddit/,
  /whatsapp/,
  /telegram/,
  /slack/,
  /discord/,
  /qq\//,
  /weibo/,
  /kakaotalk/,
  /electron/,
];
export const WEBVIEW_UA_PATTERNS: readonly RegExp[] = [/;\s*wv\)/, /\bgsa\//];

/** Identical decision to the shipped detector in `eb()`. */
export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return (
    IN_APP_UA_PATTERNS.some((re) => re.test(ua)) ||
    WEBVIEW_UA_PATTERNS.some((re) => re.test(ua)) ||
    (/iphone|ipad|ipod/.test(ua) && !/safari\//.test(ua) && !/crios|fxios|edgios/.test(ua))
  );
}

export const HANDOFF_ENDPOINT = '/api/attribution/handoff';
/** Token format issued by packages/edge-attribution (22 chars base64url). */
export const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const DEFAULT_MAX_URL_LENGTH = 2000;

export interface HandoffResponse {
  token: string | null;
  url: string;
  expiresAt: number | null;
  path: string;
}

export type HandoffMode = 'token' | 'params' | 'plain';

export interface HandoffResult {
  url: string;
  mode: HandoffMode;
  /** Click-id keys carried by the URL (param mode) — for telemetry, never the values. */
  clickIdKeys: ClickIdKey[];
}

/**
 * Low-priority params are dropped first if the URL would exceed `maxLength`
 * (utm_term/utm_content, then the least common click ids).
 */
const DROP_ORDER: readonly string[] = [
  'utm_id',
  'utm_term',
  'utm_content',
  'oppref',
  'rdt_cid',
  'twclid',
  'li_fat_id',
  'msclkid',
  'wbraid',
  'gbraid',
  'utm_medium',
  'utm_campaign',
  'utm_source',
  'ttclid',
  'fbclid',
  'gclid',
];

export function buildParamHandoffUrl(
  href: string,
  snapshot: AttributionSnapshot,
  opts: { maxLength?: number } = {},
): { url: string; clickIdKeys: ClickIdKey[] } {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_URL_LENGTH;
  const url = new URL(href);
  url.hash = '';
  const added: string[] = [];
  for (const key of AD_CLICK_ID_KEYS) {
    const value = snapshot.clickIds[key];
    if (value && !url.searchParams.has(key)) {
      url.searchParams.set(key, value);
      added.push(key);
    }
  }
  for (const key of UTM_KEYS) {
    const value = snapshot.utm[key];
    if (value && !url.searchParams.has(key)) {
      url.searchParams.set(key, value);
      added.push(key);
    }
  }
  for (const key of DROP_ORDER) {
    if (url.toString().length <= maxLength) break;
    if (added.includes(key)) {
      url.searchParams.delete(key);
      added.splice(added.indexOf(key), 1);
    }
  }
  const clickIdKeys = AD_CLICK_ID_KEYS.filter((k) => url.searchParams.has(k));
  return { url: url.toString(), clickIdKeys };
}

function isSameOriginHttpsUrl(candidate: string, origin: string): boolean {
  try {
    const u = new URL(candidate);
    return u.origin === origin && u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseHandoffResponse(body: unknown, origin: string): HandoffResponse | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const token = b.token;
  if (!(token === null || (typeof token === 'string' && HANDOFF_TOKEN_PATTERN.test(token)))) return null;
  if (typeof b.url !== 'string' || !isSameOriginHttpsUrl(b.url, origin)) return null;
  if (token !== null && new URL(b.url).pathname !== `/r/${token}`) return null;
  if (!(b.expiresAt === null || typeof b.expiresAt === 'number')) return null;
  if (typeof b.path !== 'string') return null;
  return { token, url: b.url, expiresAt: b.expiresAt, path: b.path };
}

/** A UTM value shaped like an email address: personal data, never sent (edge-attribution drops it too). */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

/**
 * The `path` token mode POSTs: the pathname plus only the attribution params of the current URL,
 * in canonical order: click ids that pass CLICK_ID_VALUE_PATTERN, and clean `utm_*` values.
 */
export function handoffRequestPath(location: { pathname: string; search: string }): string {
  const current = new URLSearchParams(location.search);
  const kept = new URLSearchParams();
  for (const key of AD_CLICK_ID_KEYS) {
    const value = current.get(key);
    if (isValidClickIdValue(value)) kept.set(key, value);
  }
  for (const key of UTM_KEYS) {
    const value = cleanUtm(current.get(key));
    if (value && !EMAIL_LIKE.test(value)) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `${location.pathname}?${query}` : location.pathname;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Ask the edge Worker for a handoff URL. Resolves null on any error or after `timeoutMs`. */
export async function requestHandoff(
  fetchImpl: FetchLike,
  origin: string,
  path: string,
  opts: { timeoutMs?: number; setTimeout?: (cb: () => void, ms: number) => unknown } = {},
): Promise<HandoffResponse | null> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const schedule = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const call = (async () => {
    try {
      const res = await fetchImpl(HANDOFF_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) return null;
      return parseHandoffResponse(await res.json(), origin);
    } catch {
      return null;
    }
  })();
  const timeout = new Promise<null>((resolve) => {
    schedule(() => resolve(null), timeoutMs);
  });
  return Promise.race([call, timeout]);
}

export interface HandoffWindow {
  location: { href: string; origin: string; pathname: string; search: string };
  document: { cookie: string };
  localStorage?: Pick<Storage, 'getItem'> | null;
  fetch?: FetchLike;
}

/**
 * The URL to show/copy in the "Open page in your browser" overlay.
 * Token mode when the Worker answers, otherwise param mode, otherwise the plain URL.
 */
export async function getHandoffUrl(
  win: HandoffWindow,
  opts: { useToken?: boolean; timeoutMs?: number; maxLength?: number } = {},
): Promise<HandoffResult> {
  const env: AttributionEnv = { cookie: win.document.cookie, localStorage: win.localStorage ?? null };
  if (opts.useToken !== false && typeof win.fetch === 'function') {
    const res = await requestHandoff(win.fetch, win.location.origin, handoffRequestPath(win.location), {
      timeoutMs: opts.timeoutMs,
    });
    if (res?.token) return { url: res.url, mode: 'token', clickIdKeys: [] };
  }
  const snapshot = readAttributionSnapshot(env);
  const { url, clickIdKeys } = buildParamHandoffUrl(win.location.href, snapshot, { maxLength: opts.maxLength });
  const hasAny = clickIdKeys.length > 0 || UTM_KEYS.some((k) => new URL(url).searchParams.has(k));
  return { url, mode: hasAny ? 'params' : 'plain', clickIdKeys };
}

/* ------------------------------------------------------------------ */
/* OAuth providers in webviews                                         */
/* ------------------------------------------------------------------ */

export type AuthProviderId = 'google' | 'apple' | 'discord' | 'twitter';

export interface ProviderPresentation {
  id: AuthProviderId;
  emphasis: 'primary' | 'secondary' | 'hidden';
  /** Render the "Trouble redirecting? Open page in your browser" hint/CTA under this button. */
  showHandoff: boolean;
}

/**
 * Order and emphasis for `eb()`'s provider list (`eg = ["google","apple","discord","twitter"]`).
 *  - outside webviews: unchanged (all primary, no hint)
 *  - in a webview, `hide` (default): Google hidden; the handoff CTA takes its place so users who
 *    want Google continue in the external browser with attribution intact
 *  - in a webview, `deemphasize`: Google moved last, secondary style, handoff hint under it
 */
export function presentAuthProviders(
  providers: readonly AuthProviderId[],
  ctx: { inAppBrowser: boolean; googleInWebview?: 'hide' | 'deemphasize' },
): ProviderPresentation[] {
  if (!ctx.inAppBrowser) return providers.map((id) => ({ id, emphasis: 'primary', showHandoff: false }));
  const mode = ctx.googleInWebview ?? 'hide';
  const others = providers.filter((p) => p !== 'google').map((id): ProviderPresentation => ({ id, emphasis: 'primary', showHandoff: false }));
  if (!providers.includes('google')) return others;
  const google: ProviderPresentation =
    mode === 'hide' ? { id: 'google', emphasis: 'hidden', showHandoff: true } : { id: 'google', emphasis: 'secondary', showHandoff: true };
  return [...others, google];
}

/**
 * Optional: put the attribution-carrying URL in the address bar when the overlay opens, so
 * "Option 1" (the webview's own ••• menu, which opens the current URL) carries it too.
 * Only same-origin, same-path URLs are accepted (never a navigation).
 */
export function decorateAddressBar(
  win: { location: { href: string }; history: Pick<History, 'replaceState' | 'state'> },
  handoffUrl: string,
): boolean {
  try {
    const current = new URL(win.location.href);
    const next = new URL(handoffUrl);
    if (next.origin !== current.origin || next.pathname !== current.pathname) return false;
    win.history.replaceState(win.history.state, '', next.pathname + next.search);
    return true;
  } catch {
    return false;
  }
}
