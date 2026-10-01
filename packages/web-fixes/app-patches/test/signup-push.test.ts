import { describe, expect, it } from 'vitest';
import { readFixture } from '../../test-utils/fixtures';
import {
  SIGNUP_PUSHED_KEY,
  buildSignupPush,
  isValidSignupEmail,
  parseSignupCookie,
  pushSignupEvent,
  registrationEventId,
  type SignupCookieApi,
  type SignupWindow,
} from '../src/signup-push';

/** Shipped Suite module 764475 (82a8baa61b72c9cd.js), executed with fake React + js-cookie. */
const SHIPPED = readFixture(import.meta.url, './fixtures/suite-module-764475.js');

function makeCookies(value: string | undefined): SignupCookieApi & { removed: string[] } {
  const removed: string[] = [];
  let current = value;
  return {
    removed,
    get: (name: string) => (name === 'oa_signup_uid' ? current : undefined),
    remove: (name: string) => {
      removed.push(name);
      current = undefined;
    },
  };
}

function runShipped(cookieValue: string | undefined): { dataLayer: unknown[]; removed: string[] } {
  const win: { dataLayer?: unknown[] } = {};
  const cookies = makeCookies(cookieValue);
  const react = { useRef: (v: unknown) => ({ current: v }), useEffect: (fn: () => void) => fn() };
  const factory = new Function('window', 'console', `return (${SHIPPED.trim()})`)(win, { info: () => undefined }) as (e: unknown) => void;
  let component: (() => unknown) | undefined;
  factory({
    i: (id: number) => (id === 464143 ? { default: cookies } : id === 478790 ? react : {}),
    s: (pairs: unknown[]) => {
      component = (pairs[1] as () => () => unknown)();
    },
  });
  component!();
  return { dataLayer: win.dataLayer ?? [], removed: cookies.removed };
}

describe('regression against shipped module 764475', () => {
  const cases = ['dOp6BlUh0AgkVu3ILV59:jane@example.com', 'uid123:', 'no-separator', ':nobody@example.com'];
  for (const value of cases) {
    it(`keeps event name, email and cookie removal for ${JSON.stringify(value)}`, () => {
      const shipped = runShipped(value);
      const win: { dataLayer?: unknown[] } = {};
      const cookies = makeCookies(value);
      expect(pushSignupEvent(win, cookies)).toBe('pushed');
      const before = shipped.dataLayer[0] as { event: string; user_data: { email: string } };
      const after = win.dataLayer![0] as { event: string; user_data: { email: string }; user_id?: string };
      expect(after.event).toBe(before.event);
      expect(after.user_data).toEqual(before.user_data);
      expect(cookies.removed).toEqual(shipped.removed);
    });
  }

  it('the shipped code pushes whatever follows the first ":" as the email (the bug)', () => {
    for (const email of ['<img src=x onerror=alert(1)>', `${'a'.repeat(300)}@example.com`, 'we:ird@example.com']) {
      expect((runShipped(`u1:${email}`).dataLayer[0] as { user_data: { email: string } }).user_data.email).toBe(email);
    }
  });

  it('adds user_id only when the uid is well-formed', () => {
    const win: { dataLayer?: unknown[] } = {};
    pushSignupEvent(win, makeCookies('dOp6BlUh0AgkVu3ILV59:jane@example.com'));
    pushSignupEvent(win, makeCookies(':jane@example.com'));
    pushSignupEvent(win, makeCookies('bad uid:jane@example.com'));
    expect(win.dataLayer).toEqual([
      { event: 'signup', user_id: 'dOp6BlUh0AgkVu3ILV59', user_data: { email: 'jane@example.com' } },
      { event: 'signup', user_data: { email: 'jane@example.com' } },
      { event: 'signup', user_data: { email: 'jane@example.com' } },
    ]);
  });

  it('does nothing without the cookie (same as shipped)', () => {
    expect(runShipped(undefined).dataLayer).toEqual([]);
    const win: { dataLayer?: unknown[] } = {};
    expect(pushSignupEvent(win, makeCookies(undefined))).toBe('no_cookie');
    expect(win.dataLayer).toBeUndefined();
  });
});

