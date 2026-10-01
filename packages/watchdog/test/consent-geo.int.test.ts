// Hermetic proof that the consent probes' geo simulation drives Google's own region matching:
// the saved Google tag config (the code OpenArt serves, research raw/static/gtag_AW-11252321380.js)
// is served from a LOOPBACK server with rewriteGeo() applied, behind a region-scoped consent
// default for DE/GB/CH. Every Google request is failed by the collection seal (nothing leaves).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SealedSession } from '../src/browser/harness.js';
import { rewriteGeo } from '../src/container/parse.js';
import { appliedDefaultRegions } from '../src/contract.js';
import { decodeAll } from '../src/vendors/decode.js';
import { evidencePath, hasEvidence } from './evidence.js';

const CHROME = process.env.WATCHDOG_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const run = fs.existsSync(CHROME) && hasEvidence;
const PAGE = `<html><head><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',region:['DE','GB','CH']});
gtag('js', new Date()); gtag('config','AW-11252321380');</script><script async src="/gtag.js"></script></head><body>x</body></html>`;

let server: http.Server;
let port = 0;
let body = '';
const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-geo-profiles-'));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': req.url?.startsWith('/gtag.js') ? 'text/javascript' : 'text/html' });
    res.end(req.url?.startsWith('/gtag.js') ? body : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(profilesDir, { recursive: true, force: true });
});

async function probe(country: string | null, region = '') {
  const gtag = fs.readFileSync(evidencePath('raw/static/gtag_AW-11252321380.js'), 'utf8');
  body = country ? rewriteGeo(gtag, country, region) : gtag;
  const s = await SealedSession.launch({
    name: 'geo', profilesDir, chromePath: CHROME, device: 'desktop', captureLoaders: false, allowConnect: (h) => h === '127.0.0.1',
    intercept: { policy: { markers: ['WD_TEST'], extraHosts: [/^127\.0\.0\.1$/] }, isPatchHost: () => false, patches: {} },
  });
  let state: unknown = null;
  try {
    await s.goto(`http://127.0.0.1:${port}/page`, 'page');
    await new Promise((r) => setTimeout(r, 4000));
    state = await s.evaluate(`(function(){var g=window.google_tag_data&&window.google_tag_data.ics;if(!g||!g.entries)return null;var o={};Object.keys(g.entries).forEach(function(k){var x=g.entries[k];o[k]={region:x.region,default:x.default};});return o;})()`);
  } finally {
    await s.close();
  }
  const letters = new Set(decodeAll(s.state.requests).filter((h) => h.consent?.decoded).map((h) => h.consent!.decoded!.ad_storage!.letter));
  return { letters, applied: appliedDefaultRegions(state), geoFetch: s.state.requests.some((r) => /ccm\/geo/.test(r.url)) };
}

describe.skipIf(!run)("consent geo simulation on Google's real tag code (loopback, sealed)", () => {
  it('US visitor: the DE/GB/CH-scoped default does not apply', async () => {
    const r = await probe(null);
    expect(r.letters).toEqual(new Set(['l']));
    expect(r.applied).toEqual([]);
  });
  it('rewritten to DE / GB: that region\'s default applies (denied → gcd letter p)', async () => {
    for (const [c, sub] of [['DE', 'DE-BE'], ['GB', 'GB-ENG']] as const) {
      const r = await probe(c, sub);
      expect(r.geoFetch, c).toBe(false);
      expect(r.letters, c).toEqual(new Set(['p']));
      expect(r.applied, c).toContain(`ad_storage=denied@${c}`);
    }
  });
  it('rewritten to FR (not declared): no default applies', async () => {
    const r = await probe('FR', 'FR-IDF');
    expect(r.letters).toEqual(new Set(['l']));
    expect(r.applied).toEqual([]);
  });
});
