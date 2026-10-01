import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INJECT_ATTR, INJECT_SENTINEL, checkEdgeSimSource, injectIntoHtml, loadEdgeSim, loadPatchSource, loaderKind, runEdgeSim, transformGoogleScript, vetSetCookie } from '../src/patches/patches.js';
import { parseContainerScript, resourceHash } from '../src/container/parse.js';
import { readJson } from './evidence.js';

const BASELINE = readJson(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'baselines', 'container_v25.json'));
const CONFIG = readJson(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'baselines', 'gtag_config_AW-11252321380_v4.json'));
const js = (id: string, resource: unknown) => `(function(){\nvar data = ${JSON.stringify({ resource, runtime: [], blob: { '5': id, '30': 'US', '31': 'US-CA' } })}\n;})();`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-patch-'));

describe('inject-script', () => {
  it('inserts at the very top of <head>, before the edge-injected gateway snippet', () => {
    const html = '<!doctype html><html lang="en"><head data-x="1"><script>/* gateway snippet j.src=\'/4vu8/\' */</script><title>t</title></head><body></body></html>';
    const r = injectIntoHtml(html, 'window.__shim=1;');
    expect(r.position).toBe('head');
    expect(r.html.indexOf(INJECT_ATTR)).toBeLessThan(r.html.indexOf('gateway snippet'));
    expect(r.html).toContain('<head data-x="1"><script data-openart-watchdog-inject="1">window.__shim=1;\n;try{window.' + INJECT_SENTINEL + '=');
  });
  it('is idempotent, skips <head> inside comments / <header>, and handles head-less documents', () => {
    const r = injectIntoHtml('<!doctype html><!-- <head> --><html><header></header><head><title>t</title></head></html>', 'x=1');
    expect(r.html.indexOf(INJECT_ATTR)).toBeGreaterThan(r.html.indexOf('<head><'));
    expect(r.html).toContain('<!-- <head> -->');
    expect(injectIntoHtml(r.html, 'x').position).toBe('already');
    expect(injectIntoHtml('<html><body>hi</body></html>', 'x').position).toBe('html');
    expect(injectIntoHtml('fragment', 'x').position).toBe('start');
  });
  it('refuses scripts an inline <script> cannot carry verbatim (escaping would change the program)', () => {
    expect(() => injectIntoHtml('<html><head></head></html>', 'a="</script><script>alert(1)</script>"')).toThrow(/<\/script/);
    expect(() => injectIntoHtml('<html><head></head></html>', 'var re=/<!--/u;')).toThrow(/<!--/);
  });
  it('accepts the web-fixes inject script as shipped', () => {
    const f = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web-fixes', 'gtm', 'proof', 'inject_web_fixes.min.js');
    if (!fs.existsSync(f)) return;
    const r = injectIntoHtml('<html><head></head></html>', fs.readFileSync(f, 'utf8'));
    expect(r.injected).toBe(true);
  });
});

