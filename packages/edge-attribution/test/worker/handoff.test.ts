import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { withAttribution } from "../../src/capture.js";
import type { CaptureOptions } from "../../src/capture.js";
import { handoffKvKey, sanitizeHandoffTarget, sanitizeTargetPath } from "../../src/handoff.js";
import { verifyAttrCookie } from "../../src/crypto.js";
import { DAY, MIN, T0, UA, applyToJar, cookiesByName, navHeaders } from "../fixtures/helpers.js";
import { TEST_SECRET } from "../fixtures/secrets.js";
import { fakeCtx, journey } from "./run.js";

const DEVICE_WV = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const DEVICE_EXT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function wrapped(now: number, extra: CaptureOptions = {}) {
  const handler = vi.fn(async () => new Response("origin"));
  const fetchHandler = withAttribution(handler, { now: () => now, persistence: false, ...extra });
  return { handler, fetchHandler };
}

/** A webview session that landed from an Instagram ad, then opened the in-app-browser overlay. */
async function webviewJar(country = "US", extraCookie = ""): Promise<string> {
  const start = [extraCookie, `oa_device_id=${DEVICE_WV}`].filter(Boolean).join("; ");
  const { jar } = await journey(
    [
      {
        url: "https://openart.ai/?utm_source=ig&utm_campaign=seedance&fbclid=KJAUDIT_F&ttclid=KJAUDIT_T",
        at: T0,
        ua: UA.instagram,
        country,
      },
    ],
    start,
  );
  return jar;
}

async function createToken(
  jar: string,
  body: unknown = { path: "/home" },
  now = T0 + MIN,
  headers: Record<string, string> = {},
  country = "US",
): Promise<Response> {
  const { fetchHandler } = wrapped(now);
  const req = new Request("https://openart.ai/api/attribution/handoff", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://openart.ai",
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "empty",
      "user-agent": UA.instagram,
      cookie: jar,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    cf: { country } as never,
  });
  return fetchHandler(req, env as never, fakeCtx());
}

async function redeem(token: string, init: { cookie?: string; now?: number; ua?: string; country?: string } = {}) {
  const { fetchHandler, handler } = wrapped(init.now ?? T0 + 2 * MIN);
  const headers = navHeaders({}, init.ua ?? UA.iphoneSafari);
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetchHandler(
    new Request(`https://openart.ai/r/${token}`, { headers, redirect: "manual", cf: { country: init.country ?? "US" } as never }),
    env as never,
    fakeCtx(),
  );
  return { res, handler };
}

