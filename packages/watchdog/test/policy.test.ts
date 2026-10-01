import { describe, expect, it } from 'vitest';
import { decide, allowConnectHost, classifyCollection, isFirstPartyHost } from '../src/policy/policy.js';

const M = ['WD_TEST'];
const req = (url: string, method = 'GET', resourceType = 'Script', extra: Partial<{ headers: Record<string, string>; isNavigation: boolean }> = {}) =>
  decide({ url, method, resourceType, headers: extra.headers, isNavigation: extra.isNavigation }, { markers: M });

// Every URL below was observed in the saved journeys (crawl/teardown2/T*.json, crawl/sealed_evidence/run_*.json).
const COLLECTION: Array<[string, string, string]> = [
  ['https://www.google.com/ccm/collect?en=page_view&dl=https%3A%2F%2Fopenart.ai%2F', 'POST', 'Fetch'],
  ['https://www.google.com/rmkt/collect/11252321380/?en=gtag.config', 'POST', 'Fetch'],
  ['https://www.google.com/pagead/1p-user-list/11252321380/?en=gtag.config', 'GET', 'Image'],
  ['https://www.google.com/pagead/1p-conversion/11252321380/?label=x', 'POST', 'XHR'],
  ['https://googleads.g.doubleclick.net/pagead/viewthroughconversion/11252321380/?en=gtag.config', 'GET', 'Script'],
  ['https://www.googleadservices.com/pagead/conversion/11252321380/?label=OfGcCJisoLQZEOSYw_Up', 'GET', 'XHR'],
  ['https://www.googleadservices.com/pagead/set_partitioned_cookie?gclid=x', 'GET', 'Fetch'],
  ['https://ad.doubleclick.net/ccm/s/collect?gclid=x', 'POST', 'Fetch'],
  ['https://openart.ai/4vu8/as/p/c/11252321380/?random=1&en=conversion', 'POST', 'Fetch'],
  ['https://openart.ai/4vu8/as/d/ccm/conversion/11252321380/?random=1', 'GET', 'Image'],
  ['https://openart.ai/4vu8/d/ccm/form-data/11252321380?gtm=x', 'POST', 'Fetch'],
  ['https://openart.ai/4vu8/_/service_worker/69f0/sw.js?path=%2F4vu8', 'GET', 'Other'],
  ['https://openart.ai/4vu8/a?id=AW-11252321380&v=3&t=t', 'GET', 'Image'],
  ['https://openart.ai/4vu8/g/collect?v=2', 'POST', 'Ping'],
  ['https://www.googletagmanager.com/td?id=GTM-56CMP8K', 'GET', 'Image'],
  ['https://www.googletagmanager.com/static/service_worker/5a41/sw_iframe.html?origin=https%3A%2F%2Fopenart.ai', 'GET', 'Document'],
  ['https://www.facebook.com/tr/', 'POST', 'Document'],
  ['https://www.facebook.com/tr/?id=843671884361709&ev=PageView', 'GET', 'Image'],
  ['https://m6-211026f8a25b42c08fc190458268b30e.ecs.us-east-2.on.aws/events?cee=no', 'POST', 'Fetch'],
  ['https://bded8a3c6ae-1-1053047382554.us-central1.run.app/events', 'POST', 'Fetch'],
  ['https://analytics.tiktok.com/api/v2/pixel', 'POST', 'Ping'],
  ['https://analytics.tiktok.com/api/v2/pixel/act', 'POST', 'Ping'],
  ['https://analytics.tiktok.com/api/v2/monitor', 'POST', 'Ping'],
  ['https://analytics-ipv6.tiktokw.us/ipv6/enrich_ipv6', 'POST', 'Ping'],
  ['https://alb.reddit.com/rp', 'POST', 'Fetch'],
  ['https://alb.reddit.com/rp.gif?event=PageVisit', 'GET', 'Image'],
  ['https://px.ads.linkedin.com/collect?pid=10481401&fmt=js', 'GET', 'Image'],
  ['https://px.ads.linkedin.com/wa/', 'POST', 'Fetch'],
  ['https://www.linkedin.com/px/li_sync?redirect=x', 'GET', 'Image'],
  ['https://t.co/1/i/adsct?txn_id=qwghh', 'GET', 'Image'],
  ['https://analytics.twitter.com/1/i/adsct?txn_id=qwghh', 'GET', 'Image'],
  ['https://t.co/i/adsctp', 'POST', 'Ping'],
  ['https://bat.bing.com/action/0?ti=187107444&evt=pageLoad', 'GET', 'Image'],
  ['https://bat.bing.com/p/conversions/c/n', 'POST', 'XHR'],
  ['https://c.bing.com/c.gif?ctsa=mr', 'GET', 'Image'],
  ['https://api2.amplitude.com/2/httpapi', 'POST', 'Ping'],
  ['https://api2.amplitude.com/2/httpapi', 'OPTIONS', 'Other'],
  ['https://y.clarity.ms/collect', 'POST', 'XHR'],
  ['https://c.clarity.ms/c.gif', 'GET', 'Image'],
  ['https://vc.hotjar.io/sessions/3111505', 'GET', 'XHR'],
  ['https://bzr.openai.com/v1/sdk/events', 'POST', 'Fetch'],
  ['https://openart.ai/cdn-cgi/rum', 'POST', 'XHR'],
  ['https://cloudflareinsights.com/cdn-cgi/rum', 'POST', 'XHR'],
  ['https://prodregistryv2.org/v1/rgstr?k=client-x', 'POST', 'Fetch'],
  ['https://play.google.com/log?format=json', 'POST', 'Fetch'],
  ['https://accounts.google.com/gsi/log?client_id=x', 'POST', 'XHR'],
  ['https://58qr5yci46.execute-api.us-east-1.amazonaws.com/prod/click', 'POST', 'XHR'],
  ['https://api.chargeblast.com/track', 'POST', 'Fetch'],
  ['https://a.nel.cloudflare.com/report/v4?s=x', 'POST', 'Other'],
  ['https://openart.ai/api/user/ad-click-ids', 'POST', 'Fetch'],
  ['https://openart.ai/legacy/api/tracking/impact/store-clickid', 'POST', 'Fetch'],
  ['https://openart.ai/api/analytics/brevo', 'POST', 'Fetch'],
];

