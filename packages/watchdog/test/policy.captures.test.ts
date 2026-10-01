import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/policy/policy.js';
import { evidencePath, hasEvidence } from './evidence.js';

// Second opinion: the research's own vendor classifier (crawl/teardown2/analyze.cjs), independent
// of the watchdog's rule tables.
const TRACKING = new Set(['meta_tr', 'meta_capig', 'meta_other', 'gads', 'ga4', 'tiktok', 'reddit', 'linkedin', 'bing', 'x', 'amplitude', 'openai', 'clarity', 'hotjar', 'tolt', 'statsig', 'cf_rum', 'impact', 'sentry']);
const SDK_TYPES = new Set(['Script', 'Stylesheet', 'Font']);

describe.skipIf(!hasEvidence)('policy agrees with the research classifier on every saved journey request', () => {
  const req = createRequire(import.meta.url);
  const { vendorOf } = hasEvidence ? req(evidencePath('crawl/teardown2/analyze.cjs')) : { vendorOf: () => '' };
  const files = hasEvidence ? fs.readdirSync(evidencePath('crawl/teardown2')).filter((f) => /^T.*\.json$/.test(f)) : [];

  it('fails every tracking hit and every non-GET; allows every SDK script and first-party render resource', () => {
    const disagreements: string[] = [];
    let n = 0;
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(evidencePath('crawl/teardown2', f), 'utf8'));
      for (const r of d.requests) {
        if (!/^https?:/.test(r.url)) continue;
        n++;
        const v: string = vendorOf(r.url);
        const decision = decide({ url: r.url, method: r.method, resourceType: r.type, isNavigation: r.type === 'Document' }, { markers: ['WD_TEST'] });
        const host = new URL(r.url).hostname;
        let expected: 'allow' | 'fail' | 'either';
        if (r.method !== 'GET') expected = 'fail';
        else if (/viewthroughconversion|facebook\.com\/tr\b|\/collect|adsct|bat\.bing\.com\/action\/|rp\.gif|c\.gif|li_sync|set_partitioned_cookie|openart\.ai\/4vu8\/a\?/.test(r.url)) expected = 'fail'; // /4vu8/a = gateway ping (research 02 §0)
        else if (TRACKING.has(v) && !SDK_TYPES.has(r.type)) expected = /bzrcdn\.openai\.com\/pixel-config/.test(r.url) ? 'allow' : 'fail';
        else if (TRACKING.has(v) && SDK_TYPES.has(r.type)) expected = 'allow';
        else if (/(^|\.)openart\.ai$/.test(host) && ['Document', 'Script', 'Stylesheet', 'Font', 'Image', 'Media'].includes(r.type)) expected = 'allow';
        else expected = 'either';
        if (expected !== 'either' && decision.action !== expected) disagreements.push(`${f} ${r.method} ${r.type} ${r.url.slice(0, 140)} -> ${decision.action} (${decision.reason}) expected ${expected} [research vendor ${v}]`);
      }
    }
    expect(n).toBeGreaterThan(5000);
    expect(disagreements).toEqual([]);
  });
});
