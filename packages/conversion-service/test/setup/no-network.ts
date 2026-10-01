/**
 * Network guard for every test file (vitest setupFiles).
 *
 * - globalThis.fetch is replaced by a stub that records the attempt and throws.
 * - net.Socket#connect (which http, https, tls, undici and gaxios all end up in) and
 *   dns.lookup refuse anything that is not loopback.
 * - afterEach fails the test if ANY attempt was recorded, even if the code under test
 *   swallowed the thrown error.
 *
 * Loopback stays open so the HTTP server tests can talk to a server on 127.0.0.1.
 * Senders under test receive their own injected fake fetch; this guard catches any code
 * path that would reach the real network instead.
 */

import dns from 'node:dns';
import net from 'node:net';
import { afterEach } from 'vitest';

const attempts: string[] = [];

/** Snapshot of blocked attempts in the current test (used by the guard's own test). */
export function blockedNetworkAttempts(): readonly string[] {
  return [...attempts];
}

/** Clear recorded attempts (only the guard's own self-test uses this). */
export function resetBlockedNetworkAttempts(): void {
  attempts.length = 0;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function isLoopback(host: unknown): boolean {
  return typeof host === 'string' && (LOOPBACK.has(host) || host.startsWith('127.'));
}

function describeUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

globalThis.fetch = (async (input: unknown) => {
  const url = describeUrl(input);
  attempts.push(`fetch ${url}`);
  throw new Error(`NETWORK BLOCKED IN TESTS: fetch(${url})`);
}) as typeof fetch;

type ConnectArgs = Parameters<net.Socket['connect']>;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0] as unknown;
  let host: unknown;
  let port: unknown;
  let path: unknown;
  if (Array.isArray(first)) {
    // Internal normalized form: [options, callback]
    const opts = first[0] as { host?: unknown; port?: unknown; path?: unknown };
    host = opts?.host;
    port = opts?.port;
    path = opts?.path;
  } else if (first && typeof first === 'object') {
    const opts = first as { host?: unknown; port?: unknown; path?: unknown };
    host = opts.host ?? 'localhost';
    port = opts.port;
    path = opts.path;
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    port = first;
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof first === 'string') {
    path = first; // IPC path
  }
  if (path !== undefined || isLoopback(host)) {
    return originalConnect.apply(this, args as ConnectArgs);
  }
  attempts.push(`connect ${String(host)}:${String(port)}`);
  throw new Error(`NETWORK BLOCKED IN TESTS: connect(${String(host)}:${String(port)})`);
} as typeof net.Socket.prototype.connect;

const originalLookup = dns.lookup;
(dns as { lookup: unknown }).lookup = function patchedLookup(hostname: string, ...rest: unknown[]) {
  if (isLoopback(hostname)) return (originalLookup as (...a: unknown[]) => unknown).call(dns, hostname, ...rest);
  attempts.push(`dns ${hostname}`);
  throw new Error(`NETWORK BLOCKED IN TESTS: dns.lookup(${hostname})`);
};
const originalPromisesLookup = dns.promises.lookup;
(dns.promises as { lookup: unknown }).lookup = async function patchedPromisesLookup(hostname: string, ...rest: unknown[]) {
  if (isLoopback(hostname)) return (originalPromisesLookup as (...a: unknown[]) => unknown).call(dns.promises, hostname, ...rest);
  attempts.push(`dns ${hostname}`);
  throw new Error(`NETWORK BLOCKED IN TESTS: dns.promises.lookup(${hostname})`);
};

afterEach(() => {
  if (attempts.length > 0) {
    const seen = attempts.splice(0, attempts.length);
    throw new Error(`Test attempted real network access (${seen.length}): ${seen.join(', ')}`);
  }
});
