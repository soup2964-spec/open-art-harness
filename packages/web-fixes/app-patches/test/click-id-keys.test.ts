// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWindow, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import {
  AD_CLICK_ID_KEYS,
  SUITE_V1_CLICK_ID_KEYS,
  buildFbc,
  buildMigrationPayload,
  captureAdClickIds,
  checkoutHiddenInputs,
  clickIdsFromSearch,
  fbclidFromFbc,
  filterByAge,
  isValidFbc,
  mergeClickIdStores,
  parseClickIdStore,
  readAdClickIds,
  readCookie,
  readGclid,
  serializeClickIdStore,
  withIncomingClickId,
  type ClickIdStore,
} from '../src/click-id-keys';

/**
 * The shipped Suite module 162070 (91db8069961c7577.js), evaluated as-is against a
 * happy-dom window so the new module can be compared with the code OpenArt runs today.
 */
const SUITE_162070 = readFixture(import.meta.url, './fixtures/suite-module-162070.js');

interface SuiteClickIdModule {
  buildMigrationPayload: (s: Record<string, { v: string; ts: number }>) => { keys: string[]; payload: Record<string, unknown> };
  captureAdClickIds: () => void;
  readAdClickIds: (maxAgeMs?: number) => Record<string, { v: string; ts: number }>;
  readGclid: () => string;
}

function loadShippedModule(t: TestWindow): SuiteClickIdModule {
  const factory = new Function('window', 'document', 'URLSearchParams', `return (${SUITE_162070.trim()})`)(
    t.window,
    t.window.document,
    t.window.URLSearchParams,
  ) as (e: unknown) => void;
  const exports: Record<string, () => unknown> = {};
  factory({
    i: (id: number) => (id === 358207 ? { publicEnv: { isLocalDev: false } } : {}),
    s: (pairs: unknown[]) => {
      for (let k = 0; k < pairs.length; k += 2) exports[pairs[k] as string] = pairs[k + 1] as () => unknown;
    },
  });
  return {
    buildMigrationPayload: exports.buildMigrationPayload!() as SuiteClickIdModule['buildMigrationPayload'],
    captureAdClickIds: exports.captureAdClickIds!() as SuiteClickIdModule['captureAdClickIds'],
    readAdClickIds: exports.readAdClickIds!() as SuiteClickIdModule['readAdClickIds'],
    readGclid: exports.readGclid!() as SuiteClickIdModule['readGclid'],
  };
}

const opened: TestWindow[] = [];
function open(url: string): TestWindow {
  const t = createTestWindow({ url });
  opened.push(t);
  return t;
}
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const FULL: ClickIdStore = {
  gclid: { v: 'G', ts: 1 },
  gbraid: { v: 'GB', ts: 2 },
  wbraid: { v: 'WB', ts: 3 },
  fbclid: { v: 'F', ts: 4 },
  msclkid: { v: 'M', ts: 5 },
  ttclid: { v: 'T', ts: 6 },
  rdt_cid: { v: 'R', ts: 7 },
  twclid: { v: 'X', ts: 8 },
  li_fat_id: { v: 'L', ts: 9 },
  oppref: { v: 'O', ts: 10 },
};