describe("POST /api/attribution/handoff", () => {
  it("returns a short opaque token and the /r/ URL, stored in KV for 30 minutes under a hashed key", async () => {
    const res = await createToken(await webviewJar());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { token: string; url: string; expiresAt: number; path: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`https://openart.ai/r/${body.token}`);
    expect(body.expiresAt).toBe(T0 + MIN + 30 * MIN);
    expect(body.path).toBe("/home");

    const key = await handoffKvKey(body.token);
    expect(key).not.toContain(body.token);
    const listed = await env.ATTRIBUTION_KV.list({ prefix: key });
    expect(listed.keys).toHaveLength(1);
    const ttl = listed.keys[0]!.expiration! - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(1790);
    expect(ttl).toBeLessThanOrEqual(1800);
  });

  it("issues distinct tokens", async () => {
    const jar = await webviewJar();
    const a = (await (await createToken(jar)).json()) as { token: string };
    const b = (await (await createToken(jar)).json()) as { token: string };
    expect(a.token).not.toBe(b.token);
  });

  it("returns token null and the plain same-origin URL when there is nothing to hand off (no KV write)", async () => {
    const res = await createToken("", { path: "/pricing?annual=1&gclid=G1&utm_source=x" });
    // Only the path and the attribution params: other query params never leave through the handoff.
    expect(await res.json()).toEqual({ token: null, url: "https://openart.ai/pricing?gclid=G1&utm_source=x", expiresAt: null, path: "/pricing?gclid=G1&utm_source=x" });
  });

  it("stores only the target path and the allow-listed attribution params in KV, never the query string (review finding)", async () => {
    const path = "/reset-password?token=SECRET_RESET&email=jane%40example.com&fbclid=F2&utm_source=ig&next=%2Fmagic%3Fcode%3DSECRET_MAGIC&im_ref=IM1&gclid=%3Cimg%3E";
    const body = (await (await createToken(await webviewJar(), { path })).json()) as { token: string; path: string };
    expect(body.path).toBe("/reset-password?fbclid=F2&im_ref=IM1&utm_source=ig");
    const stored = (await env.ATTRIBUTION_KV.get(await handoffKvKey(body.token)))!;
    expect(stored).not.toMatch(/SECRET|jane|next|email|img/);
    expect(JSON.parse(stored)).toMatchObject({ target: "/reset-password", params: "fbclid=F2&im_ref=IM1&utm_source=ig" });
    const { res } = await redeem(body.token);
    expect(res.headers.get("location")).toBe("/reset-password?fbclid=F2&im_ref=IM1&utm_source=ig");
  });

  it.each([
    "//evil.com",
    "//evil.com/home",
    "https://evil.com/x",
    "/\\evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "/%0d%0aSet-Cookie:x=y".replace("%0d%0a", "\r\n"),
    " /home",
    "",
    "home",
    "/r/AAAAAAAAAAAAAAAAAAAAAA",
    "/api/attribution/handoff",
  ])("rejects target %j (open-redirect protection)", async (path) => {
    const res = await createToken(await webviewJar(), { path });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
  });

  it.each([
    "/invite/Qy8vY3pB2mKd9sLw0Xz1",
    "/reset-password/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
    "/auth/magic/3f2a9c1b7d6e5f4a3b2c1d0e",
    "/magic-link/abc",
    "/suite/project/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0?utm_source=ig",
  ])("refuses a target whose path carries a credential (%s): no token, nothing stored", async (path) => {
    const res = await createToken(await webviewJar(), { path });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
  });

  it("keeps ordinary paths, sensitive routes without a credential segment included", () => {
    for (const p of ["/login", "/reset-password", "/invite", "/suite/create-image/gpt-image-2-5", "/ai-model/seedance-2-5/"]) {
      expect(sanitizeTargetPath(p, "https://openart.ai"), p).toBe(p);
    }
  });

  it("refuses at creation what redemption could not use: params or a normalised path over the limits", async () => {
    const jar = await webviewJar();
    // "~" is valid in a click id but percent-encoded when stored: four 480-char ids exceed the stored-params cap.
    const params = ["gclid", "gbraid", "wbraid", "dclid"].map((k) => `${k}=${"~".repeat(480)}`).join("&");
    expect((await createToken(jar, { path: `/home?${params}` })).status).toBe(400);
    // 2,048 input characters, but 18,424 once URL-encoded.
    expect((await createToken(jar, { path: `/${"春".repeat(2047)}` })).status).toBe(400);
  });

  it("normalises a valid target to its path; only attribution params survive, in canonical order (fragment dropped)", () => {
    expect(sanitizeTargetPath("/home?x=1#frag", "https://openart.ai")).toBe("/home");
    expect(sanitizeTargetPath("/a/../b", "https://openart.ai")).toBe("/b");
    expect(sanitizeTargetPath("/%2F%2Fevil.com", "https://openart.ai")).toBe("/%2F%2Fevil.com");
    const t = sanitizeHandoffTarget("/suite/video?utm_campaign=c%201&ttclid=T&x=1&fbclid=F&ScCid=S1&code=abc#frag", "https://openart.ai");
    expect(t?.path).toBe("/suite/video");
    expect(t?.params.toString()).toBe("fbclid=F&ttclid=T&ScCid=S1&utm_campaign=c+1");
    // Invalid click values, emails in UTMs and oversized values are dropped, not truncated into the URL.
    const bad = sanitizeHandoffTarget(`/home?gclid=${"A".repeat(600)}&fbclid=%3Cimg%3E&utm_term=jane%40example.com&utm_source=ok`, "https://openart.ai");
    expect(bad?.params.toString()).toBe("utm_source=ok");
    // A 3.8 KB target is refused whole (the 2,048-character input cap), never stored.
    expect(sanitizeHandoffTarget(`/home?gclid=${"A".repeat(3800)}`, "https://openart.ai")).toBeNull();
  });

  it("rejects cross-site callers (CSRF) and wrong methods", async () => {
    const jar = await webviewJar();
    expect((await createToken(jar, { path: "/home" }, T0 + MIN, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await createToken(jar, { path: "/home" }, T0 + MIN, { origin: "", "sec-fetch-site": "" })).status).toBe(403);
    const { fetchHandler } = wrapped(T0);
    const get = await fetchHandler(new Request("https://openart.ai/api/attribution/handoff"), env as never, fakeCtx());
    expect(get.status).toBe(405);
  });

  it("rejects malformed or oversized bodies", async () => {
    const jar = await webviewJar();
    expect((await createToken(jar, "{not json")).status).toBe(400);
    expect((await createToken(jar, { path: `/${"a".repeat(5000)}` })).status).toBe(400);
  });

  it("stops reading a streamed body without Content-Length at the 4 KB limit", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const { fetchHandler } = wrapped(T0 + MIN);
    const req = new Request("https://openart.ai/api/attribution/handoff", {
      method: "POST",
      headers: { origin: "https://openart.ai", "content-type": "application/json" },
      body: endless,
    });
    const res = await fetchHandler(req, env as never, fakeCtx());
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(16);
  });
});

