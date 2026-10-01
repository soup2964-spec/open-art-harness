import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { captureAttribution, withAttribution } from "../../src/capture.js";
import { kvPersistence, originEndpointPersistence, verifyOriginSignature } from "../../src/persistence.js";
import type { AttributionRecord } from "../../src/core/model.js";
import { DAY, HOUR, MIN, T0, applyToJar, suiteBuildMigrationPayload, suiteReadAdClickIds, cookiesByName } from "../fixtures/helpers.js";
import { TEST_SECRET } from "../fixtures/secrets.js";
import { fakeCtx, makeRequest, run } from "./run.js";

const LANDING = "https://openart.ai/?gclid=G1&fbclid=F1&utm_source=google&utm_medium=cpc";
const uuid = () => crypto.randomUUID();

describe("KV persistence (binding ATTRIBUTION_KV, TTL 90 days)", () => {
  it("writes the record keyed by oa_device_id via ctx.waitUntil", async () => {
    const id = uuid();
    const ctx = fakeCtx();
    const r = await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${id}` }), env as never, ctx, {
      now: () => T0,
    });
    expect(r.persistence).toBe("scheduled");
    expect(ctx.promises).toHaveLength(1);
    await Promise.all(ctx.promises);

    const stored = await env.ATTRIBUTION_KV.get<AttributionRecord>(`dev:${id}`, "json");
    expect(stored).toEqual({ ...r.record, deviceId: id });
    expect(stored?.clickIds.gclid).toEqual({ v: "G1", ts: T0 });
    const { keys } = await env.ATTRIBUTION_KV.list({ prefix: `dev:${id}` });
    const ttl = keys[0]!.expiration! - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(90 * 86400 - 10);
    expect(ttl).toBeLessThanOrEqual(90 * 86400);
  });

  it("never blocks the response: a KV put that never settles does not delay it", async () => {
    const hangingKv = { put: vi.fn(() => new Promise<void>(() => {})) };
    const ctx = fakeCtx();
    const handler = vi.fn(async () => new Response("origin"));
    const fetchHandler = withAttribution(handler, { now: () => T0 });
    const started = Date.now();
    const res = await Promise.race([
      fetchHandler(makeRequest(LANDING, { cookie: `oa_device_id=${uuid()}` }), { ...env, ATTRIBUTION_KV: hangingKv } as never, ctx),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    expect(res).toBeInstanceOf(Response);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hangingKv.put).toHaveBeenCalledTimes(1);
    expect(ctx.promises).toHaveLength(1); // handed to waitUntil, not awaited
    expect(await (res as Response).text()).toBe("origin");
  });

  it("a failing KV write is reported to onError and never surfaces in the response", async () => {
    const failingKv = { put: vi.fn(async () => Promise.reject(new Error("KV 429"))) };
    const onError = vi.fn();
    const ctx = fakeCtx();
    const fetchHandler = withAttribution(async () => new Response("ok"), { now: () => T0, onError });
    const res = await fetchHandler(makeRequest(LANDING, { cookie: `oa_device_id=${uuid()}` }), { ...env, ATTRIBUTION_KV: failingKv } as never, ctx);
    expect(res.status).toBe(200);
    await Promise.allSettled(ctx.promises);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "KV 429" }), "persist:kv");
  });

  it("writes only when the record changed, plus a refresh every 30 days to keep the TTL alive for active visitors", async () => {
    const id = uuid();
    const spyKv = { put: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: spyKv } as never;
    const go = async (url: string, now: number, jar: string) => {
      const ctx = fakeCtx();
      const r = await captureAttribution(makeRequest(url, { cookie: jar }), envWith, ctx, { now: () => now });
      await Promise.all(ctx.promises);
      return { r, jar: applyToJar(jar, r.setCookies) };
    };
    let jar = `oa_device_id=${id}`;
    ({ jar } = await go(LANDING, T0, jar));
    expect(spyKv.put).toHaveBeenCalledTimes(1);
    ({ jar } = await go("https://openart.ai/home", T0 + MIN, jar));
    expect(spyKv.put).toHaveBeenCalledTimes(1); // nothing new
    ({ jar } = await go("https://openart.ai/home", T0 + 29 * DAY, jar));
    expect(spyKv.put).toHaveBeenCalledTimes(1);
    const refresh = await go("https://openart.ai/home", T0 + 31 * DAY, jar);
    expect(spyKv.put).toHaveBeenCalledTimes(2);
    expect(refresh.r.changes).toContain("persist:refresh");
  });

  it("takes the device id from the origin's Set-Cookie on a first visit", async () => {
    const id = uuid();
    const ctx = fakeCtx();
    const r = await captureAttribution(makeRequest(LANDING), env as never, ctx, { now: () => T0 });
    expect(r.persistence).toBe("awaiting-device-id");
    expect(ctx.promises).toHaveLength(0);
    await r.apply(new Response("<html>", { headers: { "set-cookie": `oa_device_id=${id}; Max-Age=31536000; Path=/; Secure; SameSite=Lax` } }));
    expect(ctx.promises).toHaveLength(1);
    await Promise.all(ctx.promises);
    expect((await env.ATTRIBUTION_KV.get<AttributionRecord>(`dev:${id}`, "json"))?.deviceId).toBe(id);
  });

  it("with no device id anywhere, keeps the record in the cookie and persists on the next request that has one", async () => {
    const id = uuid();
    const spyKv = { put: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: spyKv } as never;
    const ctx1 = fakeCtx();
    const first = await captureAttribution(makeRequest(LANDING), envWith, ctx1, { now: () => T0 });
    await first.apply(new Response("static page without a device cookie"));
    expect(spyKv.put).not.toHaveBeenCalled();

    const jar = applyToJar(`oa_device_id=${id}`, first.setCookies);
    const ctx2 = fakeCtx();
    const second = await captureAttribution(makeRequest("https://openart.ai/home", { cookie: jar }), envWith, ctx2, { now: () => T0 + MIN });
    await Promise.all(ctx2.promises);
    expect(second.persistence).toBe("scheduled");
    expect(spyKv.put).toHaveBeenCalledWith(`dev:${id}`, expect.any(String), { expirationTtl: 90 * 86400 });
  });

  it("never writes device-keyed records without ad consent (the device id is an identifier)", async () => {
    const id = uuid();
    const ctx = fakeCtx();
    const r = await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${id}`, country: "FR" }), env as never, ctx, { now: () => T0 });
    await Promise.all(ctx.promises);
    expect(r.persistence).toBe("none");
    expect(await env.ATTRIBUTION_KV.get(`dev:${id}`)).toBeNull();
    expect(r.record?.deviceId).toBeNull();
  });

  it("only persists records that carry attribution signal (a bare direct visit writes nothing)", async () => {
    const spyKv = { put: vi.fn(async () => {}) };
    const ctx = fakeCtx();
    const r = await captureAttribution(makeRequest("https://openart.ai/", { cookie: `oa_device_id=${uuid()}` }), { ...env, ATTRIBUTION_KV: spyKv } as never, ctx, { now: () => T0 });
    await Promise.all(ctx.promises);
    expect(r.persistence).toBe("none");
    expect(spyKv.put).not.toHaveBeenCalled();
  });

  it("an explicit withdrawal deletes the device record", async () => {
    const id = uuid();
    const kv = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: kv } as never;
    const ctx1 = fakeCtx();
    const first = await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${id}` }), envWith, ctx1, { now: () => T0 });
    await Promise.all(ctx1.promises);
    const denied = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "denied" }))}`;
    const jar = applyToJar(`oa_device_id=${id}; ${denied}`, first.setCookies);
    const ctx2 = fakeCtx();
    const second = await captureAttribution(makeRequest("https://openart.ai/home", { cookie: jar }), envWith, ctx2, { now: () => T0 + MIN });
    await Promise.all(ctx2.promises);
    expect(kv.delete).toHaveBeenCalledWith(`dev:${id}`);
    expect(second.changes).toContain("persist:forget");
    // and only once: the next request holds no identifiers any more
    const ctx3 = fakeCtx();
    await captureAttribution(makeRequest("https://openart.ai/pricing", { cookie: applyToJar(jar, second.setCookies) }), envWith, ctx3, { now: () => T0 + 2 * MIN });
    await Promise.all(ctx3.promises);
    expect(kv.delete).toHaveBeenCalledTimes(1);
  });

  it("persists a change in consent signals even when the mode stays full (server-side propagation reads them)", async () => {
    const id = uuid();
    const kv = { put: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: kv } as never;
    const consent = (s: Record<string, string>) => `oa_consent=${encodeURIComponent(JSON.stringify(s))}`;
    const ctx1 = fakeCtx();
    const first = await captureAttribution(
      makeRequest(LANDING, { cookie: `oa_device_id=${id}; ${consent({ ad_storage: "granted", ad_user_data: "granted" })}`, country: "DE" }),
      envWith,
      ctx1,
      { now: () => T0 },
    );
    await Promise.all(ctx1.promises);
    const jar = applyToJar(`oa_device_id=${id}; ${consent({ ad_storage: "granted", ad_user_data: "denied" })}`, first.setCookies);
    const ctx2 = fakeCtx();
    await captureAttribution(makeRequest("https://openart.ai/home", { cookie: jar, country: "DE" }), envWith, ctx2, { now: () => T0 + HOUR });
    await Promise.all(ctx2.promises);
    expect(kv.put).toHaveBeenCalledTimes(2);
    const stored = JSON.parse((kv.put.mock.calls[1] as unknown as [string, string])[1]) as AttributionRecord;
    expect(stored.consent.signals.ad_user_data).toBe("denied");
  });

  it("no trim/re-import loop: after an oversized landing, plain navigations set nothing and write nothing", async () => {
    const id = uuid();
    const kv = { put: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: kv } as never;
    const huge = [
      ...["gclid", "gbraid", "wbraid", "dclid", "msclkid", "twclid", "li_fat_id", "rdt_cid", "oppref", "irclickid", "epik", "ScCid"].map(
        (k, i) => `${k}=${String.fromCharCode(65 + i).repeat(512)}`,
      ),
      `fbclid=${"f".repeat(500)}`,
      `ttclid=${"t".repeat(1000)}`,
    ].join("&");
    let jar = `oa_device_id=${id}`;
    for (const [url, at] of [
      ["https://openart.ai/?fbclid=F1&ttclid=TT1", T0],
      // no ttclid here: the fit evicts the older TT1 from oa_attr, but its pixel-format cookie stays
      [`https://openart.ai/?${huge.replace(/&ttclid=t+/, "")}`, T0 + MIN],
    ] as const) {
      const ctx = fakeCtx();
      const r = await captureAttribution(makeRequest(url, { cookie: jar }), envWith, ctx, { now: () => at });
      await Promise.all(ctx.promises);
      jar = applyToJar(jar, r.setCookies);
    }
    const writesBefore = kv.put.mock.calls.length;
    for (const at of [T0 + 2 * MIN, T0 + 3 * MIN]) {
      const ctx = fakeCtx();
      const r = await captureAttribution(makeRequest("https://openart.ai/home", { cookie: jar }), envWith, ctx, { now: () => at });
      await Promise.all(ctx.promises);
      expect(r.setCookies).toEqual([]);
      jar = applyToJar(jar, r.setCookies);
    }
    expect(kv.put.mock.calls.length).toBe(writesBefore);
  });

  it("a first visit whose device id is minted by the origin is written once, and the cookie remembers it", async () => {
    const id = uuid();
    const kv = { put: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: kv } as never;
    const ctx1 = fakeCtx();
    const first = await captureAttribution(makeRequest(LANDING), envWith, ctx1, { now: () => T0 });
    const res = await first.apply(new Response("<html>", { headers: { "set-cookie": `oa_device_id=${id}; Path=/` } }));
    await Promise.all(ctx1.promises);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const jar = applyToJar("", res.headers.getSetCookie());
    const ctx2 = fakeCtx();
    const second = await captureAttribution(makeRequest("https://openart.ai/home", { cookie: jar }), envWith, ctx2, { now: () => T0 + MIN });
    await Promise.all(ctx2.promises);
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(second.setCookies).toEqual([]);
  });

  it("a throwing ctx.waitUntil never costs the visitor their cookies", async () => {
    const ctx = { waitUntil: () => { throw new Error("waitUntil unavailable"); }, passThroughOnException() {}, props: {} } as never;
    const onError = vi.fn();
    const r = await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${uuid()}` }), env as never, ctx, { now: () => T0, onError });
    expect(r.skipped).toBeNull();
    expect(r.setCookies.length).toBeGreaterThan(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "waitUntil unavailable" }), "persist");
  });

  it("can be disabled or pointed at another binding", async () => {
    const id = uuid();
    const other = { put: vi.fn(async () => {}) };
    const ctx = fakeCtx();
    await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${id}` }), { ...env, OTHER_KV: other } as never, ctx, {
      now: () => T0,
      persistence: kvPersistence({ binding: "OTHER_KV" }),
    });
    await Promise.all(ctx.promises);
    expect(other.put).toHaveBeenCalledTimes(1);
    const r = await run(LANDING, { cookie: `oa_device_id=${id}`, options: { persistence: false } });
    expect(r.persistence).toBe("none");
  });
});