const RENDER: Array<[string, string]> = [
  ['https://openart.ai/?utm_source=wd&fbclid=WD_TEST_FBCLID_A', 'Document'],
  ['https://openart.ai/home', 'Document'],
  ['https://openart.ai/_astro/engine.BEmVdjCr.css', 'Stylesheet'],
  ['https://pageforge-56o.pages.dev/_astro/AmplitudeTracker.astro_astro_type_script_index_0_lang.js', 'Script'],
  ['https://openart.ai/suite/_next/static/chunks/04db6f60be063c81.js', 'Script'],
  ['https://openart.ai/suite/_next/static/media/017d9bea37084d9b-s.p.a6d6de71.woff2', 'Font'],
  ['https://cdn.openart.ai/assets/internal/uploads/image_x.webp', 'Image'],
  ['https://cdn.openart.ai/cdn-cgi/media/mode=frame,time=1s/https://cdn.openart.ai/x.mp4', 'Media'],
  ['https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K', 'Script'],
  ['https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K&gtg_health=1', 'Script'],
  ['https://www.googletagmanager.com/gtag/js?id=AW-11252321380', 'Script'],
  ['https://openart.ai/4vu8/', 'Script'],
  ['https://openart.ai/4vu8/C_mYUAFo3ktMtwbOA2KWC5ag7fQzy1xc1dbYrTQHn3aW09QJqxM', 'Script'],
  ['https://connect.facebook.net/en_US/fbevents.js', 'Script'],
  ['https://connect.facebook.net/signals/config/843671884361709?v=2.9.410&r=stable&domain=openart.ai', 'Script'],
  ['https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=D9QOQ5JC77U6RO6J21IG&lib=ttq', 'Script'],
  ['https://analytics.tiktok.com/i18n/pixel/static/main.MWU2MzIzODM0MQ.js', 'Script'],
  ['https://bat.bing.com/p/action/187107444.js', 'Script'],
  ['https://bat.bing.com/p/conversions/t/187107444?insights=1', 'Script'],
  ['https://bat.bing.net/bat.js', 'Script'],
  ['https://snap.licdn.com/li.lms-analytics/insight.min.js', 'Script'],
  ['https://static.ads-twitter.com/uwt.js', 'Script'],
  ['https://www.redditstatic.com/ads/pixel.js?pixel_id=a2_j6xo78gpljnf', 'Script'],
  ['https://bzrcdn.openai.com/sdk/oaiq.min.js', 'Script'],
  ['https://www.clarity.ms/tag/mpzpphbogv?ref=gtm2', 'Script'],
  ['https://scripts.clarity.ms/0.8.70/clarity.js', 'Script'],
  ['https://static.hotjar.com/c/hotjar-3111505.js?sv=6', 'Script'],
  ['https://script.hotjar.com/modules.e762be2b6b709245aabb.js', 'Script'],
  ['https://cdn.tolt.io/tolt.js', 'Script'],
  ['https://cdn.cgb.la/v1/scripts.js', 'Script'],
  ['https://cdn.jsdelivr.net/npm/psl/dist/psl.min.js', 'Script'],
  ['https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495', 'Script'],
  ['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', 'Script'],
  ['https://fonts.googleapis.com/css2?family=Inter', 'Stylesheet'],
  ['https://fonts.gstatic.com/s/inter/v20/x.woff2', 'Font'],
  ['https://clerk.openart.ai/npm/@clerk/clerk-js@5/dist/clerk.browser.js', 'Script'],
  ['https://i18n.openart.ai/sdk.js?key=ebe59d17d54e4c4df8b69eae333003cd', 'Script'],
  ['https://api.iconify.design/ri:claude-fill.svg', 'Image'],
];

