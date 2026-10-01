// Tests the BUILT artifact the watchdog imports (dist/edge-sim.js), in Node, and proves it
// shares the Worker's cookie logic: same inputs -> byte-identical Set-Cookie lines.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { captureAttribution } from "../../src/capture.js";
import { DAY, T0, MIN, applyToJar, cookiesByName, navHeaders } from "../fixtures/helpers.js";
import { SCENARIOS } from "../fixtures/scenarios.js";
import { TEST_SECRET, TEST_SECRET_PREVIOUS } from "../fixtures/secrets.js";

const distPath = fileURLToPath(new URL("../../dist/edge-sim.js", import.meta.url));
type Sim = typeof import("../../src/sim.js");
const sim = (await import(distPath)) as Sim;

function fakeCtx() {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as never;
}

describe("dist/edge-sim.js", () => {
  it("is a self-contained ESM bundle whose only import is node:crypto", () => {
    const src = readFileSync(distPath, "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it("exposes simulate(requestUrl, requestHeaders) => { setCookies: string[] } synchronously", () => {
    const out = sim.simulate("https://openart.ai/?gclid=G1&utm_source=google", navHeaders());
    expect(out).not.toBeInstanceOf(Promise);
    expect(Array.isArray(out.setCookies)).toBe(true);
    expect(out.setCookies.some((c) => c.startsWith("oa_attr="))).toBe(true);
    expect(out.setCookies.some((c) => c.startsWith("oa_ad_clids="))).toBe(true);
  });

  it("accepts a plain object, header tuples or a Headers instance", () => {
    const url = "https://openart.ai/?fbclid=F1";
    const opts = { now: T0, country: "US" };
    const a = sim.simulate(url, navHeaders(), opts);
    const b = sim.simulate(url, Object.entries(navHeaders()), opts);
    const c = sim.simulate(url, new Headers(navHeaders()), opts);
    expect(b.setCookies).toEqual(a.setCookies);
    expect(c.setCookies).toEqual(a.setCookies);
  });

  it.each(SCENARIOS)("matches the Worker code path byte for byte: $name", async (s) => {
    const req = new Request(s.url, { headers: s.headers });
    Object.defineProperty(req, "cf", { value: s.country ? { country: s.country } : undefined });
    const worker = await captureAttribution(req, { ATTRIBUTION_SECRET: TEST_SECRET } as never, fakeCtx(), {
      now: () => s.now,
      persistence: false,
    });
    const simulated = sim.simulate(s.url, s.headers, { now: s.now, country: s.country, secret: TEST_SECRET });
    expect(simulated.setCookies).toEqual(worker.setCookies);
    expect(simulated.skipped ?? null).toEqual(worker.skipped);
    expect(simulated.record).toEqual(worker.record);
    // Non-vacuous: every processed scenario sets at least the signed oa_attr.
    if (worker.skipped === null) expect(worker.setCookies.some((c) => c.startsWith("oa_attr=1."))).toBe(true);
  });

  it("matches the Worker step by step on returning-visitor journeys (ITP deletion, EU visit, withdrawal, rotation)", async () => {
    const denied = `oa_consent=${encodeURIComponent(JSON.stringify({ ad_storage: "denied" }))}`;
    const steps: Array<{ url: string; at: number; country: string | null; referer?: string; drop?: string[]; add?: string; secret?: string; previous?: string }> = [
      { url: "https://openart.ai/?fbclid=F1&gclid=G1&utm_source=meta", at: T0, country: "US", secret: TEST_SECRET_PREVIOUS },
      { url: "https://openart.ai/home", at: T0 + MIN, country: "US", referer: "https://openart.ai/?fbclid=F1&gclid=G1&utm_source=meta", secret: TEST_SECRET_PREVIOUS },
      // rotation: the jar is signed with the previous secret
      { url: "https://openart.ai/pricing", at: T0 + 8 * DAY, country: "US", drop: ["_fbc", "oa_ad_clids"], previous: TEST_SECRET_PREVIOUS },
      { url: "https://openart.ai/?ttclid=T9&utm_source=tiktok", at: T0 + 9 * DAY, country: "US" },
      { url: "https://openart.ai/home", at: T0 + 10 * DAY, country: "DE" },
      { url: "https://openart.ai/home?gclid=G2", at: T0 + 11 * DAY, country: null },
      { url: "https://openart.ai/home", at: T0 + 12 * DAY, country: "US", add: denied },
    ];
    let jar = "";
    for (const s of steps) {
      for (const name of s.drop ?? []) jar = jar.split("; ").filter((p) => p && !p.startsWith(`${name}=`)).join("; ");
      const cookie = [jar, s.add].filter(Boolean).join("; ");
      const headers = navHeaders({ ...(cookie ? { cookie } : {}), ...(s.referer ? { referer: s.referer } : {}) });
      const secret = s.secret ?? TEST_SECRET;
      const req = new Request(s.url, { headers });
      Object.defineProperty(req, "cf", { value: s.country ? { country: s.country } : undefined });
      const worker = await captureAttribution(
        req,
        { ATTRIBUTION_SECRET: secret, ...(s.previous ? { ATTRIBUTION_SECRET_PREVIOUS: s.previous } : {}) } as never,
        fakeCtx(),
        { now: () => s.at, persistence: false },
      );
      const simulated = sim.simulate(s.url, headers, { now: s.at, country: s.country, secret, ...(s.previous ? { previousSecret: s.previous } : {}) });
      expect(simulated.setCookies, s.url).toEqual(worker.setCookies);
      expect(simulated.record, s.url).toEqual(worker.record);
      jar = applyToJar(jar, worker.setCookies);
    }
  });

  it("chains a multi-hop Meta journey (T1f) with applySetCookies and ends with _fbc in the jar", () => {
    let jar = "";
    const hop = (url: string, at: number, referer?: string) => {
      const out = sim.simulate(url, navHeaders({ ...(jar ? { cookie: jar } : {}), ...(referer ? { referer } : {}) }), { now: at, country: "US" });
      jar = sim.applySetCookies(jar, out.setCookies);
      return out;
    };
    hop("https://openart.ai/?fbclid=KJAUDIT_F&utm_source=meta", T0);
    hop("https://openart.ai/ai-model/seedance-2-5/", T0 + MIN, "https://openart.ai/?fbclid=KJAUDIT_F&utm_source=meta");
    const last = hop("https://openart.ai/home", T0 + 2 * MIN, "https://openart.ai/ai-model/seedance-2-5/");
    expect(jar).toContain(`_fbc=fb.1.${T0}.KJAUDIT_F`);
    expect(last.record?.fbc).toBe(`fb.1.${T0}.KJAUDIT_F`);
  });

  it("applySetCookies honours deletions (Max-Age=0) and keeps unrelated cookies", () => {
    const jar = sim.applySetCookies("a=1; _fbc=old", ["_fbc=; Max-Age=0; Path=/", "b=2; Path=/"]);
    expect(jar).toBe("a=1; b=2");
  });

  it("reports skips the same way the Worker does", () => {
    expect(sim.simulate("https://openart.ai/?gclid=G", navHeaders({}, "Googlebot/2.1")).skipped).toBe("bot");
    expect(sim.simulate("https://openart.ai/?gclid=G", navHeaders({ "sec-fetch-dest": "image" })).setCookies).toEqual([]);
  });

  it("uses a documented, obviously-fake default secret when none is given (predicts cookie shape, not signatures)", () => {
    const out = sim.simulate("https://openart.ai/?gclid=G1", navHeaders(), { now: T0 });
    const attr = cookiesByName(out.setCookies).get("oa_attr")!;
    expect(attr.attrs.httponly).toBe(true);
    expect(sim.EDGE_SIM_DEFAULT_SECRET).toMatch(/not-a-secret/);
  });

  it("jar helper also works on the Worker's output (for journeys mixing both)", () => {
    expect(applyToJar("x=1", ["y=2; Path=/"])).toBe("x=1; y=2");
  });
});
