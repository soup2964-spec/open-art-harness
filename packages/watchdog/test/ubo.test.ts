import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UboEngine, parseFilter, preprocess, registrableDomain } from '../src/ubo/engine.js';
import { evidencePath, FIXTURES, hasEvidence, readJson } from './evidence.js';

describe('filter parsing (unit)', () => {
  const eng = new UboEngine([
    [
      '||tracker.example^',
      '||cdn.example/ads/*$script,3p',
      '@@||cdn.example/ads/ok.js$script',
      '/^https:\\/\\/(www\\.)?[a-z0-9-]+\\.[a-z]+(\\.[a-z]+)?\\/[a-z0-9]{4}\\/$/$script,1p',
      '||important.example^$important',
      '@@||important.example^',
      '||bad.example^',
      '||bad.example^$badfilter',
      '$removeparam=gclid',
      '$removeparam=/^utm_x=/',
      '@@||keep.example^$removeparam=gclid',
      '/adsct?',
      '0.0.0.0 hosts.example',
      'plainhost.example',
      '##.ad-banner',
      '!#if env_firefox',
      '||firefox-only.example^',
      '!#endif',
    ].join('\n'),
  ]);
  const m = (url: string, type: any = 'script', src = 'https://site.example/') => eng.match({ url, type, sourceUrl: src }).blocked;

  it('anchors, types, party and exceptions', () => {
    expect(m('https://sub.tracker.example/p.gif', 'image')).toBe(true);
    expect(m('https://tracker.example.evil.test/p.gif', 'image')).toBe(false);
    expect(m('https://cdn.example/ads/x.js')).toBe(true);
    expect(m('https://cdn.example/ads/x.js', 'image')).toBe(false);
    expect(m('https://cdn.example/ads/ok.js')).toBe(false);
    expect(m('https://t.co/1/i/adsct?x=1', 'image')).toBe(true);
  });
  it('regex filters with $1p (the uBO rule that blocks /4vu8/)', () => {
    expect(m('https://openart.ai/4vu8/', 'script', 'https://openart.ai/')).toBe(true);
    expect(m('https://openart.ai/4vu8/C_mYUAFo3ktMtwbOA2KWC5ag7fQzy1xc1dbYrTQHn3aW09QJqxM', 'script', 'https://openart.ai/')).toBe(false);
    expect(m('https://openart.ai/4vu8/', 'script', 'https://other.example/')).toBe(false);
  });
  it('$important beats exceptions; $badfilter disables; hosts lines; preprocessor', () => {
    expect(m('https://important.example/x', 'image')).toBe(true);
    expect(m('https://bad.example/x', 'image')).toBe(false);
    expect(m('https://hosts.example/x', 'image')).toBe(true);
    expect(m('https://plainhost.example/x', 'image')).toBe(true);
    expect(m('https://firefox-only.example/x', 'image')).toBe(false);
    expect(preprocess('!#if !env_firefox\na\n!#else\nb\n!#endif').filter(Boolean)).toEqual(['a']);
    expect(parseFilter('##.ad')).toBeNull();
    expect(parseFilter('||x.example^$csp=script-src none')).toBeNull();
  });
  it('removeparam with exceptions', () => {
    expect(eng.removeParams('https://a.example/?gclid=1&utm_x=2&keep=3', 'https://a.example/')).toMatchObject({ url: 'https://a.example/?keep=3', removed: ['gclid', 'utm_x'] });
    expect(eng.removeParams('https://keep.example/?gclid=1', 'https://keep.example/').removed).toEqual([]);
  });
  it('registrable domains', () => {
    expect(registrableDomain('www.google.co.uk')).toBe('google.co.uk');
    expect(registrableDomain('pageforge-56o.pages.dev')).toBe('pageforge-56o.pages.dev');
    expect(registrableDomain('cdn.openart.ai')).toBe('openart.ai');
  });
});

