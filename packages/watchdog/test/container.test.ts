import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, extractDataBlock, parseContainerScript, resourceHash, rewriteGeo, spliceResource } from '../src/container/parse.js';
import { diffResources, normalizeResource } from '../src/container/diff.js';
import { evidencePath, hasEvidence, readJson } from './evidence.js';

const BASELINE = readJson(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'baselines', 'container_v25.json'));

function fakeGtmJs(resource: unknown, geo = { country: 'US', region: 'US-CA' }): string {
  const data = { resource, runtime: [[50, '__e', [46, 'a'], [36, [13, [41, '$0'], [3, '$0', ['u']], ['$0']]]]], blob: { '1': '25', '5': 'GTM-56CMP8K', '30': geo.country, '31': geo.region }, permissions: {}, security_groups: {} };
  return `\n// Copyright 2012 Google Inc. All rights reserved.\n(function(){\n\nvar data = ${JSON.stringify(data, null, 2).replace(/"resource": /, '"resource": ')}\n;\nvar ia=function(a){return a};/* runtime "var data = {" decoy in a string */ var s='}"{';\n})();\n`;
}

describe('container parsing', () => {
  it('extracts the embedded data block even with braces inside strings', () => {
    const js = 'x;var data = {"a":"}{\\"","b":{"c":[1,{"d":"}"}]}}\n;var y={};';
    expect(JSON.parse(extractDataBlock(js)!)).toEqual({ a: '}{"', b: { c: [1, { d: '}' }] } });
    expect(extractDataBlock('no container here')).toBeNull();
  });

  it('reads id, version, geo and a key-order-independent resource hash', () => {
    const js = fakeGtmJs(BASELINE.resource);
    const c = parseContainerScript(js)!;
    expect(c.containerId).toBe('GTM-56CMP8K');
    expect(c.version).toBe('25');
    expect(c.geo).toEqual({ country: 'US', region: 'US-CA' });
    expect(c.resourceSha256).toBe(BASELINE.resourceSha256);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('splices a patched resource into the live runtime and leaves the runtime untouched', () => {
    const js = fakeGtmJs(BASELINE.resource);
    const patched = structuredClone(BASELINE.resource);
    patched.predicates[2].arg1 = 'signup';
    const out = spliceResource(js, patched);
    const c = parseContainerScript(out)!;
    expect(c.resourceSha256).toBe(resourceHash(patched));
    expect(c.data.runtime).toEqual(parseContainerScript(js)!.data.runtime);
    expect(out.endsWith("var ia=function(a){return a};/* runtime \"var data = {\" decoy in a string */ var s='}\"{';\n})();\n")).toBe(true);
    // a full {resource, runtime, ...} object is also accepted
    const out2 = spliceResource(js, { resource: patched });
    expect(parseContainerScript(out2)!.resourceSha256).toBe(resourceHash(patched));
  });

  it('rewrites the geo blob Google embeds per visitor (consent-region simulation)', () => {
    const out = rewriteGeo(fakeGtmJs(BASELINE.resource), 'DE', 'DE-BE');
    expect(parseContainerScript(out)!.geo).toEqual({ country: 'DE', region: 'DE-BE' });
    // blob["22"] (what consent-region matching reads) must stay UNPADDED base64: the tag's decoder throws on '='
    const served = Buffer.from('{"0":"US","1":"US-CA","2":false}').toString('base64').replace(/=+$/, '');
    const withGeo = '(function(){\nvar data = ' + JSON.stringify({ resource: BASELINE.resource, blob: { '5': 'GTM-56CMP8K', '22': served, '30': 'US', '31': 'US-CA' } }) + '\n;})();';
    const b22 = parseContainerScript(rewriteGeo(withGeo, 'GB', 'GB-ENG'))!.data.blob['22'] as string;
    expect(b22).not.toMatch(/=/);
    expect(JSON.parse(Buffer.from(b22, 'base64').toString())).toEqual({ '0': 'GB', '1': 'GB-ENG', '2': false });
    expect(rewriteGeo('no data', 'DE', 'DE-BE')).toBe('no data');
  });
});

describe('container diff', () => {
  it('is empty for identical resources', () => {
    const d = diffResources(BASELINE.resource, structuredClone(BASELINE.resource));
    expect(d.identical).toBe(true);
    expect(d.tags.changed).toHaveLength(0);
  });

  it('names the changed trigger, tag and variable when the signup fix is published', () => {
    const r = structuredClone(BASELINE.resource);
    r.version = '26';
    r.predicates[2].arg1 = 'signup'; // rule for tag 17 now listens to `signup`
    const li = r.tags.find((t: any) => t.tag_id === 58);
    li.vtp_eventId = ['macro', 1];
    r.macros.push({ function: '__v', vtp_dataLayerVersion: 2, vtp_setDefaultValue: false, vtp_name: 'eventModel.event_id' });
    const d = diffResources(BASELINE.resource, r);
    expect(d.identical).toBe(false);
    expect(d.versionBefore).toBe('25');
    expect(d.versionAfter).toBe('26');
    // rules with the same condition merge into one trigger (GTM fires all of them)
    expect(d.triggers.removed.map((t) => t.key)).toContain('_eq({{__e}}, "new_user_signed_up")');
    const signup = d.triggers.changed.find((t) => t.key === '_eq({{__e}}, "signup")')!;
    expect(signup.changes).toContainEqual({ field: 'fires', before: ['57', '72', '76', '79'], after: ['17', '57', '72', '76', '79'] });
    expect(d.tags.changed.map((t) => t.key)).toContain('58');
    expect(d.variables.added.map((v) => v.key)).toContain('__v(eventModel.event_id)');
  });

  it('describes tags and rules in resolved form', () => {
    const n = normalizeResource(BASELINE.resource);
    expect(n.tags.get('15')!.summary).toMatch(/__awct/);
    expect(n.tags.get('15')!.params.vtp_orderId).toBe('{{__v(eventModel.transaction_id)}}');
    expect([...n.triggers.keys()]).toContain('_eq({{__e}}, "new_user_signed_up")');
    expect(n.triggers.get('_eq({{__e}}, "purchase")')!.fires).toEqual(['15', '19', '35', '58', '75']);
  });
});

describe.skipIf(!hasEvidence)('container parsing on the real loaders (research/11 §7)', () => {
  it('gtm.js, /4vu8/ and the executed bodies share one v25 resource hash; the gtag config is v4', () => {
    const files = ['raw/gtm_56CMP8K.js', 'raw/static/gtg_4vu8_root.js', 'crawl/sealed_evidence/script_bodies/a37163e5dee5ab668a4782ccd05faf0efac97e6bbc140b45a14de3a09d75408c.js'];
    for (const f of files) {
      const c = parseContainerScript(fs.readFileSync(evidencePath(f), 'utf8'))!;
      expect(c.containerId, f).toBe('GTM-56CMP8K');
      expect(c.version).toBe('25');
      expect(c.resourceSha256).toBe(BASELINE.resourceSha256);
    }
    const cfg = parseContainerScript(fs.readFileSync(evidencePath('raw/static/gtg_4vu8_C.js'), 'utf8'))!;
    expect(cfg.containerId).toBe('AW-11252321380');
    expect(cfg.version).toBe('4');
  });

  it('splices into the real 492 KB gtm.js and the result still parses to the new resource', () => {
    const js = fs.readFileSync(evidencePath('raw/gtm_56CMP8K.js'), 'utf8');
    const patched = structuredClone(BASELINE.resource);
    patched.predicates[2].arg1 = 'signup';
    const out = spliceResource(js, patched);
    expect(parseContainerScript(out)!.resourceSha256).toBe(resourceHash(patched));
    // everything outside the data block (the live runtime) is byte-identical
    const a = parseContainerScript(js)!;
    const b = parseContainerScript(out)!;
    expect(out.slice(0, b.start)).toBe(js.slice(0, a.start));
    expect(out.slice(b.end)).toBe(js.slice(a.end));
  });
});

import { containerReport, fetchLoader } from '../src/container/fetch.js';
describe.skipIf(!hasEvidence)('container watchdog is fail-closed', () => {
  const live = hasEvidence ? fs.readFileSync(evidencePath('raw/gtm_56CMP8K.js'), 'utf8') : '';
  const stub = (handler: (url: string) => Response) => (async (url: string) => handler(String(url))) as unknown as typeof fetch;
  it('a 503 or an unparseable loader is UNAVAILABLE and counts as changed (never "unchanged")', async () => {
    const rep = await containerReport({ fetchImpl: stub(() => new Response('upstream error', { status: 503 })) });
    expect(rep.state).toBe('UNAVAILABLE');
    expect(rep.changed).toBe(true);
    expect(rep.problems.join(' ')).toMatch(/HTTP 503/);
    const garbled = await containerReport({ fetchImpl: stub(() => new Response('/* new format */', { status: 200 })) });
    expect(garbled.state).toBe('UNAVAILABLE');
    expect(garbled.loaders[0]!.summary[0]).toMatch(/format changed/);
  });
  it('gtag-config drift alone marks the report CHANGED', async () => {
    const cfg = fs.readFileSync(evidencePath('raw/static/gtag_AW-11252321380.js'), 'utf8').replace('"version":"4"', '"version":"5"');
    const rep = await containerReport({ fetchImpl: stub((u) => new Response(/gtag\/js/.test(u) ? cfg : live, { status: 200 })) });
    expect(rep.loaders.every((l) => l.status === 'unchanged')).toBe(true);
    expect(rep.gtagConfig!.status).toBe('changed');
    expect(rep.state).toBe('CHANGED');
  });
  it('follows redirects only to the loader hosts', async () => {
    const r1 = await fetchLoader('https://openart.ai/4vu8/', stub((u) => (/4vu8/.test(u) ? new Response('', { status: 302, headers: { location: 'https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K' } }) : new Response(live, { status: 200 }))));
    expect(r1.snapshot.containerId).toBe('GTM-56CMP8K');
    const r2 = await fetchLoader('https://openart.ai/4vu8/', stub(() => new Response('', { status: 302, headers: { location: 'https://evil.example/gtm.js' } })));
    expect(r2.snapshot.error).toMatch(/refused/);
  });
});