describe('email validation (review: the cookie email is pushed unvalidated)', () => {
  const INVALID = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>@example.com',
    `${'a'.repeat(250)}@example.com`, // 262 chars: over RFC 5321's 254
    `${'a'.repeat(65)}@example.com`, // local part over 64
    'we:ird@example.com',
    'no-at-sign',
    'jane@localhost',
    'jane@@example.com',
    'jane doe@example.com',
    'jane@example..com',
    'jane@-example.com',
  ];

  it('accepts ordinary addresses (trimmed) and rejects markup, over-long and malformed ones', () => {
    for (const ok of ['jane@example.com', 'J.Doe+tag@Sub.Example.co.uk', "o'brien@example.ie", 'x_y-z@a1.io']) expect(isValidSignupEmail(ok), ok).toBe(true);
    for (const bad of INVALID) expect(isValidSignupEmail(bad), bad).toBe(false);
  });

  it('pushes an empty email (the shape the shipped code uses when there is none) instead of an invalid one, keeping user_id', () => {
    for (const bad of INVALID) {
      const win: { dataLayer?: unknown[] } = {};
      expect(pushSignupEvent(win, makeCookies(`dOp6BlUh0AgkVu3ILV59:${bad}`))).toBe('pushed');
      expect(win.dataLayer).toEqual([{ event: 'signup', user_id: 'dOp6BlUh0AgkVu3ILV59', user_data: { email: '' } }]);
    }
    expect(parseSignupCookie('u1:  jane@example.com ')).toEqual({ userId: 'u1', email: 'jane@example.com' });
  });
});

describe('push-once marker (review: a throw after the push duplicated the event)', () => {
  const throwing = (value: string, fail: 'remove' | 'log'): SignupCookieApi => ({
    get: () => value,
    remove: () => {
      if (fail === 'remove') throw new Error('cookie removal failed');
    },
  });

  it('a throw in cookie removal or logging cannot cause a second push for the same signup', () => {
    for (const fail of ['remove', 'log'] as const) {
      const win: SignupWindow = {};
      const log = fail === 'log' ? () => { throw new Error('console unavailable'); } : undefined;
      expect(pushSignupEvent(win, throwing('u1:jane@example.com', fail), log)).toBe('pushed');
      expect(pushSignupEvent(win, throwing('u1:jane@example.com', fail), log)).toBe('already_pushed');
      expect(win.dataLayer).toHaveLength(1);
    }
  });

  it('the marker survives a reload in the same tab (sessionStorage) and holds no email', () => {
    const store = new Map<string, string>();
    const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const first: SignupWindow = { sessionStorage };
    pushSignupEvent(first, throwing('u1:jane@example.com', 'remove'));
    const reloaded: SignupWindow = { sessionStorage };
    expect(pushSignupEvent(reloaded, throwing('u1:jane@example.com', 'remove'))).toBe('already_pushed');
    expect(reloaded.dataLayer).toBeUndefined();
    expect(store.get(SIGNUP_PUSHED_KEY)).toBe('reg_u1');
    expect([...store.values()].join()).not.toContain('jane');
  });

  it('a different signup (another uid) still pushes, and storage that throws never blocks the push', () => {
    const win: SignupWindow = {};
    pushSignupEvent(win, makeCookies('u1:jane@example.com'));
    expect(pushSignupEvent(win, makeCookies('u2:joe@example.com'))).toBe('pushed');
    expect(win.dataLayer).toHaveLength(2);
    const hostile: SignupWindow = {
      sessionStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('QuotaExceeded');
        },
      },
    };
    expect(pushSignupEvent(hostile, makeCookies('u3:ann@example.com'))).toBe('pushed');
    expect(hostile.dataLayer).toHaveLength(1);
  });

  it('removes the one-shot cookie even when the push was already made', () => {
    const win: SignupWindow = {};
    pushSignupEvent(win, throwing('u1:jane@example.com', 'remove'));
    const cookies = makeCookies('u1:jane@example.com');
    expect(pushSignupEvent(win, cookies)).toBe('already_pushed');
    expect(cookies.removed).toEqual(['oa_signup_uid']);
  });
});

describe('helpers', () => {
  it('parses exactly like the shipped split and builds the push', () => {
    expect(parseSignupCookie('abc:x@y.co')).toEqual({ userId: 'abc', email: 'x@y.co' });
    expect(parseSignupCookie('abc:x@y.z')).toEqual({ userId: 'abc', email: '' }); // no single-letter TLD exists
    expect(buildSignupPush({ userId: null, email: '' })).toEqual({ event: 'signup', user_data: { email: '' } });
  });

  it('builds reg_<uid> and rejects malformed ids', () => {
    expect(registrationEventId('dOp6BlUh0AgkVu3ILV59')).toBe('reg_dOp6BlUh0AgkVu3ILV59');
    expect(() => registrationEventId('a b')).toThrow();
  });

  it('logs a masked email only', () => {
    const lines: unknown[][] = [];
    pushSignupEvent({}, makeCookies('u1:jane@example.com'), (...a) => lines.push(a));
    expect(JSON.stringify(lines)).not.toContain('jane@example.com');
    expect(JSON.stringify(lines)).toContain('jan***');
  });
});
