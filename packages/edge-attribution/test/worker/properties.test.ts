// Properties that must hold for every scenario, not just hand-picked ones.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { captureAttribution } from "../../src/capture.js";
import { DAY, MIN, T0, applyToJar, cookiesByName } from "../fixtures/helpers.js";
import { SCENARIOS } from "../fixtures/scenarios.js";
import { fakeCtx, journey, makeRequest, run } from "./run.js";

describe("replaying a request is a no-op", () => {
  it.each(SCENARIOS.filter((s) => !s.name.includes("skipped")))("$name", async (s) => {
    const kv = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: kv } as never;
    const device = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
    const baseCookie = [s.headers.cookie, `oa_device_id=${device}`].filter(Boolean).join("; ");
    const go = async (cookie: string, at: number) => {
      const req = makeRequest(s.url, { headers: { ...s.headers, cookie }, country: s.country ?? null });
      const ctx = fakeCtx();
      const r = await captureAttribution(req, envWith, ctx, { now: () => at });
      await Promise.all(ctx.promises);
      return r;
    };
    const first = await go(baseCookie, s.now);
    const jar = applyToJar(baseCookie, first.setCookies);
    const writes = kv.put.mock.calls.length;
    const again = await go(jar, s.now + MIN);
    expect(again.setCookies).toEqual([]);
    expect(again.changes).toEqual([]);
    expect(kv.put.mock.calls.length).toBe(writes);
    expect(kv.delete).not.toHaveBeenCalled();
  });
});

describe("exact boundaries", () => {
  it("click ids live exactly 90 days (the _fbc restore stops at the boundary)", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?fbclid=F1", at: T0 }]);
    const noFbc = jar.split("; ").filter((p) => !p.startsWith("_fbc=")).join("; ");
    const before = await run("https://openart.ai/home", { cookie: noFbc, now: T0 + 90 * DAY - 1 });
    expect(cookiesByName(before.setCookies).get("_fbc")?.attrs["max-age"]).toBe("1");
    const at = await run("https://openart.ai/home", { cookie: noFbc, now: T0 + 90 * DAY });
    expect(cookiesByName(at.setCookies).has("_fbc")).toBe(false);
  });

  it("oa_attr is valid through day 390 and gone right after", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?utm_source=a", at: T0 }]);
    const inside = await run("https://openart.ai/home", { cookie: jar, now: T0 + 390 * DAY });
    expect(inside.record?.firstTouch.at).toBe(T0);
    const after = await run("https://openart.ai/home", { cookie: jar, now: T0 + 390 * DAY + 1 });
    expect(after.record?.firstTouch.at).toBe(T0 + 390 * DAY + 1);
  });

  it("the KV refresh happens at exactly 30 days", async () => {
    const kv = { put: vi.fn(async () => {}) };
    const envWith = { ...env, ATTRIBUTION_KV: kv } as never;
    let jar = "oa_device_id=0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
    for (const [url, at] of [
      ["https://openart.ai/?gclid=G1", T0],
      ["https://openart.ai/home", T0 + 30 * DAY - 1],
      ["https://openart.ai/home", T0 + 30 * DAY],
    ] as const) {
      const ctx = fakeCtx();
      const r = await captureAttribution(makeRequest(url, { cookie: jar }), envWith, ctx, { now: () => at });
      await Promise.all(ctx.promises);
      jar = applyToJar(jar, r.setCookies);
    }
    expect(kv.put).toHaveBeenCalledTimes(2);
  });
});