describe("GET /r/:token", () => {
  it("restores the webview's attribution in the external browser and 302s to the target", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const { res, handler } = await redeem(token);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const cookies = cookiesByName(res.headers.getSetCookie());
    expect([...cookies.keys()].sort()).toEqual(["_fbc", "oa_ad_clids", "oa_attr", "ttclid"]);
    expect(cookies.get("_fbc")!.value).toBe(`fb.1.${T0}.KJAUDIT_F`); // original click time, not redemption time
    expect(cookies.get("ttclid")!.value).toBe(`KJAUDIT_T.${T0}`);
    const verified = await verifyAttrCookie(cookies.get("oa_attr")!.value, { current: TEST_SECRET }, T0 + 2 * MIN);
    expect(verified?.state.firstTouch).toMatchObject({ at: T0, type: "paid", utm: { source: "ig", campaign: "seedance" }, inAppBrowser: "instagram" });
    expect(verified?.state.handoffFrom).toBe(DEVICE_WV);
  });

  it("is single-use: the entry is deleted on redemption and a second redemption restores nothing (review finding)", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    expect((await redeem(token)).res.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await env.ATTRIBUTION_KV.get(await handoffKvKey(token))).toBeNull();
    const again = await redeem(token, { now: T0 + 3 * MIN });
    expect(again.res.status).toBe(302);
    expect(again.res.headers.get("location")).toBe("/");
    expect(again.res.headers.getSetCookie()).toEqual([]);
  });

  it("restores at most once when redemptions race", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const results = await Promise.all([redeem(token), redeem(token), redeem(token), redeem(token)]);
    expect(results.map((r) => r.res.status)).toEqual([302, 302, 302, 302]);
    expect(results.filter((r) => r.res.headers.getSetCookie().length > 0)).toHaveLength(1);
    expect(await env.ATTRIBUTION_KV.get(await handoffKvKey(token))).toBeNull();
  });

  it("an entry that was already consumed cannot restore again even if a slow KV replica still returns it", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const key = await handoffKvKey(token);
    const raw = (await env.ATTRIBUTION_KV.get(key))!;
    expect((await redeem(token)).res.headers.getSetCookie().length).toBeGreaterThan(0);
    await env.ATTRIBUTION_KV.put(key, raw, { expirationTtl: 600 }); // a stale read in the same isolate
    const stale = await redeem(token, { now: T0 + 3 * MIN });
    expect(stale.res.headers.getSetCookie()).toEqual([]);
    expect(stale.res.headers.get("location")).toBe("/home");
  });

  it("without a working KV delete nothing is restored (fail closed), and the error is reported", async () => {
    for (const broken of ["missing", "throws"] as const) {
      const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
      const kv = {
        get: (k: string) => env.ATTRIBUTION_KV.get(k),
        put: (k: string, v: string, o?: { expirationTtl?: number }) => env.ATTRIBUTION_KV.put(k, v, o),
        ...(broken === "throws"
          ? {
              delete: async () => {
                throw new Error("KV unavailable");
              },
            }
          : {}),
      };
      const onError = vi.fn();
      const handler = withAttribution(async () => new Response("origin"), { now: () => T0 + 2 * MIN, persistence: false, onError });
      const res = await handler(
        new Request(`https://openart.ai/r/${token}`, { headers: navHeaders({}, UA.iphoneSafari), redirect: "manual", cf: { country: "US" } as never }),
        { ...env, ATTRIBUTION_KV: kv } as never,
        fakeCtx(),
      );
      expect(res.status, broken).toBe(302);
      expect(res.headers.get("location"), broken).toBe("/home");
      expect(res.headers.getSetCookie(), broken).toEqual([]);
      expect(onError, broken).toHaveBeenCalledWith(expect.any(Error), "handoff");
    }
  });

  it("an unusable stored entry (a credential in its path, or corrupt) restores nothing and is discarded", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const key = await handoffKvKey(token);
    const entry = JSON.parse((await env.ATTRIBUTION_KV.get(key))!) as Record<string, unknown>;
    entry.target = "/invite/Qy8vY3pB2mKd9sLw0Xz1";
    await env.ATTRIBUTION_KV.put(key, JSON.stringify(entry), { expirationTtl: 600 });
    const { res } = await redeem(token);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await env.ATTRIBUTION_KV.get(key)).toBeNull();
  });

  it("bots, link unfurlers and non-document requests do not consume the token", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    expect((await redeem(token, { ua: "WhatsApp/2.23.20.0 A" })).res.headers.getSetCookie()).toEqual([]);
    const { fetchHandler } = wrapped(T0 + 2 * MIN);
    const img = await fetchHandler(
      new Request(`https://openart.ai/r/${token}`, { headers: navHeaders({ "sec-fetch-dest": "image" }, UA.iphoneSafari), redirect: "manual" }),
      env as never,
      fakeCtx(),
    );
    expect(img.headers.getSetCookie()).toEqual([]);
    expect((await redeem(token)).res.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("an entry written before this change (query string in the target) is re-sanitised at redemption", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const key = await handoffKvKey(token);
    const legacy = JSON.parse((await env.ATTRIBUTION_KV.get(key))!) as Record<string, unknown>;
    legacy.target = "/home?token=SECRET_RESET&utm_source=ig&gclid=G9";
    delete legacy.params;
    await env.ATTRIBUTION_KV.put(key, JSON.stringify(legacy), { expirationTtl: 600 });
    const { res } = await redeem(token);
    expect(res.headers.get("location")).toBe("/home?gclid=G9&utm_source=ig");
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("after expiry it still redirects to the target but restores nothing", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const { res } = await redeem(token, { now: T0 + MIN + 30 * MIN + 1 });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("unknown tokens redirect to / without cookies", async () => {
    const { res } = await redeem("AAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("does not intercept /r/ paths that are not handoff tokens (existing routes keep working)", async () => {
    for (const path of ["/r/short", "/r/AAAAAAAAAAAAAAAAAAAAAA/extra", "/r/"]) {
      const { fetchHandler, handler } = wrapped(T0);
      const res = await fetchHandler(new Request(`https://openart.ai${path}`, { headers: navHeaders() }), env as never, fakeCtx());
      expect(await res.text(), path).toBe("origin");
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it("re-validates the stored target at redemption (defence in depth against a poisoned entry)", async () => {
    const token = "BBBBBBBBBBBBBBBBBBBBBB";
    await env.ATTRIBUTION_KV.put(
      await handoffKvKey(token),
      JSON.stringify({ v: 1, state: null, target: "//evil.com", expiresAt: T0 + 30 * MIN, consent: null, deviceId: null }),
      { expirationTtl: 600 },
    );
    const { res } = await redeem(token, { now: T0 + MIN });
    expect(res.headers.get("location")).toBe("/");
  });

  it("restores only on top-level navigations (an <img> or fetch() to /r/:token gets the redirect but no cookies)", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    for (const dest of ["image", "empty", "iframe"]) {
      const { fetchHandler } = wrapped(T0 + 2 * MIN);
      const res = await fetchHandler(
        new Request(`https://openart.ai/r/${token}`, { headers: navHeaders({ "sec-fetch-dest": dest }, UA.iphoneSafari), redirect: "manual" }),
        env as never,
        fakeCtx(),
      );
      expect(res.status, dest).toBe(302);
      expect(res.headers.getSetCookie(), dest).toEqual([]);
    }
  });

  it("treats a corrupted KV entry (unknown consent mode) as nothing to restore (fail closed)", async () => {
    const token = "CCCCCCCCCCCCCCCCCCCCCC";
    const { token: good } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const entry = JSON.parse((await env.ATTRIBUTION_KV.get(await handoffKvKey(good)))!) as Record<string, unknown>;
    entry.consent = { mode: "everything", explicit: true, region: "unregulated", gpc: false, signals: {} };
    await env.ATTRIBUTION_KV.put(await handoffKvKey(token), JSON.stringify(entry), { expirationTtl: 600 });
    const { res } = await redeem(token, { country: "DE" });
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("does not restore cookies for bots and link-preview fetchers", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const { res } = await redeem(token, { ua: "WhatsApp/2.23.20.0 A" });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("merges with the external browser's own record: earliest first touch, latest last touch, lineage kept", async () => {
    // The external browser visited directly 30 days ago.
    const { jar: extJar } = await journey([{ url: "https://openart.ai/", at: T0 - 30 * DAY }], `oa_device_id=${DEVICE_EXT}`);
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const { res } = await redeem(token, { cookie: extJar });
    const attr = cookiesByName(res.headers.getSetCookie()).get("oa_attr")!.value;
    const merged = (await verifyAttrCookie(attr, { current: TEST_SECRET }, T0 + 2 * MIN))!.state;
    expect(merged.firstTouch).toMatchObject({ at: T0 - 30 * DAY, type: "direct" });
    expect(merged.lastTouch).toMatchObject({ at: T0, type: "paid", utm: { source: "ig" } });
    expect(merged.clickIds.fbclid).toEqual({ v: "KJAUDIT_F", ts: T0 });
    expect(merged.createdAt).toBe(T0 - 30 * DAY);
    expect(merged.handoffFrom).toBe(DEVICE_WV);
  });
});

describe("handoff and consent", () => {
  it("never widens consent: an EU browser without its own choice gets only the utm-level record, even from a granting webview", async () => {
    // The token is a bearer link; a grant must not travel to whoever opens it.
    const granted = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "granted" }))}`;
    const jar = await webviewJar("DE", granted);
    const { token } = (await (await createToken(jar, { path: "/home?gclid=G2&utm_source=ig" }, T0 + MIN, {}, "DE")).json()) as { token: string };
    const { res } = await redeem(token, { country: "DE" });
    expect(res.headers.get("location")).toBe("/home?utm_source=ig"); // no click id in the redirect either
    const cookies = cookiesByName(res.headers.getSetCookie());
    expect([...cookies.keys()]).toEqual(["oa_attr"]);
    const state = (await verifyAttrCookie(cookies.get("oa_attr")!.value, { current: TEST_SECRET }, T0 + 2 * MIN))!.state;
    expect(state.clickIds).toEqual({});
    expect(state.lastTouch?.utm).toEqual({ source: "ig", campaign: "seedance" });
  });

  it("where the redeemer's own default is full (unregulated), the click ids come across", async () => {
    const granted = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "granted" }))}`;
    const jar = await webviewJar("DE", granted);
    const { token } = (await (await createToken(jar, { path: "/home" }, T0 + MIN, {}, "DE")).json()) as { token: string };
    const { res } = await redeem(token, { country: "US" });
    expect(cookiesByName(res.headers.getSetCookie()).has("_fbc")).toBe(true);
  });

  it("a forged oa_device_id cannot be claimed as handoffFrom (lineage is bound to the signed cookie)", async () => {
    const jar = await webviewJar();
    const forged = jar.replace(`oa_device_id=${DEVICE_WV}`, "oa_device_id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const { token } = (await (await createToken(forged)).json()) as { token: string };
    const { res } = await redeem(token);
    const attr = cookiesByName(res.headers.getSetCookie()).get("oa_attr")!.value;
    const state = (await verifyAttrCookie(attr, { current: TEST_SECRET }, T0 + 2 * MIN))!.state;
    expect(state.handoffFrom).toBeNull();
    expect(state.clickIds.fbclid).toEqual({ v: "KJAUDIT_F", ts: T0 });
  });

  it("an explicit choice in the external browser wins over the carried decision", async () => {
    const granted = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "granted" }))}`;
    const jar = await webviewJar("DE", granted);
    const { token } = (await (await createToken(jar, { path: "/home" }, T0 + MIN, {}, "DE")).json()) as { token: string };
    const denied = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "denied" }))}`;
    const { res } = await redeem(token, { country: "DE", cookie: denied });
    const names = [...cookiesByName(res.headers.getSetCookie()).keys()];
    expect(names).toEqual(["oa_attr"]);
  });

  it("a webview without ad consent hands off only the utm-level record, and only utm_* params in the URL", async () => {
    const jar = await webviewJar("DE");
    const { token } = (await (await createToken(jar, { path: "/home?fbclid=F2&utm_source=ig" }, T0 + MIN, {}, "DE")).json()) as { token: string };
    expect(JSON.parse((await env.ATTRIBUTION_KV.get(await handoffKvKey(token)))!).params).toBe("utm_source=ig");
    const { res } = await redeem(token, { country: "US" });
    expect(res.headers.get("location")).toBe("/home?utm_source=ig");
    const cookies = cookiesByName(res.headers.getSetCookie());
    expect([...cookies.keys()]).toEqual(["oa_attr"]);
    const state = (await verifyAttrCookie(cookies.get("oa_attr")!.value, { current: TEST_SECRET }, T0 + 2 * MIN))!.state;
    expect(state.clickIds).toEqual({});
    expect(state.handoffFrom).toBeNull();
  });
});

describe("the new external session continues normally", () => {
  it("the first navigation after the redirect keeps the restored attribution and needs no further cookies", async () => {
    const { token } = (await (await createToken(await webviewJar())).json()) as { token: string };
    const { res } = await redeem(token);
    const jar = applyToJar("", res.headers.getSetCookie());
    const { results } = await journey([{ url: "https://openart.ai/home", at: T0 + 3 * MIN, ua: UA.iphoneSafari }], jar);
    expect(results[0]!.record?.lastTouch?.utm).toEqual({ source: "ig", campaign: "seedance" });
    expect(results[0]!.setCookies).toEqual([]);
  });
});
