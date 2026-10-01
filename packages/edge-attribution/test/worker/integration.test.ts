import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAttribution } from "../../src/capture.js";
import worker from "../../src/example-worker.js";
import { T0, cookiesByName, navHeaders } from "../fixtures/helpers.js";
import { fakeCtx, makeRequest, run } from "./run.js";

const LANDING = "https://openart.ai/?gclid=G1&fbclid=F1&utm_source=google";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withAttribution(handler)", () => {
  it("passes the untouched request to the existing handler and returns its response plus the cookies", async () => {
    const seen: Request[] = [];
    const handler = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response("<html>landing</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "oa_device_id=abc; Path=/", "x-origin": "1" },
      });
    });
    const req = makeRequest(LANDING);
    const res = await withAttribution(handler, { now: () => T0, persistence: false })(req, env as never, fakeCtx());
    expect(seen[0]).toBe(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-origin")).toBe("1");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<html>landing</html>");
    const names = [...cookiesByName(res.headers.getSetCookie()).keys()];
    expect(names).toEqual(expect.arrayContaining(["oa_device_id", "oa_attr", "oa_ad_clids", "_fbc"]));
  });

  it("keeps redirects working (Set-Cookie on a 301/302 from the origin)", async () => {
    const handler = async () => Response.redirect("https://openart.ai/home?gclid=G1", 302);
    const res = await withAttribution(handler, { now: () => T0, persistence: false })(makeRequest(LANDING), env as never, fakeCtx());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://openart.ai/home?gclid=G1");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("oa_attr="))).toBe(true);
  });

  it("isolates its own failures: a throwing consent policy leaves the origin response intact", async () => {
    const onError = vi.fn();
    const origin = new Response("ok", { headers: { "cache-control": "public, max-age=60" } });
    const res = await withAttribution(async () => origin, {
      now: () => T0,
      persistence: false,
      onError,
      consentPolicy: () => {
        throw new Error("cmp exploded");
      },
    })(makeRequest(LANDING), env as never, fakeCtx());
    expect(res).toBe(origin);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "cmp exploded" }), "capture");
  });

  it("does not swallow the existing handler's own errors", async () => {
    const fetchHandler = withAttribution(async () => {
      throw new Error("origin down");
    }, { now: () => T0, persistence: false });
    await expect(fetchHandler(makeRequest(LANDING), env as never, fakeCtx())).rejects.toThrow("origin down");
  });

  it("serves the handoff routes itself, and can be told not to", async () => {
    const handler = vi.fn(async () => new Response("origin"));
    const post = () =>
      new Request("https://openart.ai/api/attribution/handoff", {
        method: "POST",
        headers: { origin: "https://openart.ai", "content-type": "application/json" },
        body: JSON.stringify({ path: "/home" }),
      });
    const on = await withAttribution(handler, { now: () => T0 })(post(), env as never, fakeCtx());
    expect(on.headers.get("content-type")).toContain("application/json");
    expect(handler).not.toHaveBeenCalled();
    const off = await withAttribution(handler, { now: () => T0, handoff: false })(post(), env as never, fakeCtx());
    expect(await off.text()).toBe("origin");
  });

  it("leaves non-document traffic completely alone", async () => {
    const origin = new Response("{}", { headers: { "content-type": "application/json" } });
    const res = await withAttribution(async () => origin, { now: () => T0 })(
      new Request("https://openart.ai/api/user/my-info", { headers: { accept: "application/json", "sec-fetch-dest": "empty" } }),
      env as never,
      fakeCtx(),
    );
    expect(res).toBe(origin);
  });
});

describe("documented options", () => {
  it("privateCacheOnSetCookie: false leaves Cache-Control untouched", async () => {
    const r = await run(LANDING, { options: { privateCacheOnSetCookie: false } });
    const out = await r.apply(new Response("x", { headers: { "cache-control": "public, max-age=60" } }));
    expect(out.headers.get("cache-control")).toBe("public, max-age=60");
    expect(out.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("excludedReferrers adds to the defaults (e.g. an OAuth provider that is also a social site)", async () => {
    const plain = await run("https://openart.ai/home", { referer: "https://discord.com/" });
    expect(plain.record?.lastTouch?.referrerHost).toBe("discord.com");
    const excluded = await run("https://openart.ai/home", { referer: "https://discord.com/", options: { excludedReferrers: ["discord.com"] } });
    expect(excluded.record?.lastTouch).toBeNull();
    const stillStripe = await run("https://openart.ai/home", { referer: "https://checkout.stripe.com/", options: { excludedReferrers: [/^never$/] } });
    expect(stillStripe.record?.lastTouch).toBeNull();
  });

  it("deviceIdCookie reads the device id from another cookie name", async () => {
    const r = await run(LANDING, { cookie: "my_device=0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", options: { deviceIdCookie: "my_device" } });
    expect(r.record?.deviceId).toBe("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
  });

  it("minBotScore tightens the Bot Management threshold", async () => {
    const cf = { country: "US", botManagement: { verifiedBot: false, score: 20 } };
    expect((await run(LANDING, { cf })).skipped).toBeNull();
    expect((await run(LANDING, { cf, options: { minBotScore: 30 } })).skipped).toBe("bot");
  });
});

describe("example worker (src/example-worker.ts)", () => {
  it("wraps a pass-through origin fetch: same URL, same request, cookies added", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("<html>from origin</html>", { headers: { "content-type": "text/html" } }));
    const req = new Request(LANDING, { headers: navHeaders(), cf: { country: "US" } as never });
    const res = await worker.fetch(req, { ...env, ORIGIN_OVERRIDE: "" } as never, fakeCtx());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(req);
    expect(await res.text()).toBe("<html>from origin</html>");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("oa_attr="))).toBe(true);
  });

  it("ORIGIN_OVERRIDE keeps the stub's origin even for protocol-relative looking paths", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("stub"));
    const req = new Request("https://openart.ai//evil.example/x?y=1", { headers: navHeaders(), cf: { country: "US" } as never });
    await worker.fetch(req, { ...env, ORIGIN_OVERRIDE: "http://127.0.0.1:8788" } as never, fakeCtx());
    const forwarded = new URL((fetchSpy.mock.calls[0]![0] as Request).url);
    expect(forwarded.origin).toBe("http://127.0.0.1:8788");
    expect(forwarded.pathname).toBe("//evil.example/x");
  });

  it("in local dev, ORIGIN_OVERRIDE points the pass-through at a stub instead of any real origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("stub"));
    const req = new Request(`${LANDING}&x=1`, { headers: navHeaders(), cf: { country: "US" } as never });
    await worker.fetch(req, { ...env, ORIGIN_OVERRIDE: "http://127.0.0.1:8788" } as never, fakeCtx());
    const forwarded = fetchSpy.mock.calls[0]![0] as Request;
    expect(forwarded.url).toBe("http://127.0.0.1:8788/?gclid=G1&fbclid=F1&utm_source=google&x=1");
    expect(forwarded.headers.get("user-agent")).toBe(req.headers.get("user-agent"));
  });
});
