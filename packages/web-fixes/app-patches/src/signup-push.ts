/**
 * `signup` dataLayer push with the user id.
 *
 * Replaces the body of Suite module 764475 (82a8baa61b72c9cd.js, component
 * `SignUpDataLayerEvent`), which today pushes
 *   {event:"signup", user_data:{email}}
 * from the one-shot cookie `oa_signup_uid` = "<uid>:<email>" and drops the uid.
 *
 * GTM needs the uid to build the deterministic registration id `reg_<uid>` that Meta
 * (`fbq CompleteRegistration eventID`) and OpenAI Ads (`registration_completed event_id`)
 * already use (modules 254079 / 555451), so TikTok CompleteRegistration, the Google Ads
 * signup conversion (order id), LinkedIn/X/Reddit signup and the server twins can share it.
 *
 * The push stays backwards compatible: same event name, same `user_data.email`; `user_id` is
 * a new top-level key (not inside `user_data`, which Google treats as user-provided data).
 *
 * Two hardening changes (review findings):
 *  - the email is validated (RFC 5321 lengths, a conservative address pattern, a dotted domain)
 *    before it reaches the dataLayer, where GTM hands it to Google, Reddit, X and TikTok as
 *    user-provided data. Anything else is pushed as `''`, the shape the shipped code already
 *    uses for a cookie without an email; the uid is kept.
 *  - the push is at most once per signup: a marker (`reg_<uid>`, never the email) is set in memory
 *    and in sessionStorage before the push, so a throw in logging or in the cookie removal, a
 *    re-mount, or a reload before the one-shot cookie is gone cannot push the event twice. A lost
 *    browser signup is backstopped by the server twin (conversion-service, same `reg_<uid>`).
 */

export const SIGNUP_COOKIE = 'oa_signup_uid';
export const SIGNUP_EVENT = 'signup';
/** Conservative id charset (Firebase-style ids such as `dOp6BlUh0AgkVu3ILV59` fit). */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** RFC 5321: 254 characters for a forward path's address, 64 for the local part. */
export const MAX_EMAIL_LENGTH = 254;
/**
 * The WHATWG `input[type=email]` local-part characters (at most 64), and a domain of DNS labels
 * with a letter TLD, so a dotted, deliverable domain. No quotes, spaces, colons or angle brackets.
 */
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Format and length check for the email carried by `oa_signup_uid` (the length is checked first: bounded regex input). */
export function isValidSignupEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export interface ParsedSignupCookie {
  /** null when the part before ':' is empty or fails USER_ID_PATTERN. */
  userId: string | null;
  /** The (trimmed) address after the first ':' when isValidSignupEmail() accepts it, else ''. */
  email: string;
}

/** Same split as the shipped code (`i=r.indexOf(":"), s=i>-1?r.slice(i+1):""`), then the email is validated. */
export function parseSignupCookie(value: string | null | undefined): ParsedSignupCookie | null {
  if (!value) return null;
  const sep = value.indexOf(':');
  const rawUid = sep > -1 ? value.slice(0, sep) : '';
  const rawEmail = sep > -1 ? value.slice(sep + 1).trim() : '';
  return { userId: USER_ID_PATTERN.test(rawUid) ? rawUid : null, email: isValidSignupEmail(rawEmail) ? rawEmail : '' };
}

export interface SignupPush {
  event: typeof SIGNUP_EVENT;
  user_id?: string;
  user_data: { email: string };
}

export function buildSignupPush(parsed: ParsedSignupCookie): SignupPush {
  const push: SignupPush = { event: SIGNUP_EVENT, user_data: { email: parsed.email } };
  if (parsed.userId) push.user_id = parsed.userId;
  return push;
}

/** The registration dedup id used by every platform and by the server twin. */
export function registrationEventId(userId: string): `reg_${string}` {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('invalid user id');
  return `reg_${userId}`;
}

export interface SignupCookieApi {
  get: (name: string) => string | undefined;
  remove: (name: string, attributes: { path: string }) => void;
}

export interface SignupWindow {
  dataLayer?: unknown[];
  /** In-page push-once marker (the last signup pushed from this page). */
  __oaSignupPushed?: string;
  /** Push-once marker across reloads in the same tab. */
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export type SignupPushOutcome = 'pushed' | 'already_pushed' | 'no_cookie';

/** sessionStorage key of the push-once marker. */
export const SIGNUP_PUSHED_KEY = 'oa_signup_pushed';

/** 32-bit FNV-1a, hex: tells two uid-less signups apart without storing the email. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** `reg_<uid>` (the registration id itself), or a hash of the cookie when it carries no valid uid. */
export function signupMarker(cookieValue: string, parsed: ParsedSignupCookie): string {
  return parsed.userId ? `reg_${parsed.userId}` : `nouid_${fnv1a(cookieValue)}`;
}

function alreadyPushed(win: SignupWindow, marker: string): boolean {
  if (win.__oaSignupPushed === marker) return true;
  try {
    return win.sessionStorage?.getItem(SIGNUP_PUSHED_KEY) === marker;
  } catch {
    return false;
  }
}

function markPushed(win: SignupWindow, marker: string): void {
  win.__oaSignupPushed = marker;
  try {
    win.sessionStorage?.setItem(SIGNUP_PUSHED_KEY, marker);
  } catch {
    // storage blocked or full: the in-page marker still covers re-mounts
  }
}

function removeSignupCookie(cookies: SignupCookieApi): void {
  try {
    cookies.remove(SIGNUP_COOKIE, { path: '/' });
  } catch {
    // the push-once marker keeps a leftover cookie from pushing again
  }
}

/**
 * Drop-in body for the `useEffect` in module 764475:
 *
 *   useEffect(() => { if (fired.current) return;
 *     if (pushSignupEvent(window, Cookies) !== 'no_cookie') fired.current = true; }, []);
 *
 * At most one push per signup: the marker is written BEFORE the push, and nothing after the push
 * can throw.
 */
export function pushSignupEvent(
  win: SignupWindow,
  cookies: SignupCookieApi,
  log: (message: string, ...args: unknown[]) => void = () => undefined,
): SignupPushOutcome {
  const raw = cookies.get(SIGNUP_COOKIE);
  const parsed = parseSignupCookie(raw);
  if (!raw || !parsed) return 'no_cookie';
  const marker = signupMarker(raw, parsed);
  if (alreadyPushed(win, marker)) {
    removeSignupCookie(cookies);
    return 'already_pushed';
  }
  markPushed(win, marker);
  win.dataLayer = win.dataLayer || [];
  win.dataLayer.push(buildSignupPush(parsed));
  try {
    log(
      '[SignUpDataLayerEvent] pushed dataLayer event: signup, email=%s, user_id=%s',
      parsed.email ? `${parsed.email.slice(0, 3)}***` : '(empty)',
      parsed.userId ? 'present' : '(missing)',
    );
  } catch {
    // logging must never cost (or duplicate) the event
  }
  removeSignupCookie(cookies);
  return 'pushed';
}