describe("origin-endpoint persistence (extends the /api/user/ad-click-ids shape)", () => {
  function capturingFetch(status = 200) {
    const calls: Request[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as RequestInfo, init));
      return new Response(null, { status });
    });
    return { fn, calls };
  }

  it("POSTs a signed, backward-compatible payload", async () => {
    const id = uuid();
    const { fn, calls } = capturingFetch();
    const ctx = fakeCtx();
    const r = await captureAttribution(
      makeRequest(`${LANDING}&gbraid=GB1&rdt_cid=R1`, { cookie: `oa_device_id=${id}` }),
      env as never,
      ctx,
      { now: () => T0, persistence: originEndpointPersistence({ url: "https://origin.internal/api/internal/attribution", fetch: fn }) },
    );
    await Promise.all(ctx.promises);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://origin.internal/api/internal/attribution");
    expect(req.headers.get("content-type")).toBe("application/json");
    const body = await req.text();
    const ts = req.headers.get("x-oa-attribution-timestamp")!;
    const sig = req.headers.get("x-oa-attribution-signature")!;
    expect(ts).toBe(String(T0));
    expect(await verifyOriginSignature(body, ts, sig, TEST_SECRET, T0 + 1_000)).toBe(true);
    expect(await verifyOriginSignature(`${body} `, ts, sig, TEST_SECRET, T0 + 1_000)).toBe(false);
    expect(await verifyOriginSignature(body, ts, sig, TEST_SECRET, T0 + 10 * MIN)).toBe(false); // replay window

    const json = JSON.parse(body) as Record<string, unknown>;
    // The four keys the Suite already posts, with identical semantics...
    const oaAdClids = cookiesByName(r.setCookies).get("oa_ad_clids")!.value;
    const legacy = suiteBuildMigrationPayload(suiteReadAdClickIds(oaAdClids)).payload;
    for (const [k, v] of Object.entries(legacy)) expect(json[k], k).toBe(v);
    // ...plus the keys it drops today and the derived/contextual fields.
    expect(json).toMatchObject({
      device_id: id,
      gbraid: "GB1",
      gbraid_created_at: T0,
      rdt_cid: "R1",
      rdt_cid_created_at: T0,
      fbc: `fb.1.${T0}.F1`,
      attribution: {
        schema: "oa_attr/1",
        source: "edge",
        first_touch: { at: T0, type: "paid", utm: { source: "google", medium: "cpc" }, click_keys: ["gclid", "gbraid", "fbclid", "rdt_cid"], landing_path: "/" },
        consent: { mode: "full", region: "unregulated" },
      },
    });
  });

  it("reports non-2xx responses and timeouts to onError without affecting the response", async () => {
    const onError = vi.fn();
    const { fn } = capturingFetch(503);
    const ctx = fakeCtx();
    await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${uuid()}` }), env as never, ctx, {
      now: () => T0,
      onError,
      persistence: originEndpointPersistence({ url: "https://origin.internal/x", fetch: fn }),
    });
    await Promise.allSettled(ctx.promises);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("503") }), "persist:origin");

    const slow = vi.fn(
      (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const ctx2 = fakeCtx();
    const onError2 = vi.fn();
    await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${uuid()}` }), env as never, ctx2, {
      now: () => T0,
      onError: onError2,
      persistence: originEndpointPersistence({ url: "https://origin.internal/x", fetch: slow, timeoutMs: 20 }),
    });
    await Promise.allSettled(ctx2.promises);
    expect(onError2).toHaveBeenCalledWith(expect.anything(), "persist:origin");
  });

  it("runs several adapters side by side", async () => {
    const kv = { put: vi.fn(async () => {}) };
    const { fn } = capturingFetch();
    const ctx = fakeCtx();
    await captureAttribution(makeRequest(LANDING, { cookie: `oa_device_id=${uuid()}` }), { ...env, ATTRIBUTION_KV: kv } as never, ctx, {
      now: () => T0,
      persistence: [kvPersistence(), originEndpointPersistence({ url: "https://origin.internal/x", fetch: fn })],
    });
    await Promise.all(ctx.promises);
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
