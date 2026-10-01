/**
 * Test-wide network kill switch (vitest `setupFiles`).
 *
 * Every outbound path Node offers is replaced with a function that records the attempt
 * and throws: global fetch/WebSocket, http(s).request/get, http2.connect, net/tls
 * sockets and DNS. An afterEach hook then fails the test if anything was attempted,
 * so a library that swallows the thrown error still cannot hide a network call.
 * Tests that deliberately probe the guard drain the log with `takeNetworkAttempts()`.
 */

import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach } from 'vitest';

export class NetworkAccessError extends Error {
  constructor(api: string, target: string) {
    super(`network access is disabled in tests: ${api} ${target}`);
    this.name = 'NetworkAccessError';
  }
}

const attempts: string[] = [];

function describeTarget(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.href;
  if (first && typeof first === 'object') {
    const o = first as Record<string, unknown>;
    if (typeof o.url === 'string') return o.url;
    const host = o.hostname ?? o.host ?? o.path ?? '';
    return `${String(host)}${o.port ? `:${String(o.port)}` : ''}`;
  }
  return String(first);
}

function blocked(api: string) {
  return (...args: unknown[]): never => {
    const target = describeTarget(args);
    attempts.push(`${api} ${target}`);
    throw new NetworkAccessError(api, target);
  };
}

globalThis.fetch = (async (...args: unknown[]) => blocked('fetch')(...args)) as typeof fetch;
(globalThis as Record<string, unknown>).WebSocket = class {
  constructor(...args: unknown[]) {
    blocked('WebSocket')(...args);
  }
};

const patch = (obj: object, api: string, keys: string[]) => {
  for (const key of keys) (obj as Record<string, unknown>)[key] = blocked(`${api}.${key}`);
};
patch(http, 'http', ['request', 'get']);
patch(https, 'https', ['request', 'get']);
patch(http2, 'http2', ['connect']);
patch(net, 'net', ['connect', 'createConnection']);
patch(tls, 'tls', ['connect']);
patch(dns, 'dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']);
patch(dns.promises, 'dns.promises', ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']);
// Named ESM imports of builtins (import { request } from 'node:https') read these bindings.
syncBuiltinESMExports();

/** Return and clear the recorded attempts (for tests that probe the guard itself). */
export function takeNetworkAttempts(): string[] {
  return attempts.splice(0, attempts.length);
}
(globalThis as Record<string, unknown>).__takeNetworkAttempts = takeNetworkAttempts;

afterEach(() => {
  const leaked = takeNetworkAttempts();
  if (leaked.length > 0) {
    throw new Error(`test attempted ${leaked.length} network call(s): ${leaked.join(' | ')}`);
  }
});
