import { describe, expect, it } from "vitest";
import {
  DAY,
  T0,
  applyToJar,
  astroShimMerge,
  cookiesByName,
  metaUnpackFbc,
  parseSetCookie,
  suiteBuildMigrationPayload,
  suiteReadAdClickIds,
  tiktokKeepOrMint,
  tiktokParse,
} from "../fixtures/helpers.js";
import { journey, run } from "./run.js";

const LANDING = "https://openart.ai/?gclid=G1&fbclid=F1&ttclid=T1&oppref=O1&utm_source=google&utm_medium=cpc";
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

describe("Set-Cookie attributes and domain", () => {
  it("sets exactly the five managed cookies on a paid landing", async () => {
    const r = await run(LANDING);
    expect([...cookiesByName(r.setCookies).keys()].sort()).toEqual(
      ["__oppref", "_fbc", "oa_ad_clids", "oa_attr", "ttclid"].sort(),
    );
  });

  it("oa_attr: HttpOnly, Secure, SameSite=Lax, Domain=.openart.ai, Path=/, 13-month Max-Age", async () => {
    const c = cookiesByName((await run(LANDING)).setCookies).get("oa_attr")!;
    expect(c.attrs).toMatchObject({
      httponly: true,
      secure: true,
      samesite: "Lax",
      domain: ".openart.ai",
      path: "/",
      "max-age": String(390 * 86400),
    });
  });

  it("client-readable cookies are Secure + Lax on .openart.ai but never HttpOnly (the pixels and SDKs read them)", async () => {
    const byName = cookiesByName((await run(LANDING)).setCookies);
    const expected: Record<string, string> = {
      oa_ad_clids: String(90 * 86400),
      _fbc: String(90 * 86400),
      __oppref: String(30 * 86400),
      ttclid: String(28 * 86400),
    };
    for (const [name, maxAge] of Object.entries(expected)) {
      const c = byName.get(name)!;
      expect(c.attrs.httponly, name).toBeUndefined();
      expect(c.attrs, name).toMatchObject({ secure: true, samesite: "Lax", domain: ".openart.ai", path: "/", "max-age": maxAge });
    }
  });

  it("every cookie value is RFC 6265 cookie-octets", async () => {
    for (const line of (await run(`${LANDING}&gbraid=GB1&li_fat_id=L1&utm_campaign=Été%20launch`)).setCookies) {
      expect(parseSetCookie(line).value).toMatch(COOKIE_OCTETS);
    }
  });

  it("falls back to host-only cookies when the request host is outside the cookie domain (previews, local dev)", async () => {
    const r = await run("https://edge-attribution-example.workers.dev/?gclid=G1");
    for (const line of r.setCookies) expect(parseSetCookie(line).attrs.domain).toBeUndefined();
  });

  it("sets Domain=.openart.ai from any openart.ai subdomain", async () => {
    const r = await run("https://www.openart.ai/?gclid=G1");
    for (const line of r.setCookies) expect(parseSetCookie(line).attrs.domain).toBe(".openart.ai");
  });

  it("with a duplicated cookie name, reads the first occurrence, exactly like the client's /(?:^|;\\s*)name=([^;]*)/", async () => {
    const first = encodeURIComponent(JSON.stringify({ gclid: { v: "FIRST", ts: T0 - DAY } }));
    const second = encodeURIComponent(JSON.stringify({ gclid: { v: "SECOND", ts: T0 - 2 * DAY } }));
    const r = await run("https://openart.ai/home", { cookie: `oa_ad_clids=${first}; oa_ad_clids=${second}` });
    expect(r.record?.clickIds.gclid).toEqual({ v: "FIRST", ts: T0 - DAY });
  });

  it("honours a custom cookie domain", async () => {
    const r = await run("https://app.staging.example/?gclid=G1", { options: { cookieDomain: ".staging.example" } });
    expect(cookiesByName(r.setCookies).get("oa_attr")!.attrs.domain).toBe(".staging.example");
  });
});

