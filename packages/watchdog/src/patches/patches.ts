// Stand-ins for fixes the other packages will ship, applied locally at the CDP Fetch layer:
//   --patch-container / --patch-gtag-config  serve a patched GTM container / Google tag config in
//        place of the live one, for BOTH loaders (www.googletagmanager.com and the /4vu8/ gateway);
//   --inject-script   insert a script at the top of <head> of openart.ai HTML documents
//        (stand-in for a drop-in shim or an app patch);
//   --edge-sim        a JS module `simulate(requestUrl, requestHeaders, {country}?) => {setCookies: string[]}`
//        (packages/edge-attribution/dist/edge-sim.js) whose Set-Cookie headers are added to
//        openart.ai document responses (stand-in for the Cloudflare Worker). It runs in a worker
//        thread with an EMPTY environment (no Slack webhook, no credentials), without fetch /
//        WebSocket, a per-call timeout that terminates the worker (a synchronous loop cannot stall
//        the paused browser) and a static check that it imports nothing but pure node: modules.
// Nothing here touches the network; every function transforms a response the browser already has.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parseContainerScript, resourceHash, rewriteGeo, spliceResource } from '../container/parse.js';

export const INJECT_ATTR = 'data-openart-watchdog-inject';

// ------------------------------------------------------------------------------ inject-script
/** Global the injected block sets after the script ran (a CSP that blocks inline scripts leaves it unset). */
export const INJECT_SENTINEL = '__openartWatchdogInjected';

/**
 * Sequences that change how an inline <script> is parsed. They are REJECTED rather than escaped:
 * escaping (e.g. "<!--" -> "<\\!--") silently changes the program when they occur inside regex
 * literals or templates. Rewrite them in the script instead (e.g. "<" + "/script>").
 */
export function checkInjectableScript(scriptText: string): void {
  const m = /<\/script|<!--|<script/i.exec(scriptText);
  if (m) throw new Error(`--inject-script contains "${m[0]}" at offset ${m.index}; an inline <script> cannot carry it verbatim — rewrite it (e.g. '<' + '/script>')`);
}

/** Index just after the document's real <head ...> (or <html ...>) tag, skipping comments and the doctype. */
function findTagEnd(html: string, tag: 'head' | 'html'): number {
  const re = new RegExp(`<!--[\\s\\S]*?-->|<${tag}(?=[\\s>/])[^>]*>`, 'gi');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith('<!--')) continue;
    return m.index + m[0].length;
  }
  return -1;
}

export function injectIntoHtml(html: string, scriptText: string, sha = createHash('sha256').update(scriptText).digest('hex')): { html: string; injected: boolean; position: 'head' | 'html' | 'start' | 'already' } {
  if (html.includes(INJECT_ATTR)) return { html, injected: false, position: 'already' };
  checkInjectableScript(scriptText);
  const sentinel = `;try{window.${INJECT_SENTINEL}=${JSON.stringify(sha.slice(0, 12))}}catch(e){}`;
  const tag = `<script ${INJECT_ATTR}="1">${scriptText}\n${sentinel}</script>`;
  const headEnd = findTagEnd(html, 'head');
  if (headEnd >= 0) return { html: html.slice(0, headEnd) + tag + html.slice(headEnd), injected: true, position: 'head' };
  const htmlEnd = findTagEnd(html, 'html');
  if (htmlEnd >= 0) return { html: html.slice(0, htmlEnd) + '<head>' + tag + '</head>' + html.slice(htmlEnd), injected: true, position: 'html' };
  return { html: tag + html, injected: true, position: 'start' };
}

// ------------------------------------------------------------------------------ edge-sim
export interface EdgeSimResult {
  setCookies: string[];
}
export interface EdgeSimOptions {
  country?: string;
}
export interface EdgeSimModule {
  simulate(requestUrl: string, requestHeaders: Record<string, string>, options?: EdgeSimOptions): EdgeSimResult | Promise<EdgeSimResult>;
  /** Terminates the worker thread (EdgeSimRunner); absent for in-process test doubles. */
  close?(): Promise<void>;
}

/** node: modules an edge-sim may import (pure computation; no network, fs, process or workers). */
const EDGE_SIM_ALLOWED_IMPORTS = new Set(['node:crypto', 'crypto', 'node:buffer', 'buffer', 'node:util', 'util', 'node:url', 'url']);

