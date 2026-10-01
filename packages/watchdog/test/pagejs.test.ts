import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as pagejs from '../src/browser/pagejs.js';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));

describe('page-side code', () => {
  it('is plain JavaScript that parses without any compiler helpers', () => {
    for (const [name, code] of Object.entries(pagejs)) {
      expect(() => new Function('return ' + code), name).not.toThrow();
      expect(code, name).not.toMatch(/__name|__awaiter|=>/);
    }
  });
  it('is never passed as a compiled function to page.evaluate (tsx keep-names would inject __name)', () => {
    const offenders = walk(SRC).filter((f) => /\.evaluate\(\s*(async\s*)?(\(|function)/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

import { envChromeArgs } from '../src/browser/harness.js';
describe('WATCHDOG_CHROME_ARGS', () => {
  it('passes allowlisted sandbox/GPU flags through', () => {
    expect(envChromeArgs({ WATCHDOG_CHROME_ARGS: '--no-sandbox  --disable-gpu --disable-dev-shm-usage' })).toEqual(['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']);
    expect(envChromeArgs({})).toEqual([]);
  });
  it.each(['--remote-debugging-port=9333', '--proxy-server=x', '--no-proxy-server', '--proxy-pac-url=http://x/p.pac', '--host-resolver-rules=MAP * 1.2.3.4', '--enable-quic', '--disable-web-security', '--user-data-dir=/tmp/x', 'bogus'])('refuses %s (it would remove a seal layer)', (flag) => {
    expect(() => envChromeArgs({ WATCHDOG_CHROME_ARGS: '--no-sandbox ' + flag })).toThrow(/refusing/);
  });
});

describe('in-page seal (SEAL_INIT)', () => {
  it('blocks WebSocket (incl. via prototype.constructor), service workers, shared workers and popups in a realm', () => {
    const calls: string[] = [];
    class FakeWS { constructor(u: string) { calls.push(u); } }
    class SWC { register() { calls.push('register'); return Promise.resolve(); } }
    const g: any = { WebSocket: FakeWS, SharedWorker: class { constructor() { calls.push('shared'); } }, ServiceWorkerContainer: SWC, DOMException: class extends Error { constructor(m: string, public name2: string) { super(m); this.name = name2; } } };
    g.self = g;
    new Function('self', 'window', pagejs.SEAL_INIT)(g, g);
    expect(() => new g.WebSocket('wss://x')).toThrow(/blocked by the OpenArt watchdog/);
    expect(() => new g.WebSocket.prototype.constructor('wss://y')).toThrow(/blocked/);
    expect(() => new g.SharedWorker('/s.js')).toThrow(/blocked/);
    return new SWC().register().then(() => { throw new Error('register resolved'); }, (e: Error) => {
      expect(e.message).toMatch(/service worker registration blocked/);
      expect(calls).toEqual([]);
      expect(g.__wdSealLog.length).toBe(4);
    });
  });
});