describe('edge-sim', () => {
  it('loads a module, applies its Set-Cookie lines and rejects cookies outside openart.ai', async () => {
    const f = path.join(tmp, 'edge.mjs');
    fs.writeFileSync(f, `export function simulate(url, headers) { const u = new URL(url); const c = u.searchParams.get('fbclid');
      return { setCookies: c ? ['_fbc=fb.1.1790000000000.' + c + '; Path=/; Max-Age=7776000; Domain=.openart.ai; Secure; SameSite=Lax', 'evil=1; Domain=.example.com'] : [] }; }`);
    const mod = await loadEdgeSim(f);
    const r = await runEdgeSim(mod, 'https://openart.ai/?fbclid=WD_TEST_FBCLID_A', { accept: 'text/html' });
    expect(r.setCookies).toEqual(['_fbc=fb.1.1790000000000.WD_TEST_FBCLID_A; Path=/; Max-Age=7776000; Domain=.openart.ai; Secure; SameSite=Lax']);
    expect(r.rejected[0]!.reason).toMatch(/outside openart\.ai/);
  });
  it('rejects malformed modules and slow simulate()', async () => {
    const bad = path.join(tmp, 'bad.mjs');
    fs.writeFileSync(bad, 'export const nope = 1;');
    await expect(loadEdgeSim(bad)).rejects.toThrow(/must export simulate/);
    const slow = path.join(tmp, 'slow.mjs');
    fs.writeFileSync(slow, 'export const simulate = () => new Promise(() => {});');
    const m = await loadEdgeSim(slow, 100);
    await expect(runEdgeSim(m, 'https://openart.ai/', {}, 5000)).rejects.toThrow(/exceeded/);
    await m.close?.();
  });
  it('runs in an isolated worker: a synchronous infinite loop is terminated, the environment is empty, network globals are gone', async () => {
    const loop = path.join(tmp, 'loop.mjs');
    fs.writeFileSync(loop, 'export function simulate(){ for(;;){} }');
    const m = await loadEdgeSim(loop, 150);
    const t = Date.now();
    await expect(m.simulate('https://openart.ai/', {})).rejects.toThrow(/exceeded 150 ms/);
    expect(Date.now() - t).toBeLessThan(3000);
    await m.close?.();
    const env = path.join(tmp, 'env.mjs');
    process.env.WD_SECRET_FOR_TEST = 'hooks.slack.com/secret';
    fs.writeFileSync(env, "export function simulate(){ return { setCookies: ['env=' + Object.keys(process.env).length + '-' + typeof globalThis.fetch + '; Path=/'] }; }");
    const e = await loadEdgeSim(env);
    expect((await e.simulate('https://openart.ai/', {})).setCookies).toEqual(['env=0-undefined; Path=/']);
    await e.close?.();
    delete process.env.WD_SECRET_FOR_TEST;
  });
  it('refuses modules that import network/fs/process modules or use dynamic loading', () => {
    expect(() => checkEdgeSimSource('import https from "node:https"; export function simulate(){}')).toThrow(/may only import/);
    expect(() => checkEdgeSimSource('import fs from "fs"; export function simulate(){}')).toThrow(/may only import/);
    expect(() => checkEdgeSimSource('export async function simulate(){ await fetch("https://x") }')).toThrow(/must not use/);
    expect(() => checkEdgeSimSource('export function simulate(){ return import("node:net") }')).toThrow(/must not use/);
    expect(() => checkEdgeSimSource('import { createHmac } from "node:crypto";\nexport { simulate };\nfunction simulate(){}')).not.toThrow();
  });
  it('drives the edge-attribution package build (dist/edge-sim.js) when present', async () => {
    const f = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'edge-attribution', 'dist', 'edge-sim.js');
    if (!fs.existsSync(f)) return;
    const m = await loadEdgeSim(f);
    const r = await runEdgeSim(m, 'https://openart.ai/?fbclid=WD_TEST_FBCLID_Z&utm_source=wd', { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'user-agent': 'Mozilla/5.0' }, 2000, { country: 'US' });
    await m.close?.();
    expect(r.rejected).toEqual([]);
    expect(r.setCookies.some((c) => /^_fbc=fb\.1\.\d+\.WD_TEST_FBCLID_Z;/.test(c))).toBe(true);
  });
  it('vets Set-Cookie lines', () => {
    expect(vetSetCookie('a=b\r\nSet-Cookie: x=y').ok).toBe(false);
    expect(vetSetCookie('a=b\u0000c').ok).toBe(false);
    expect(vetSetCookie('noequals').ok).toBe(false);
    expect(vetSetCookie('__client_uat=0; Domain=.openart.ai').reason).toMatch(/authentication/);
    expect(vetSetCookie('__Host-x=1; Path=/; Secure').ok).toBe(false);
    expect(vetSetCookie('__oppref=abc; Domain=.openart.ai; Path=/').ok).toBe(true);
    expect(vetSetCookie('oa_attr=1.x; Domain=.openart.ai; Path=/; HttpOnly').ok).toBe(true);
  });
});

