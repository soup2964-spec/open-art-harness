// Derives the committed test fixtures from the saved 2026-09-29 evidence so unit tests run without
// the (large, local-only) research tree. Deterministic: re-running produces identical files, and
// test/fixtures.provenance.test.ts re-derives and compares whenever the evidence is present.
//
//   OPENART_EVIDENCE_DIR=/path/to/openart_2026-09-29 npx tsx scripts/build-fixtures.ts
//
// Privacy: the logged-in captures (crawl/loggedin) come from a real account session, so only a
// whitelist of non-identifying fields survives (event names, endpoint paths, consent strings).
// The teardown2 / sealed_evidence captures are anonymous sessions with synthetic KJAUDIT_/SEALTEST
// markers; they keep request URLs and bodies of collection hits only.
import fs from 'node:fs';
import path from 'node:path';
import { classifyCollection } from '../src/policy/policy.js';

const EVIDENCE: string = process.env.OPENART_EVIDENCE_DIR ?? (() => { throw new Error('Set OPENART_EVIDENCE_DIR to the saved openart_2026-09-29 research directory'); })();
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'fixtures');

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const isCollection = (url: string, method = 'GET', type = 'Other') => {
  try {
    return !!classifyCollection(new URL(url), method, type);
  } catch {
    return false;
  }
};
const FP_COOKIES = /^(_fbc|_fbp|fbclid|gclid|gbraid|wbraid|msclkid|rdt_cid|ttclid|oa_ad_clids|_gcl_aw|_gcl_gb|_gcl_ag|_gcl_gs|_gcl_dc|_gcl_au|_uetmsclkid|_rdt_cid|li_fat_id|_twclid|__oppref|__obref|country_code|oa_device_id|_ga)$/;

export function deriveTeardown(file: string) {
  const d = readJson(file);
  return {
    meta: { scenario: d.meta.scenario, source: 'crawl/teardown2/' + path.basename(file), opts: { mobile: !!d.meta.opts?.mobile, ua: d.meta.opts?.ua ?? null, blockedURLs: d.meta.opts?.blockedURLs ?? null } },
    steps: d.steps.map((s: any) => ({
      label: s.label,
      href: s.state?.href ?? null,
      referrer: s.state?.referrer ?? null,
      cookies: (s.cookies || [])
        .filter((c: any) => /openart\.ai$/.test(String(c.domain || '')) && FP_COOKIES.test(c.name))
        .map((c: any) => ({ name: c.name, value: String(c.value), domain: c.domain })),
      ls: Object.fromEntries(Object.entries(s.state?.ls || {}).filter(([k]) => /^(oa_ad_clids|_gcl_ls|_uetmsclkid|multiFbc)$/.test(k))),
      overlay: s.overlay ?? null,
      handoff: s.handoff ? { hintCount: s.handoff.hintCount, href: s.handoff.href } : null,
      click: s.click ? { found: !!s.click.found, nav: s.click.nav ?? null, after: s.click.after ?? null } : null,
    })),
    requests: d.requests
      .filter((r: any) => isCollection(r.url, r.method, r.type))
      .map((r: any) => ({ step: r.step, t: r.t, url: r.url, method: r.method, type: r.type, postData: r.postData && r.postData.length < 60000 ? r.postData : null, postDataB64Raw: r.postDataB64Raw && r.postDataB64Raw.length < 60000 ? r.postDataB64Raw : null })),
  };
}

export function deriveSealed(file: string) {
  const d = readJson(file);
  return {
    meta: { runName: d.meta.runName, pageUrl: d.meta.pageUrl, setName: d.meta.setName, source: 'crawl/sealed_evidence/' + path.basename(file) },
    timeline: d.timeline.map((t: any) => ({ scenario: t.scenario, desc: t.desc, start: t.start, end: t.end })),
    captures: d.captures
      .filter((c: any) => /^S\d/.test(c.scenario) && isCollection(c.url, c.method, c.resourceType))
      .map((c: any) => ({ scenario: c.scenario, t: c.t, url: c.url, method: c.method, resourceType: c.resourceType, postData: c.postData ?? null, postDataEntriesB64: c.postDataEntriesB64 ?? null, failRequest: c.failRequest })),
  };
}