describe.skipIf(!hasEvidence)('uBO default lists (crawl/teardown2/blocklists)', () => {
  const eng = hasEvidence ? UboEngine.fromDirectory(evidencePath('crawl/teardown2/blocklists')) : (null as unknown as UboEngine);

  it('parses the default lists', () => {
    expect(eng.stats.network).toBeGreaterThan(50_000);
  });

  it("reproduces research/01 T7's endpoint verdicts", () => {
    const b = (url: string, type: any, src = 'https://openart.ai/home') => eng.match({ url, type, sourceUrl: src }).blocked;
    expect(b('https://openart.ai/4vu8/', 'script')).toBe(true);
    expect(b('https://openart.ai/4vu8/C_mYUAFo3ktMtwbOA2KWC5ag7fQzy1xc1dbYrTQHn3aW09QJqxM', 'script')).toBe(false);
    expect(b('https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K', 'script')).toBe(true);
    expect(b('https://connect.facebook.net/en_US/fbevents.js', 'script')).toBe(true);
    expect(b('https://api2.amplitude.com/2/httpapi', 'xmlhttprequest')).toBe(true);
    expect(b('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=D9QOQ5JC77U6RO6J21IG', 'script')).toBe(true);
    expect(b('https://m6-211026f8a25b42c08fc190458268b30e.ecs.us-east-2.on.aws/events?cee=no', 'xmlhttprequest')).toBe(false);
    expect(b('https://openart.ai/suite/api/user/ad-click-ids', 'xmlhttprequest')).toBe(false);
    expect(b('https://prodregistryv2.org/v1/rgstr?k=client-x', 'xmlhttprequest')).toBe(false);
    expect(b('https://openart.ai/home', 'document', 'https://openart.ai/home')).toBe(false);
  });

  it('strips exactly the click IDs research/01 T7(c) lists, before the page sees them', () => {
    const r = eng.removeParams('https://openart.ai/?utm_source=a&utm_campaign=b&gclid=1&gbraid=2&wbraid=3&fbclid=4&ttclid=5&msclkid=6&twclid=7&rdt_cid=8&li_fat_id=9&oppref=10', 'https://openart.ai/');
    expect(r.removed.sort()).toEqual(['fbclid', 'gbraid', 'gclid', 'msclkid', 'ttclid', 'twclid', 'wbraid']);
    expect(new URL(r.url).searchParams.get('rdt_cid')).toBe('8');
    expect(new URL(r.url).searchParams.get('li_fat_id')).toBe('9');
    expect(new URL(r.url).searchParams.get('oppref')).toBe('10');
    expect(new URL(r.url).searchParams.get('utm_campaign')).toBe('b');
  });

  it('agrees with the @ghostery/adblocker oracle on every distinct saved journey request', () => {
    const oracle = readJson(path.join(FIXTURES, 'ubo-oracle.json')).cases as Array<{ url: string; type: any; sourceUrl: string; block: boolean; filter: string | null }>;
    const mismatches = oracle
      .map((c) => ({ c, mine: eng.match({ url: c.url, type: c.type, sourceUrl: c.sourceUrl }) }))
      .filter(({ c, mine }) => mine.blocked !== c.block)
      .map(({ c, mine }) => `${c.type} ${c.url.slice(0, 120)} ghostery=${c.block ? 'BLOCK ' + c.filter : 'allow'} mine=${mine.blocked ? 'BLOCK ' + mine.filter : 'allow'}`);
    expect(oracle.length).toBeGreaterThan(500);
    expect(mismatches).toEqual(KNOWN_DIFFERENCES);
  });
});

// Documented semantic differences between @ghostery/adblocker and uBlock Origin (kept empty unless justified).
//  1. Meta's /tr/ form POST targets a hidden IFRAME; the oracle script labelled it a main frame
//     because its capture recorded docURL === url. uBO only strict-blocks a main frame for
//     pure-hostname or $document filters, so `||facebook.com^/tr/` does not apply to a main frame;
//     as the subdocument it really is, the engine blocks it (asserted below).
const KNOWN_DIFFERENCES: string[] = ['document https://www.facebook.com/tr/ ghostery=BLOCK ||facebook.com^/tr/ mine=allow'];

describe.skipIf(!hasEvidence)('known-difference guard', () => {
  it('blocks the Meta /tr/ iframe POST as a subdocument', () => {
    const eng = UboEngine.fromDirectory(evidencePath('crawl/teardown2/blocklists'));
    expect(eng.match({ url: 'https://www.facebook.com/tr/', type: 'subdocument', sourceUrl: 'https://openart.ai/home' }).blocked).toBe(true);
  });
});

import { canonicalFilterKey } from '../src/ubo/engine.js';
describe('filter parsing regressions (review findings)', () => {
  it('a path filter that starts with "/" keeps its options (it is not a regex filter)', () => {
    const f = parseFilter('/analytics/analytics.$~xmlhttprequest,3p')!;
    expect(f.party).toBe('3p');
    expect([...f.notTypes]).toEqual(['xmlhttprequest']);
    const eng = new UboEngine(['/analytics/analytics.$~xmlhttprequest,3p']);
    expect(eng.match({ url: 'https://cdn.example/analytics/analytics.js', type: 'script', sourceUrl: 'https://site.example/' }).blocked).toBe(true);
    expect(eng.match({ url: 'https://cdn.example/analytics/analytics.js', type: 'xmlhttprequest', sourceUrl: 'https://site.example/' }).blocked).toBe(false);
    expect(parseFilter('/banner\\d+/$image')!.re!.source).toBe('banner\\d+');
  });
  it('partial-label host anchors are matched through the token index, not an unreachable host key', () => {
    for (const [filter, url] of [['||google.*/pagead/lvz?', 'https://www.google.com/pagead/lvz?x=1'], ['||ads*.x.com^', 'https://ads-api.x.com/1'], ['||discord-nitro.$all', 'https://discord-nitro.example/']] as Array<[string, string]>) {
      const f = parseFilter(filter)!;
      expect(f.indexHost, filter).toBeNull();
      expect(new UboEngine([filter]).match({ url, type: 'script', sourceUrl: 'https://site.example/' }).blocked, filter).toBe(true);
    }
    expect(parseFilter('||example.com^')!.indexHost).toBe('example.com');
  });
  it('$badfilter disables its target regardless of option aliases and order', () => {
    expect(canonicalFilterKey('||sumo.com^$3p,badfilter')).toBe(canonicalFilterKey('||sumo.com^$third-party'));
    expect(canonicalFilterKey('||x.com^$script,domain=b.com|a.com')).toBe(canonicalFilterKey('||x.com^$from=a.com|b.com,script'));
    const eng = new UboEngine(['||sumo.com^$third-party', '||sumo.com^$3p,badfilter']);
    expect(eng.match({ url: 'https://sumo.com/x.js', type: 'script', sourceUrl: 'https://site.example/' }).blocked).toBe(false);
  });
});