describe('collection seal request policy', () => {
  it.each(COLLECTION)('fails and labels the collection hit %s (%s %s)', (url, method, type) => {
    const d = req(url, method, type);
    expect(d.action).toBe('fail');
    expect(d.collection).toBe(true);
  });

  it.each(RENDER)('continues the rendering resource %s (%s)', (url, type) => {
    const d = req(url, 'GET', type, { isNavigation: type === 'Document' });
    expect(d.action, d.reason).toBe('allow');
    expect(d.collection).toBe(false);
  });

  it('allows first-party config/RSC GETs the Suite needs for soft navigations', () => {
    expect(req('https://openart.ai/suite/home?_rsc=abc', 'GET', 'Fetch').action).toBe('allow');
    expect(req('https://openart.ai/suite/api/ip', 'GET', 'Fetch').action).toBe('allow');
    expect(req('https://clerk.openart.ai/v1/environment?__clerk_api_version=2025-11-10', 'GET', 'Fetch').action).toBe('allow');
    expect(req('https://bzrcdn.openai.com/pixel-config/v1/MCEntnyMVfgRfepXXsrQLE.json', 'GET', 'Fetch').action).toBe('allow');
  });

  it('fails every non-GET request, first- or third-party', () => {
    expect(req('https://openart.ai/suite/api/anything', 'POST', 'Fetch').action).toBe('fail');
    expect(req('https://openart.ai/4vu8/C_mYUAFo3ktMtwbOA2KWC5ag7fQzy1xc1dbYrTQHn3aW09QJqxM', 'POST', 'Fetch').action).toBe('fail');
    expect(req('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow/ov1', 'POST', 'XHR').action).toBe('fail');
    expect(req('https://openart.ai/home', 'HEAD', 'Other').action).toBe('fail');
  });

  it('never lets a synthetic marker travel to a third party', () => {
    const d = req('https://static.ads-twitter.com/uwt.js?u=WD_TEST_FBCLID_A', 'GET', 'Script');
    expect(d.action).toBe('fail');
    expect(d.reason).toMatch(/marker/);
    const ref = req('https://static.ads-twitter.com/uwt.js', 'GET', 'Script', { headers: { Referer: 'https://openart.ai/?fbclid=WD_TEST_FBCLID_A' } });
    expect(ref.action).toBe('fail');
    // a third-party iframe document with the marker is failed too
    expect(req('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x?u=WD_TEST_A', 'GET', 'Document').action).toBe('fail');
  });

  it('lets markers reach openart.ai only on navigations and Next.js RSC fetches', () => {
    expect(req('https://openart.ai/arena?utm_campaign=WD_TEST_UTM_A&_rsc=1', 'GET', 'Fetch').action).toBe('allow');
    expect(req('https://openart.ai/suite/api/whatever?fbclid=WD_TEST_FBCLID_A', 'GET', 'Fetch').action).toBe('fail');
    expect(req('https://openart.ai/suite/x', 'GET', 'Fetch', { headers: { RSC: '1', Referer: 'https://openart.ai/?fbclid=WD_TEST_A' } }).action).toBe('allow');
  });

  it('default-denies unknown third-party hosts and third-party XHR', () => {
    expect(req('https://unknown-tracker.example.net/p.js', 'GET', 'Script').action).toBe('fail');
    expect(req('https://sr-client-cfg.amplitude.com/config/3e2fda7a5cbcc867099904a028486db4', 'GET', 'Fetch').action).toBe('fail');
    expect(req('https://accounts.google.com/gsi/status?client_id=x', 'GET', 'XHR').action).toBe('fail');
    expect(req('https://accounts.google.com/gsi/client', 'GET', 'Script').action).toBe('fail'); // One Tap not needed; Chrome background host
    expect(allowConnectHost('accounts.google.com', 443)).toBe(false);
    expect(allowConnectHost('www.gstatic.com', 443)).toBe(false);
    expect(req('https://api.ipify.org/?format=json', 'GET', 'Fetch').action).toBe('fail');
    expect(req('https://analytics.tiktok.com/i18n/pixel/static/main.js', 'GET', 'XHR').action).toBe('fail');
  });

  it('denies service-worker script loads (a SW would move hits out of the page targets)', () => {
    expect(req('https://openart.ai/suite/favicon.ico', 'GET', 'Other').action).toBe('allow'); // allowlisted first-party icon
    expect(req('https://openart.ai/sw.js', 'GET', 'Other', { headers: { 'Service-Worker': 'script' } }).action).toBe('fail');
    expect(req('https://openart.ai/4vu8/_/service_worker/69f0/sw.js?path=%2F4vu8', 'GET', 'Script').action).toBe('fail');
  });

  it('classifies collection endpoints to a platform', () => {
    expect(classifyCollection(new URL('https://www.google.com/ccm/collect'), 'POST', 'Fetch')?.platform).toBe('google_ads');
    expect(classifyCollection(new URL('https://m6-x.ecs.us-east-2.on.aws/events'), 'POST', 'Fetch')?.platform).toBe('meta');
    expect(classifyCollection(new URL('https://t.co/1/i/adsct'), 'GET', 'Image')?.platform).toBe('x');
    expect(classifyCollection(new URL('https://openart.ai/home'), 'GET', 'Document')).toBeNull();
  });

  it('tunnels FIRST-PARTY hosts only (the proxy layer); third-party SDKs come from the watchdog fetch', () => {
    for (const h of ['openart.ai', 'cdn.openart.ai', 'clerk.openart.ai', 'i18n.openart.ai']) expect(allowConnectHost(h, 443), h).toBe(true);
    for (const h of ['www.googletagmanager.com', 'connect.facebook.net', 'analytics.tiktok.com', 'bat.bing.com', 'fonts.gstatic.com', 'pageforge-56o.pages.dev', 'www.google.com', 'www.facebook.com', 'alb.reddit.com', 'px.ads.linkedin.com', 't.co', 'analytics.twitter.com', 'api2.amplitude.com', 'bzr.openai.com', 'm6-211026f8a25b42c08fc190458268b30e.ecs.us-east-2.on.aws', 'c.bing.com', 'googleads.g.doubleclick.net', 'www.googleadservices.com', 'a.nel.cloudflare.com', 'beacons.gcp.gvt2.com', 'mtalk.google.com', 'example.com', 'openart.ai.evil.com']) {
      expect(allowConnectHost(h, 443), h).toBe(false);
    }
    expect(allowConnectHost('127.0.0.1', 51234, { extraHosts: [/^127\.0\.0\.1$/] })).toBe(true);
    expect(allowConnectHost('openart.ai', 22)).toBe(false);
    expect(req('https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K', 'GET', 'Script').transport).toBe('node');
    expect(req('https://connect.facebook.net/en_US/fbevents.js', 'GET', 'Script').transport).toBe('node');
    expect(req('https://openart.ai/_astro/index.abc.js', 'GET', 'Script').transport).toBe('tunnel');
  });

  it('allows first-party subresources only from the allowlist (unknown = failed and reported)', () => {
    const ok = (u: string, type: string, headers?: Record<string, string>) => expect(req(u, 'GET', type, headers ? { headers } : {}).action, u).toBe('allow');
    const unlisted = (u: string, type: string) => expect(req(u, 'GET', type).reason, u).toBe('first-party-unlisted');
    ok('https://openart.ai/suite/_next/static/chunks/abc.js', 'Script');
    ok('https://openart.ai/_astro/x.css', 'Stylesheet');
    ok('https://openart.ai/pageforge-assets/openart-home/hero.webp', 'Image');
    ok('https://cdn.openart.ai/production/2025-01/uploads/x/y.mp4', 'Media');
    ok('https://cdn.openart.ai/cdn-cgi/image/format=auto,width=640/https://cdn.openart.ai/a.webp', 'Image');
    ok('https://openart.ai/4vu8/', 'Script');
    ok('https://clerk.openart.ai/v1/client?__clerk_api_version=2025-11-10', 'XHR');
    ok('https://openart.ai/suite/api/model-availability', 'Fetch');
    ok('https://openart.ai/suite/create-image', 'Fetch', { RSC: '1', 'Next-Router-Prefetch': '1' });
    unlisted('https://openart.ai/suite/api/unknown-endpoint', 'Fetch');
    unlisted('https://pixel.openart.ai/p.gif?e=pageview', 'Image');
    unlisted('https://openart.ai/p.gif?e=pageview&u=1', 'Image');
    unlisted('https://openart.ai/_astro/%2e%2e%2fapi%2fcollect', 'Script');
    expect(req('https://openart.ai/suite/api/ip', 'GET', 'EventSource').reason).toBe('first-party-unlisted');
    expect(req('https://openart.ai/suite/api/ip?fbclid=WD_TEST_FBCLID_X', 'GET', 'Fetch').reason).toBe('synthetic-marker-in-first-party-subresource');
  });

  it('catches collection paths through host aliases, encodings and plurals', () => {
    for (const u of ['https://www.openart.ai/4vu8/g/collect?v=2', 'https://openart.ai/%34vu8/g/collect?v=2', 'https://openart.ai//4vu8/g/collect', 'https://openart.ai/api/logs', 'https://openart.ai/api/event', 'https://openart.ai/suite/api/events/batch', 'https://openart.ai/ingest/e/', 'https://openart.ai/api/collect?e=pageview']) {
      const d = req(u, 'GET', 'XHR');
      expect(d.action, u).toBe('fail');
      expect(d.collection, u).toBe(true);
    }
    expect(req('https://openart.ai/4vu8/gtm.js?id=GTM-56CMP8K', 'GET', 'Script').action).toBe('allow');
    expect(req('https://user:pw@openart.ai/', 'GET', 'Document').reason).toBe('credentials-in-url');
  });

  it('knows first-party hosts', () => {
    expect(isFirstPartyHost('openart.ai')).toBe(true);
    expect(isFirstPartyHost('cdn.openart.ai')).toBe(true);
    expect(isFirstPartyHost('openart.ai.evil.com')).toBe(false);
  });
});