export function checkEdgeSimSource(source: string): void {
  const specs = [...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]!);
  const bad = specs.filter((x) => !EDGE_SIM_ALLOWED_IMPORTS.has(x));
  if (bad.length) throw new Error(`--edge-sim may only import ${[...EDGE_SIM_ALLOWED_IMPORTS].filter((x) => x.startsWith('node:')).join(', ')}; found: ${bad.join(', ')}`);
  if (/\bimport\s*\(|\brequire\s*\(|\bprocess\.binding\b|\bfetch\s*\(|\bWebSocket\b/.test(source)) throw new Error('--edge-sim must not use dynamic import(), require(), process.binding, fetch or WebSocket');
}

// Runs inside the worker (CommonJS eval worker; the module is loaded with dynamic import()).
const EDGE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response']) { try { delete globalThis[k]; } catch (e) {} }
(async () => {
  const mod = await import(workerData.href);
  const simulate = mod.simulate || (mod.default && mod.default.simulate) || (typeof mod.default === 'function' ? mod.default : null);
  if (typeof simulate !== 'function') { parentPort.postMessage({ type: 'error', error: 'no simulate export' }); return; }
  parentPort.on('message', async (m) => {
    try {
      const r = await simulate(m.url, m.headers, m.options);
      parentPort.postMessage({ id: m.id, ok: true, setCookies: Array.isArray(r && r.setCookies) ? r.setCookies.map(String) : [] });
    } catch (e) { parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); }
  });
  parentPort.postMessage({ type: 'ready' });
})().catch((e) => parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) }));
`;

/** simulate() in an isolated worker thread: empty env, no network globals, killable on timeout. */
export class EdgeSimRunner implements EdgeSimModule {
  private seq = 0;
  private pending = new Map<number, { resolve: (r: EdgeSimResult) => void; reject: (e: Error) => void }>();
  private dead: string | null = null;

  private constructor(private readonly worker: Worker, readonly file: string, readonly timeoutMs: number) {
    worker.on('message', (m: any) => {
      const p = this.pending.get(m?.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve({ setCookies: m.setCookies });
      else p.reject(new Error('edge-sim simulate() threw: ' + m.error));
    });
    worker.on('error', (e) => this.fail('edge-sim worker crashed: ' + e.message));
    worker.on('exit', (code) => this.fail(`edge-sim worker exited (${code})`));
  }

  static async start(file: string, timeoutMs = 2000): Promise<EdgeSimRunner> {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`--edge-sim module not found: ${abs}`);
    checkEdgeSimSource(fs.readFileSync(abs, 'utf8'));
    const worker = new Worker(EDGE_WORKER_SOURCE, { eval: true, env: {}, workerData: { href: pathToFileURL(abs).href }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: false, stderr: false });
    const ready = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'did not load within 10 s' }), 10_000);
      worker.once('message', (m: any) => {
        clearTimeout(t);
        resolve(m?.type === 'ready' ? { ok: true } : { ok: false, error: m?.error ?? 'unknown' });
      });
      worker.once('error', (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message });
      });
    });
    if (!ready.ok) {
      await worker.terminate();
      throw new Error(`--edge-sim module must export simulate(requestUrl, requestHeaders[, options]) => {setCookies: string[]} (${abs}): ${ready.error}`);
    }
    return new EdgeSimRunner(worker, abs, timeoutMs);
  }

  private fail(reason: string) {
    if (this.dead) return;
    this.dead = reason;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  simulate(requestUrl: string, requestHeaders: Record<string, string>, options: EdgeSimOptions = {}): Promise<EdgeSimResult> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = ++this.seq;
    return new Promise<EdgeSimResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`edge-sim simulate() exceeded ${this.timeoutMs} ms (worker terminated)`));
        this.fail(`edge-sim worker terminated after a ${this.timeoutMs} ms timeout`);
        void this.worker.terminate();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker.postMessage({ id, url: requestUrl, headers: requestHeaders, options });
    });
  }

  async close(): Promise<void> {
    this.fail('edge-sim closed');
    await this.worker.terminate().catch(() => 0);
  }
}

export async function loadEdgeSim(file: string, timeoutMs = 2000): Promise<EdgeSimModule> {
  return EdgeSimRunner.start(file, timeoutMs);
}

/** Cookies an edge Worker must never set (authentication / bot-management state). */
const PROTECTED_COOKIE = /^(__session|__client|__client_uat|__clerk.*|__refresh.*|__cf_bm|cf_clearance|__cflb|__cfruid|__Host-.*|__Secure-.*)$/i;

/** Accept only well-formed cookies scoped to openart.ai (a Worker on openart.ai cannot set others). */
export function vetSetCookie(line: string): { ok: boolean; reason?: string; name?: string } {
  if (typeof line !== 'string' || !line.trim()) return { ok: false, reason: 'empty' };
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return { ok: false, reason: 'contains a control character' };
  const [pair, ...attrs] = line.split(';');
  const eq = pair!.indexOf('=');
  if (eq <= 0) return { ok: false, reason: 'no name=value' };
  const name = pair!.slice(0, eq).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return { ok: false, reason: 'invalid cookie name', name };
  if (PROTECTED_COOKIE.test(name)) return { ok: false, reason: `${name} is an authentication/bot-management cookie`, name };
  for (const a of attrs) {
    const [k, v] = a.split('=').map((x) => x.trim());
    if (k && k.toLowerCase() === 'domain' && v && !/^\.?([a-z0-9-]+\.)*openart\.ai$/i.test(v)) return { ok: false, reason: `Domain=${v} is outside openart.ai`, name };
  }
  return { ok: true, name };
}

export async function runEdgeSim(mod: EdgeSimModule, url: string, headers: Record<string, string>, timeoutMs = 2000, options: EdgeSimOptions = {}): Promise<{ setCookies: string[]; rejected: Array<{ line: string; reason: string }> }> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    Promise.resolve().then(() => mod.simulate(url, headers, options)),
    new Promise<EdgeSimResult>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`edge-sim simulate() exceeded ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  const lines = Array.isArray(result?.setCookies) ? result.setCookies : [];
  const setCookies: string[] = [];
  const rejected: Array<{ line: string; reason: string }> = [];
  for (const l of lines) {
    const v = vetSetCookie(l);
    if (v.ok) setCookies.push(l);
    else rejected.push({ line: String(l).slice(0, 200), reason: v.reason! });
  }
  return { setCookies, rejected };
}