describe('regression against the shipped Suite module 162070', () => {
  it('produces the identical migration payload for the four keys the Suite knows today', () => {
    const t = open('https://openart.ai/home');
    const shipped = loadShippedModule(t);
    const legacyOnly: ClickIdStore = { gclid: FULL.gclid, fbclid: FULL.fbclid, msclkid: FULL.msclkid, ttclid: FULL.ttclid };
    expect(buildMigrationPayload(legacyOnly)).toEqual(shipped.buildMigrationPayload(legacyOnly as Record<string, { v: string; ts: number }>));
  });

  it('shipped payload drops six keys; the new one carries all ten with created_at', () => {
    const t = open('https://openart.ai/home');
    const shipped = loadShippedModule(t);
    expect(shipped.buildMigrationPayload(FULL as Record<string, { v: string; ts: number }>).keys).toEqual([...SUITE_V1_CLICK_ID_KEYS]);
    const next = buildMigrationPayload(FULL);
    expect(next.keys).toEqual([...AD_CLICK_ID_KEYS]);
    expect(next.payload).toMatchObject({ gbraid: 'GB', gbraid_created_at: 2, li_fat_id: 'L', oppref_created_at: 10 });
  });

  it('reads the same values as the shipped reader for shared keys, plus the new ones', () => {
    const t = open('https://openart.ai/home');
    const stored = serializeClickIdStore(FULL);
    t.jar.seed('oa_ad_clids', encodeURIComponent(stored));
    const shipped = loadShippedModule(t);
    const shippedRead = shipped.readAdClickIds();
    const nextRead = readAdClickIds({ cookie: t.window.document.cookie, localStorage: t.window.localStorage });
    for (const key of SUITE_V1_CLICK_ID_KEYS) expect(nextRead[key]).toEqual(shippedRead[key]);
    expect(Object.keys(shippedRead)).toHaveLength(4);
    expect(Object.keys(nextRead)).toHaveLength(10);
    expect(readGclid(nextRead)).toBe(shipped.readGclid());
  });

  it('reproduces T2c with the shipped code (gbraid deleted) and fixes it', () => {
    // Astro landing stored a gbraid (shim), then the user lands on the app with ?fbclid=.
    const seeded = encodeURIComponent(JSON.stringify({ gbraid: { v: 'KJAUDIT_GB', ts: 100 } }));

    const shippedWin = open('https://openart.ai/home?fbclid=KJAUDIT_F2');
    shippedWin.jar.seed('oa_ad_clids', seeded);
    shippedWin.window.localStorage.setItem('oa_ad_clids', decodeURIComponent(seeded));
    loadShippedModule(shippedWin).captureAdClickIds();
    const afterShipped = JSON.parse(readCookie(shippedWin.window.document.cookie, 'oa_ad_clids')!);
    expect(afterShipped.gbraid).toBeUndefined(); // the data loss observed live in T2c
    expect(Object.keys(afterShipped)).toEqual(['fbclid']);

    const fixedWin = open('https://openart.ai/home?fbclid=KJAUDIT_F2');
    fixedWin.jar.seed('oa_ad_clids', seeded);
    fixedWin.window.localStorage.setItem('oa_ad_clids', decodeURIComponent(seeded));
    captureAdClickIds(
      { location: fixedWin.window.location, document: fixedWin.window.document, localStorage: fixedWin.window.localStorage },
      { now: 200 },
    );
    const afterFix = parseClickIdStore(readCookie(fixedWin.window.document.cookie, 'oa_ad_clids'));
    expect(afterFix.gbraid).toEqual({ v: 'KJAUDIT_GB', ts: 100 });
    expect(afterFix.fbclid).toEqual({ v: 'KJAUDIT_F2', ts: 200 });
    const cookie = fixedWin.jar.find('oa_ad_clids');
    expect(cookie?.raw).toContain('Max-Age=7776000; Path=/; Domain=.openart.ai; SameSite=Lax; Secure');
  });

  it('writes the same cookie attributes as the shipped writer', () => {
    const shippedWin = open('https://openart.ai/home?gclid=G1');
    loadShippedModule(shippedWin).captureAdClickIds();
    const fixedWin = open('https://openart.ai/home?gclid=G1');
    captureAdClickIds({ location: fixedWin.window.location, document: fixedWin.window.document, localStorage: fixedWin.window.localStorage });
    const a = shippedWin.jar.find('oa_ad_clids')!;
    const b = fixedWin.jar.find('oa_ad_clids')!;
    const attrs = (raw: string) => raw.split('; ').slice(1).join('; ');
    expect(attrs(b.raw)).toBe(attrs(a.raw));
  });
});

describe('parsing and merging', () => {
  it('drops invalid entries, unknown keys and bad JSON without throwing', () => {
    expect(parseClickIdStore('not json')).toEqual({});
    expect(parseClickIdStore(null)).toEqual({});
    expect(parseClickIdStore('[]')).toEqual({});
    expect(
      parseClickIdStore(
        JSON.stringify({
          gclid: { v: 'ok', ts: 1 },
          fbclid: { v: 'has space', ts: 1 },
          msclkid: { v: 'x', ts: 'yesterday' },
          evil: { v: 'x', ts: 1 },
        }),
      ),
    ).toEqual({ gclid: { v: 'ok', ts: 1 } });
  });

  it('keeps the newest entry per key and filters by age', () => {
    const merged = mergeClickIdStores({ gclid: { v: 'old', ts: 1 } }, { gclid: { v: 'new', ts: 5 }, fbclid: { v: 'f', ts: 2 } });
    expect(merged).toEqual({ gclid: { v: 'new', ts: 5 }, fbclid: { v: 'f', ts: 2 } });
    expect(filterByAge(merged, 3, 6)).toEqual({ gclid: { v: 'new', ts: 5 } });
  });

  it('reads click ids from a query string', () => {
    expect(clickIdsFromSearch('?gbraid=A&li_fat_id=B&oppref=C&ref=tolt&gclid=', 7)).toEqual({
      gbraid: { v: 'A', ts: 7 },
      li_fat_id: { v: 'B', ts: 7 },
      oppref: { v: 'C', ts: 7 },
    });
  });
});

