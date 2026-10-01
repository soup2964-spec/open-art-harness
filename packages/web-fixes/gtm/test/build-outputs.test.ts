// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWindow, runClassicScript, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import { bundle } from '../../scripts/build';
import { parseClickIdStore, readCookie } from '../../app-patches/src/click-id-keys';

const BUNDLES = [
  ['shim/src/entry.ts', '../../shim/dist/openart-click-id-shim.min.js'],
  ['consent/src/entry.ts', '../../consent/dist/openart-consent-defaults.min.js'],
  ['hubspot/src/entry.ts', '../../hubspot/dist/openart-hubspot-fill.min.js'],
  ['scripts/proof-inject.entry.ts', '../proof/inject_web_fixes.min.js'],
] as const;

const opened: TestWindow[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe('committed bundles', () => {
  it('match a fresh esbuild of their entries', async () => {
    for (const [entry, file] of BUNDLES) {
      const committed = readFixture(import.meta.url, file);
      const banner = committed.split('\n')[0]!;
      expect(await bundle(entry, banner), entry).toBe(committed);
    }
  });

  it('contain no console calls and stay small', () => {
    for (const [, file] of BUNDLES) {
      const code = readFixture(import.meta.url, file);
      expect(code).not.toMatch(/console\./);
      expect(code.length).toBeLessThan(20_000);
    }
  });
});

describe('shim/dist/openart-click-id-shim.min.js as a page script', () => {
  it('behaves like runClickIdShim on a paid landing', () => {
    const t = createTestWindow({ url: 'https://openart.ai/?gclid=G1&gbraid=GB1&fbclid=F1&oppref=O1&utm_source=ig' });
    opened.push(t);
    const posts: unknown[] = [];
    (t.window as unknown as { fetch: unknown }).fetch = (...a: unknown[]) => {
      posts.push(a);
      return Promise.resolve();
    };
    runClassicScript(t.window, readFixture(import.meta.url, '../../shim/dist/openart-click-id-shim.min.js'));
    const store = parseClickIdStore(readCookie(t.window.document.cookie, 'oa_ad_clids'));
    expect(Object.keys(store).sort()).toEqual(['fbclid', 'gbraid', 'gclid', 'oppref']);
    expect(t.jar.find('_fbc')?.value).toMatch(/^fb\.1\.\d{13}\.F1$/);
    expect(readCookie(t.window.document.cookie, '__oppref')).toBe('O1');
    expect(t.window.document.getElementById('tolt-referral')).not.toBeNull();
    expect((t.window as unknown as { oaClickIdShim: { version: string } }).oaClickIdShim.version).toBe('2.0.0');
    expect(posts).toEqual([]); // no im_ref: no Impact POST
  });
});

describe('gtm/proof/inject_web_fixes.min.js (watchdog --inject-script)', () => {
  it('pushes consent defaults before anything else, then runs the shim and the stand-ins', () => {
    const t = createTestWindow({ url: 'https://openart.ai/?fbclid=F1' });
    opened.push(t);
    runClassicScript(t.window, readFixture(import.meta.url, '../proof/inject_web_fixes.min.js'));
    const dl = (t.window as unknown as { dataLayer: unknown[] }).dataLayer;
    expect(Object.prototype.toString.call(dl[0])).toBe('[object Arguments]');
    expect(Array.from(dl[0] as IArguments).slice(0, 2)).toEqual(['consent', 'default']);
    expect((Array.from(dl[0] as IArguments)[2] as { region: string[] }).region).toContain('DE');
    expect(t.jar.find('_fbc')).toBeDefined();
    expect((t.window as unknown as Record<string, unknown>).__oaPageViewContract).toBe('app');
  });
});
