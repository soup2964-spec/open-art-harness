import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { blockedNetworkAttempts, resetBlockedNetworkAttempts } from './setup/no-network.js';

describe('network guard (proves the "zero network calls" assertion is real)', () => {
  // These tests trip the guard on purpose, then clear it so its own afterEach passes.
  afterEach(() => resetBlockedNetworkAttempts());

  it('global fetch to an ad platform is refused and recorded', async () => {
    await expect(fetch('https://graph.facebook.com/v25.0/843671884361709/events', { method: 'POST' })).rejects.toThrow(
      /NETWORK BLOCKED/,
    );
    expect(blockedNetworkAttempts()).toEqual(['fetch https://graph.facebook.com/v25.0/843671884361709/events']);
  });

  it('node:https requests are refused before any byte leaves (DNS or socket layer)', () => {
    expect(() => https.request('https://datamanager.googleapis.com/v1/events:ingest', { method: 'POST' }).end()).toThrow(
      /NETWORK BLOCKED/,
    );
    expect(blockedNetworkAttempts().some((a) => a.includes('datamanager.googleapis.com'))).toBe(true);
  });

  it('a raw TCP connect to a non-loopback address is refused', () => {
    expect(() => net.connect({ host: '203.0.113.10', port: 443 })).toThrow(/NETWORK BLOCKED/);
    expect(blockedNetworkAttempts()).toContain('connect 203.0.113.10:443');
  });

  it('DNS lookups for non-loopback hosts are refused', () => {
    expect(() => dns.lookup('business-api.tiktok.com', () => undefined)).toThrow(/NETWORK BLOCKED/);
    expect(blockedNetworkAttempts()).toContain('dns business-api.tiktok.com');
  });

  it('loopback stays available for the in-process HTTP server tests', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString()));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(body).toBe('ok');
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
