import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { request as namedHttpsRequest } from 'node:https';
import { describe, expect, it } from 'vitest';
import { fetchTransport, flagPatchRequest } from '../src/launchdarkly.js';

const take = () => (globalThis as unknown as { __takeNetworkAttempts: () => string[] }).__takeNetworkAttempts();

describe('network guard (test/setup/no-network.ts)', () => {
  it('blocks fetch, http(s), named ESM imports and raw sockets, and records each attempt', async () => {
    await expect(fetch('https://app.launchdarkly.com/api/v2/flags')).rejects.toThrow(/network access is disabled/);
    expect(() => https.request('https://example.com')).toThrow(/network access is disabled/);
    expect(() => namedHttpsRequest('https://example.com')).toThrow(/network access is disabled/);
    expect(() => http.get('http://example.com')).toThrow(/network access is disabled/);
    expect(() => net.connect(443, 'example.com')).toThrow(/network access is disabled/);
    expect(take().length).toBe(5); // drained here so the afterEach hook does not fail this test
  });

  it('would catch the live LaunchDarkly transport if anything ever called it', async () => {
    const req = flagPatchRequest({ projectKey: 'default', flagKey: 'f', environmentKey: 'production', instructions: [], comment: 'x' });
    await expect(fetchTransport().send(req)).rejects.toThrow(/network access is disabled/);
    expect(take()).toEqual(['fetch https://app.launchdarkly.com/api/v2/flags/default/f']);
  });
});