// ---- logged-in derivatives: whitelist only ----
const G_KEEP = ['en', 'tid', 'gcd', 'gcs', 'dma', 'npa', 'label'];
function sanitizeLoggedIn(r: any) {
  const u = new URL(r.url);
  const host = u.hostname;
  const keepQ: Record<string, string> = {};
  const keys = /google|doubleclick|4vu8/.test(host + u.pathname) ? G_KEEP : ['ev', 'evt', 'spa', 'event', 'events', 'txn_id', 'conversionId', 'pid', 'fmt', 'time', 'liSync', 'ti', 'mid', 'event_id'];
  for (const k of keys) if (u.searchParams.has(k)) keepQ[k] = String(u.searchParams.get(k));
  // Keep only the page PATH of dl-style params (no query strings from the account session).
  const url = `${u.protocol}//${host}${u.pathname}${Object.keys(keepQ).length ? '?' + new URLSearchParams(keepQ).toString() : ''}`;
  let postData: string | null = null;
  const body = r.postData;
  if (body) {
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j?.events)) postData = JSON.stringify({ events: j.events.map((e: any) => ({ event_type: e.event_type, insert_id: e.insert_id, type: e.type, id: e.id })) });
      else if (j?.event_name) postData = JSON.stringify({ event_name: j.event_name, event_id: j.event_id });
      else if (j?.event) postData = JSON.stringify({ event: j.event, message_id: j.message_id, event_id: j.event_id });
      else if (j?.metric_name) postData = JSON.stringify({ metric_name: j.metric_name });
    } catch {
      try {
        const f = new URLSearchParams(body);
        const keep: Record<string, string> = {};
        for (const k of ['ev', 'eid', 'event', 'ts', 'id']) if (f.has(k)) keep[k] = String(f.get(k));
        postData = Object.keys(keep).length ? new URLSearchParams(keep).toString() : null;
      } catch {
        postData = null;
      }
    }
  }
  return { step: r.step, t: r.t ?? 0, url, method: r.method, type: r.type ?? (r.method === 'POST' ? 'Fetch' : 'Image'), postData };
}

export function deriveSpa(file: string) {
  const d = readJson(file);
  return {
    meta: { source: 'crawl/loggedin/pages/' + path.basename(file) + ' (sanitised: event names / endpoint paths only)' },
    navLog: (d.navLog || []).map((n: any) => ({ step: n.step, kind: n.kind, path: new URL(n.url).pathname })),
    requests: d.requests.filter((r: any) => /^https?:/.test(r.url) && isCollection(r.url, r.method, r.type)).map(sanitizeLoggedIn),
  };
}

export function deriveGeneration(file: string) {
  const d = readJson(file);
  return {
    meta: { source: 'crawl/loggedin/generation/' + path.basename(file) + ' (sanitised)' },
    requests: d.filter((r: any) => isCollection(r.url, r.method, 'Fetch')).map((r: any) => sanitizeLoggedIn({ ...r, type: r.method === 'POST' ? 'Fetch' : 'Image' })),
  };
}

export const TEARDOWN_SET = ['T1a_home_meta', 'T1b_model_meta', 'T1c2_blog_lp_app_meta', 'T1f_multipage_meta', 'T1g_typed_return_meta', 'T2a_gbraid', 'T2b_wbraid', 'T2c_gbraid_then_app_fbclid', 'T3a_otherclids', 'T3b_ctrl_home_otherclids', 'T6a_country_DE', 'T7b_ubo_realistic', 'T11a_ig_home', 'T11b_ig_suitevideo'];

export function buildAll(write = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const td = path.join(EVIDENCE, 'crawl', 'teardown2');
  for (const n of TEARDOWN_SET) out[`journeys/${n}.json`] = deriveTeardown(path.join(td, n + '.json'));
  const se = path.join(EVIDENCE, 'crawl', 'sealed_evidence');
  const pick = (re: RegExp) => fs.readdirSync(se).filter((f) => re.test(f)).sort().pop()!;
  out['sealed/run_suite.json'] = deriveSealed(path.join(se, pick(/^run_suite_2026.*\.json$/)));
  out['sealed/run_suite_iso.json'] = deriveSealed(path.join(se, pick(/^run_suite_iso_.*\.json$/)));
  out['sealed/run_astro.json'] = deriveSealed(path.join(se, pick(/^run_astro_.*\.json$/)));
  out['loggedin/spa_suite.json'] = deriveSpa(path.join(EVIDENCE, 'crawl', 'loggedin', 'pages', 'P07_spa_suite.json'));
  out['loggedin/generation.json'] = deriveGeneration(path.join(EVIDENCE, 'crawl', 'loggedin', 'generation', '05_pixel_raw_after_click.json'));
  if (write) {
    for (const [rel, data] of Object.entries(out)) {
      const p = path.join(OUT, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(data, null, 1) + '\n');
    }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('build-fixtures.ts')) {
  const out = buildAll(true);
  for (const [rel, data] of Object.entries(out)) console.log(rel, JSON.stringify(data).length, 'bytes');
}