describe('first-seen timestamps (review: captureAdClickIds reset ts, the shim kept it)', () => {
  it('captureAdClickIds keeps the first-seen ts for a click id it already stores and restamps only a changed value', () => {
    const t = open('https://openart.ai/home?gclid=G1&fbclid=F_NEW&twclid=X1');
    t.jar.seed('oa_ad_clids', encodeURIComponent(JSON.stringify({ gclid: { v: 'G1', ts: 5 }, fbclid: { v: 'F_OLD', ts: 6 } })));
    const next = captureAdClickIds({ location: t.window.location, document: t.window.document, localStorage: t.window.localStorage }, { now: 1000 });
    const expected = { gclid: { v: 'G1', ts: 5 }, fbclid: { v: 'F_NEW', ts: 1000 }, twclid: { v: 'X1', ts: 1000 } };
    expect(next).toEqual(expected);
    expect(parseClickIdStore(readCookie(t.window.document.cookie, 'oa_ad_clids'))).toEqual(expected);
    expect(parseClickIdStore(t.window.localStorage.getItem('oa_ad_clids'))).toEqual(expected);
  });

  it('keeps the first-seen ts when cookie and localStorage hold the same value with different timestamps', () => {
    const t = open('https://openart.ai/home?gclid=G1');
    t.jar.seed('oa_ad_clids', encodeURIComponent(JSON.stringify({ gclid: { v: 'G1', ts: 50 } })));
    t.window.localStorage.setItem('oa_ad_clids', JSON.stringify({ gclid: { v: 'G1', ts: 10 } }));
    expect(readAdClickIds({ cookie: t.window.document.cookie, localStorage: t.window.localStorage }).gclid).toEqual({ v: 'G1', ts: 10 });
    const next = captureAdClickIds({ location: t.window.location, document: t.window.document, localStorage: t.window.localStorage }, { now: 1000 });
    expect(next?.gclid).toEqual({ v: 'G1', ts: 10 });
  });

  it('mergeClickIdStores: an equal value keeps its earliest ts; a changed value takes the newer entry, whatever the input order', () => {
    expect(mergeClickIdStores({ gclid: { v: 'G', ts: 50 } }, { gclid: { v: 'G', ts: 10 } })).toEqual({ gclid: { v: 'G', ts: 10 } });
    expect(mergeClickIdStores({ gclid: { v: 'A', ts: 1 } }, { gclid: { v: 'B', ts: 2 } })).toEqual({ gclid: { v: 'B', ts: 2 } });
    // Replayed in time order (the edge Worker's rule): A@1 -> B@2 -> A@3 ends on A@3.
    expect(mergeClickIdStores({ gclid: { v: 'A', ts: 1 } }, { gclid: { v: 'A', ts: 3 } }, { gclid: { v: 'B', ts: 2 } })).toEqual({ gclid: { v: 'A', ts: 3 } });
    expect(mergeClickIdStores({ gclid: { v: 'B', ts: 2 } }, { gclid: { v: 'A', ts: 3 } }, { gclid: { v: 'A', ts: 1 } })).toEqual({ gclid: { v: 'A', ts: 3 } });
  });

  it('withIncomingClickId: a fresh URL observation replaces a different value even when the stored ts is ahead (skewed clock)', () => {
    expect(withIncomingClickId({ v: 'OLD', ts: 9_999 }, { v: 'NEW', ts: 100 })).toEqual({ v: 'NEW', ts: 100 });
    expect(withIncomingClickId({ v: 'SAME', ts: 5 }, { v: 'SAME', ts: 100 })).toEqual({ v: 'SAME', ts: 5 });
    expect(withIncomingClickId({ v: 'bad value', ts: 5 }, { v: 'NEW', ts: 100 })).toEqual({ v: 'NEW', ts: 100 });
    expect(withIncomingClickId(undefined, { v: 'NEW', ts: 100 })).toEqual({ v: 'NEW', ts: 100 });
  });
});

describe('checkout hidden inputs', () => {
  it('renders every key (empty when absent), created_at and fbc', () => {
    const inputs = checkoutHiddenInputs({ gbraid: { v: 'GB', ts: 42 } }, { fbc: 'fb.1.1790701395081.KJAUDIT_F' });
    const byName = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
    expect(byName.gclid).toBe('');
    expect(byName.gbraid).toBe('GB');
    expect(byName.gbraid_created_at).toBe('42');
    expect(byName.fbc).toBe('fb.1.1790701395081.KJAUDIT_F');
    expect(inputs).toHaveLength(AD_CLICK_ID_KEYS.length * 2 + 1);
  });

  it('refuses a malformed fbc', () => {
    const byName = Object.fromEntries(checkoutHiddenInputs({}, { fbc: 'fb.1.x.<script>' }).map((i) => [i.name, i.value]));
    expect(byName.fbc).toBe('');
  });
});

describe('Meta fbc helpers', () => {
  it('builds and parses the documented format', () => {
    const fbc = buildFbc('IwAR0Abc', 1790701395081);
    expect(fbc).toBe('fb.1.1790701395081.IwAR0Abc');
    expect(isValidFbc(fbc)).toBe(true);
    expect(fbclidFromFbc(fbc)).toBe('IwAR0Abc');
    expect(fbclidFromFbc('garbage')).toBeUndefined();
    expect(() => buildFbc('bad value', 1)).toThrow();
  });
});