// ------------------------------------------------------------------------------ container / config
export interface PatchSource {
  path: string;
  sha256: string;
  /** 'resource' = JSON spliced into the live runtime; 'script' = full compiled JS served as-is. */
  kind: 'resource' | 'script';
  json?: any;
  script?: string;
  resourceSha256?: string;
  /** The loader id this patch replaces (a compiled script names it; resource JSON may set "targetId"). */
  targetId?: string | null;
}

/** Default targets: the container patch is for GTM-56CMP8K, the config patch for Google Ads AW-11252321380. */
export const DEFAULT_PATCH_TARGETS = { container: 'GTM-56CMP8K', config: 'AW-11252321380' } as const;

export function loadPatchSource(file: string): PatchSource {
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  try {
    const json = JSON.parse(text);
    const resource = json?.resource ?? json;
    if (!resource || !Array.isArray(resource.tags) || !Array.isArray(resource.macros)) throw new Error('JSON is not a GTM resource ({version, macros, tags, predicates, rules}) nor {resource: ...}');
    const targetId = typeof json?.targetId === 'string' ? json.targetId : typeof json?.containerId === 'string' ? json.containerId : null;
    return { path: abs, sha256, kind: 'resource', json, resourceSha256: resourceHash(resource), targetId };
  } catch (e) {
    if (text.trimStart().startsWith('{')) throw new Error(`patch ${abs}: ${(e as Error).message}`);
  }
  const parsed = parseContainerScript(text);
  if (!parsed) throw new Error(`patch ${abs}: neither resource JSON nor a compiled container/config script (no "var data = {")`);
  return { path: abs, sha256, kind: 'script', script: text, resourceSha256: parsed.resourceSha256, targetId: parsed.containerId };
}

export type LoaderKind = 'container' | 'config' | 'other';

export function loaderKind(body: string, containerId = 'GTM-56CMP8K'): { kind: LoaderKind; id: string | null } {
  const p = parseContainerScript(body);
  if (!p) return { kind: 'other', id: null };
  if (p.containerId === containerId) return { kind: 'container', id: p.containerId };
  if (p.containerId && /^(AW|G|GT|DC)-/.test(p.containerId)) return { kind: 'config', id: p.containerId };
  return { kind: 'other', id: p.containerId };
}

export interface TransformResult {
  body: string;
  changed: boolean;
  notes: string[];
  kind: LoaderKind;
  resourceSha256Before: string | null;
  resourceSha256After: string | null;
}

/** Transform a Google script response: apply patches for its kind, then the optional geo rewrite. */
export function transformGoogleScript(
  body: string,
  opts: { container?: PatchSource; gtagConfig?: PatchSource; geo?: { country: string; region: string }; containerId?: string },
): TransformResult {
  const { kind, id } = loaderKind(body, opts.containerId);
  const before = parseContainerScript(body);
  const notes: string[] = [];
  let out = body;
  const candidate = kind === 'container' ? opts.container : kind === 'config' ? opts.gtagConfig : undefined;
  // a patch replaces only the loader it was built for: the AW-11252321380 config patch must never be
  // served in place of AW-16854695811's or G-QYRJB9TLG7's config
  const target = candidate ? candidate.targetId ?? (kind === 'container' ? DEFAULT_PATCH_TARGETS.container : DEFAULT_PATCH_TARGETS.config) : null;
  const patch = candidate && target === id ? candidate : undefined;
  if (patch) {
    if (patch.kind === 'resource') {
      out = spliceResource(out, patch.json);
      notes.push(`spliced ${path.basename(patch.path)} into live ${kind} ${id}`);
    } else {
      out = patch.script!;
      notes.push(`served ${path.basename(patch.path)} in place of live ${kind} ${id}`);
    }
  }
  if (opts.geo && kind !== 'other') {
    const g = rewriteGeo(out, opts.geo.country, opts.geo.region);
    if (g !== out) notes.push(`geo ${before?.geo.country}/${before?.geo.region} -> ${opts.geo.country}/${opts.geo.region}`);
    out = g;
  }
  const after = out === body ? before : parseContainerScript(out);
  return { body: out, changed: out !== body, notes, kind, resourceSha256Before: before?.resourceSha256 ?? null, resourceSha256After: after?.resourceSha256 ?? null };
}