describe('container / config patches', () => {
  it('classifies loader bodies by their embedded id', () => {
    expect(loaderKind(js('GTM-56CMP8K', BASELINE.resource)).kind).toBe('container');
    expect(loaderKind(js('AW-11252321380', CONFIG.resource)).kind).toBe('config');
    expect(loaderKind('(function(){ /* gtg_health */ })()').kind).toBe('other');
  });

  it('splices a resource patch into the container only, and the config patch into the config only', () => {
    const patched = structuredClone(BASELINE.resource);
    patched.predicates[2].arg1 = 'signup';
    const pf = path.join(tmp, 'container.json');
    fs.writeFileSync(pf, JSON.stringify({ resource: patched }));
    const src = loadPatchSource(pf);
    expect(src.kind).toBe('resource');
    const c = transformGoogleScript(js('GTM-56CMP8K', BASELINE.resource), { container: src });
    expect(c.changed).toBe(true);
    expect(parseContainerScript(c.body)!.resourceSha256).toBe(resourceHash(patched));
    const cfg = transformGoogleScript(js('AW-11252321380', CONFIG.resource), { container: src });
    expect(cfg.changed).toBe(false);
    const health = transformGoogleScript('(function(){var a={};})()', { container: src });
    expect(health.changed).toBe(false);
  });

  it('serves a full compiled script wholesale and rewrites geo on both kinds', () => {
    const sf = path.join(tmp, 'config.js');
    const cfgPatched = structuredClone(CONFIG.resource);
    cfgPatched.version = '5';
    fs.writeFileSync(sf, js('AW-11252321380', cfgPatched));
    const src = loadPatchSource(sf);
    expect(src.kind).toBe('script');
    const r = transformGoogleScript(js('AW-11252321380', CONFIG.resource), { gtagConfig: src, geo: { country: 'DE', region: 'DE-BE' } });
    const p = parseContainerScript(r.body)!;
    expect(p.version).toBe('5');
    expect(p.geo).toEqual({ country: 'DE', region: 'DE-BE' });
  });

  it('rejects files that are neither', () => {
    const f = path.join(tmp, 'x.json');
    fs.writeFileSync(f, '{"hello":1}');
    expect(() => loadPatchSource(f)).toThrow(/not a GTM resource/);
    const g = path.join(tmp, 'x.js');
    fs.writeFileSync(g, 'console.log(1)');
    expect(() => loadPatchSource(g)).toThrow(/neither/);
  });
});

describe('patch targeting', () => {
  it('serves a config patch only in place of the config it was built for', () => {
    const f = path.join(tmp, 'cfg_patch.js');
    fs.writeFileSync(f, js('AW-11252321380', { ...CONFIG.resource, version: '99' }));
    const patch = loadPatchSource(f);
    expect(patch.targetId).toBe('AW-11252321380');
    expect(transformGoogleScript(js('AW-11252321380', CONFIG.resource), { gtagConfig: patch }).changed).toBe(true);
    expect(transformGoogleScript(js('AW-16854695811', CONFIG.resource), { gtagConfig: patch }).changed).toBe(false);
    expect(transformGoogleScript(js('G-QYRJB9TLG7', CONFIG.resource), { gtagConfig: patch }).changed).toBe(false);
  });
  it('resource JSON patches default to GTM-56CMP8K / AW-11252321380 and can name another target', () => {
    const f = path.join(tmp, 'res_patch.json');
    fs.writeFileSync(f, JSON.stringify({ ...BASELINE.resource, version: '26' }));
    const patch = loadPatchSource(f);
    expect(transformGoogleScript(js('GTM-56CMP8K', BASELINE.resource), { container: patch }).changed).toBe(true);
    const g = path.join(tmp, 'res_cfg_patch.json');
    fs.writeFileSync(g, JSON.stringify({ targetId: 'AW-16854695811', resource: { ...CONFIG.resource, version: '7' } }));
    const gp = loadPatchSource(g);
    expect(transformGoogleScript(js('AW-16854695811', CONFIG.resource), { gtagConfig: gp }).changed).toBe(true);
    expect(transformGoogleScript(js('AW-11252321380', CONFIG.resource), { gtagConfig: gp }).changed).toBe(false);
  });
});