describe("oa_ad_clids stays compatible with OpenArt's client code", () => {
  it("is URL-encoded JSON {key:{v,ts}} that the Suite reader (module 162070) parses into the same /api/user/ad-click-ids payload", async () => {
    const c = cookiesByName((await run(LANDING)).setCookies).get("oa_ad_clids")!;
    const read = suiteReadAdClickIds(c.value);
    expect(read).toEqual({ gclid: { v: "G1", ts: T0 }, fbclid: { v: "F1", ts: T0 }, ttclid: { v: "T1", ts: T0 } });
    expect(suiteBuildMigrationPayload(read).payload).toEqual({
      gclid: "G1",
      gclid_created_at: T0,
      fbclid: "F1",
      fbclid_created_at: T0,
      ttclid: "T1",
      ttclid_created_at: T0,
    });
  });

  it("merges with the existing cookie: keeps the Astro shim's gbraid, adds the new gclid, preserves unknown keys", async () => {
    const existing = encodeURIComponent(
      JSON.stringify({ gbraid: { v: "GB0", ts: T0 - DAY }, future_key: { v: "Z", ts: T0 - DAY } }),
    );
    const r = await run("https://openart.ai/home?gclid=G2", { cookie: `oa_ad_clids=${existing}`, now: T0 });
    const json = JSON.parse(decodeURIComponent(cookiesByName(r.setCookies).get("oa_ad_clids")!.value));
    expect(json).toEqual({
      gclid: { v: "G2", ts: T0 },
      gbraid: { v: "GB0", ts: T0 - DAY },
      future_key: { v: "Z", ts: T0 - DAY },
    });
  });

  it("clamps preserved entries from the future and caps how many unknown keys are carried", async () => {
    const future = Object.fromEntries([
      ["far_future", { v: "Z", ts: 1e300 }],
      ...Array.from({ length: 40 }, (_, i) => [`extra_${i}`, { v: `V${i}`, ts: T0 - DAY }]),
    ]);
    const r = await run("https://openart.ai/?gclid=G2", { cookie: `oa_ad_clids=${encodeURIComponent(JSON.stringify(future))}` });
    const c = cookiesByName(r.setCookies).get("oa_ad_clids")!;
    expect(Number(c.attrs["max-age"])).toBeLessThanOrEqual(90 * 86400);
    const json = JSON.parse(decodeURIComponent(c.value)) as Record<string, { ts: number }>;
    expect(Object.keys(json).length).toBeLessThanOrEqual(1 + 20);
    for (const e of Object.values(json)) expect(e.ts).toBeLessThanOrEqual(T0);
  });

  it("never echoes a hostile _fbc appendix into the record", async () => {
    const r = await run("https://openart.ai/home", { cookie: `_fbc=fb.1.${T0 - DAY}.F1.'OR1=1'X` });
    const fbc = r.record?.fbc ?? null;
    expect(fbc === null || /^fb\.\d+\.\d+\.[\w.~-]+(\.[A-Za-z0-9_-]{2,8})?$/.test(fbc)).toBe(true);
    expect(r.record?.fbc ?? "").not.toContain("'");
  });

  it("never carries prototype-polluting keys from the existing cookie", async () => {
    const fresh = T0 - DAY;
    const hostile = encodeURIComponent(`{"__proto__":{"v":"x","ts":${fresh}},"constructor":{"v":"y","ts":${fresh}},"prototype":{"v":"w","ts":${fresh}},"ok_key":{"v":"Z","ts":${fresh}}}`);
    const r = await run("https://openart.ai/?gclid=G2", { cookie: `oa_ad_clids=${hostile}` });
    const json = JSON.parse(decodeURIComponent(cookiesByName(r.setCookies).get("oa_ad_clids")!.value)) as object;
    expect(Object.keys(json).sort()).toEqual(["gclid", "ok_key"]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("stores the extra keys (rdt_cid, li_fat_id, oppref, ...) that the Suite drops, so a widened KEYS list can read them", async () => {
    const r = await run("https://openart.ai/?rdt_cid=R1&li_fat_id=L1&oppref=O1&twclid=X1");
    const json = JSON.parse(decodeURIComponent(cookiesByName(r.setCookies).get("oa_ad_clids")!.value));
    expect(Object.keys(json).sort()).toEqual(["li_fat_id", "oppref", "rdt_cid", "twclid"]);
  });

  it("the Astro shim's own merge keeps every server-added key (round-trip through the shim)", async () => {
    const r = await run("https://openart.ai/?gclid=G1&rdt_cid=R1");
    const serverValue = cookiesByName(r.setCookies).get("oa_ad_clids")!.value;
    const afterShim = JSON.parse(decodeURIComponent(astroShimMerge(serverValue, { fbclid: { v: "F9", ts: T0 + 1 } })));
    expect(Object.keys(afterShim).sort()).toEqual(["fbclid", "gclid", "rdt_cid"]);
  });

  it("heals the T2c loss: after the Suite rewrites oa_ad_clids without gbraid, the next navigation restores it", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?gbraid=GB1", at: T0 }]);
    // Suite captureAdClickIds() on /home?fbclid=F2 rewrites the cookie with only its 4 keys (01 T2c).
    const suiteRewrite = encodeURIComponent(JSON.stringify({ fbclid: { v: "F2", ts: T0 + 60_000 } }));
    const jar2 = applyToJar(jar, [`oa_ad_clids=${suiteRewrite}; Path=/`]);
    const next = await run("https://openart.ai/suite/video", { cookie: jar2, now: T0 + 120_000 });
    const json = JSON.parse(decodeURIComponent(cookiesByName(next.setCookies).get("oa_ad_clids")!.value));
    expect(json.gbraid).toEqual({ v: "GB1", ts: T0 });
    expect(json.fbclid).toEqual({ v: "F2", ts: T0 + 60_000 });
  });

  it("leaves values the client regex would reject out of oa_ad_clids (they stay in oa_attr)", async () => {
    const r = await run("https://openart.ai/?epik=dj0yJnU9%2BAb%2Fcd%3D%3D&gclid=G1");
    const json = JSON.parse(decodeURIComponent(cookiesByName(r.setCookies).get("oa_ad_clids")!.value));
    expect(json).toEqual({ gclid: { v: "G1", ts: T0 } });
    expect(r.record?.clickIds.epik?.v).toBe("dj0yJnU9+Ab/cd==");
  });
});

describe("vendor cookie formats", () => {
  it("_fbc follows Meta's pack format with subdomain index 1 and ms creation time", async () => {
    const c = cookiesByName((await run(LANDING)).setCookies).get("_fbc")!;
    expect(c.value).toBe(`fb.1.${T0}.F1`);
    expect(metaUnpackFbc(c.value)).toEqual({ subdomainIndex: 1, creationTime: T0, payload: "F1" });
  });

  it("ttclid uses TikTok's <id>.<13-digit ms> format, which the pixel keeps instead of overwriting", async () => {
    const c = cookiesByName((await run(LANDING)).setCookies).get("ttclid")!;
    expect(c.value).toBe(`T1.${T0}`);
    expect(tiktokParse(c.value)).toEqual({ clickId: "T1", observedAt: T0 });
    // TikTok pixel on the landing page (URL still has ttclid=T1) sees our cookie and keeps it.
    expect(tiktokKeepOrMint("T1", c.value, T0 + 5_000)).toBe(c.value);
  });

  it("ttclid TTL is configurable but never below 28 days", async () => {
    const longer = cookiesByName((await run(LANDING, { options: { ttclidTtlDays: 60 } })).setCookies).get("ttclid")!;
    expect(longer.attrs["max-age"]).toBe(String(60 * 86400));
    const clamped = cookiesByName((await run(LANDING, { options: { ttclidTtlDays: 1 } })).setCookies).get("ttclid")!;
    expect(clamped.attrs["max-age"]).toBe(String(28 * 86400));
  });

  it("__oppref carries the raw value the OpenAI SDK reads (\"using stored click id from cookie\")", async () => {
    expect(cookiesByName((await run(LANDING)).setCookies).get("__oppref")!.value).toBe("O1");
  });
});

describe("no churn", () => {
  it("a follow-up navigation with nothing new sets no cookies", async () => {
    const { results } = await journey([
      { url: LANDING, at: T0 },
      { url: "https://openart.ai/home", at: T0 + 5_000, referer: "https://openart.ai/" },
    ]);
    expect(results[1]!.setCookies).toEqual([]);
  });

  it("Max-Age counts down from the click (TTL anchored to first observation, never extended)", async () => {
    const { jar } = await journey([{ url: LANDING, at: T0 }]);
    // _fbc deleted by ITP after 7 days: restored with the ORIGINAL timestamp and the remaining lifetime.
    const noFbc = jar
      .split("; ")
      .filter((p) => !p.startsWith("_fbc="))
      .join("; ");
    const later = await run("https://openart.ai/home", { cookie: noFbc, now: T0 + 10 * DAY });
    const fbc = cookiesByName(later.setCookies).get("_fbc")!;
    expect(fbc.value).toBe(`fb.1.${T0}.F1`);
    expect(fbc.attrs["max-age"]).toBe(String(80 * 86400));
  });
});

describe("size budget", () => {
  it("keeps every cookie within 4000 bytes even for an adversarial URL", async () => {
    const q = [
      ...["gclid", "gbraid", "wbraid", "dclid", "msclkid", "twclid", "li_fat_id", "rdt_cid", "oppref", "irclickid", "epik", "ScCid"].map(
        (k, i) => `${k}=${String.fromCharCode(65 + i).repeat(512)}`,
      ),
      `fbclid=${"f".repeat(500)}`,
      `ttclid=${"t".repeat(1000)}`,
      ...["source", "medium", "campaign", "term", "content", "id"].map((k) => `utm_${k}=${"u".repeat(400)}`),
    ].join("&");
    const r = await run(`https://openart.ai/${"p".repeat(300)}?${q}`);
    expect(r.setCookies.length).toBeGreaterThanOrEqual(2);
    let total = 0;
    for (const line of r.setCookies) {
      const c = parseSetCookie(line);
      const pair = new TextEncoder().encode(`${c.name}=${c.value}`).length;
      expect(pair, c.name).toBeLessThanOrEqual(4000);
      total += pair;
      expect(Number(c.attrs["max-age"]), c.name).toBeLessThanOrEqual(400 * 86400);
    }
    // One crafted link must not be able to bloat the visitor's Cookie header on every request.
    expect(total).toBeLessThanOrEqual(4096);
    // The signed record survives: the current touch with every platform key, and the top-priority id.
    expect(r.record?.lastTouch?.type).toBe("paid");
    expect(r.record?.lastTouch?.clickKeys).toHaveLength(14);
    expect(r.record?.clickIds.gclid).toBeDefined();
  });
});

describe("jar budget", () => {
  it("counts cookies already stored: an emission that would push the jar over 4 KB is skipped", async () => {
    const stored = [`ttclid=${"T".repeat(1000)}.${T0}`, `__oppref=${"O".repeat(512)}`].join("; ");
    const url = `https://openart.ai/?gclid=${"G".repeat(512)}&fbclid=${"f".repeat(500)}&msclkid=${"M".repeat(500)}`;
    const r = await run(url, { cookie: stored });
    const jar = applyToJar(stored, r.setCookies);
    const managed = ["oa_attr", "oa_ad_clids", "_fbc", "ttclid", "__oppref"];
    const total = jar
      .split("; ")
      .filter((p) => managed.includes(p.slice(0, p.indexOf("="))))
      .reduce((sum, p) => sum + new TextEncoder().encode(p).length, 0);
    expect(total).toBeLessThanOrEqual(4096);
    expect(r.changes.some((c) => c.startsWith("budget:skipped:"))).toBe(true);
    expect(r.setCookies.some((c) => c.startsWith("oa_attr="))).toBe(true);
  });
});

describe("apply(response)", () => {
  it("appends the cookies, keeps origin Set-Cookies, and marks shared-cacheable responses private", async () => {
    const r = await run(LANDING);
    const origin = new Response("<html></html>", {
      headers: { "content-type": "text/html", "cache-control": "public, max-age=300, s-maxage=600", "set-cookie": "oa_device_id=abc; Path=/" },
    });
    const out = await r.apply(origin);
    const setCookies = out.headers.getSetCookie();
    expect(setCookies).toContain("oa_device_id=abc; Path=/");
    expect(setCookies.length).toBe(1 + r.setCookies.length);
    expect(out.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await out.text()).toBe("<html></html>");
  });

  it("does not override a cookie the origin response already sets", async () => {
    const r = await run(LANDING);
    const origin = new Response("ok", { headers: { "set-cookie": "_fbc=fb.1.1.ORIGIN; Path=/" } });
    const fbcs = (await r.apply(origin)).headers.getSetCookie().filter((l) => l.startsWith("_fbc="));
    expect(fbcs).toEqual(["_fbc=fb.1.1.ORIGIN; Path=/"]);
  });

  it("leaves responses untouched when there is nothing to set", async () => {
    const r = await run("https://openart.ai/", { country: "US", headers: { "sec-fetch-dest": "image" } });
    const origin = new Response("x", { headers: { "cache-control": "public, max-age=60" } });
    expect(await r.apply(origin)).toBe(origin);
  });
});
