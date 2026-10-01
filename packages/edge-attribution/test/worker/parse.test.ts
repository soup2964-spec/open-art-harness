import { describe, expect, it } from "vitest";
import { CLICK_KEYS } from "../../src/core/constants.js";
import {
  detectInAppBrowser,
  extractFacts,
  landingPath,
  parseClickIds,
  parseReferrer,
  parseUtm,
} from "../../src/core/parse.js";
import { resolveOptions } from "../../src/core/options.js";
import { T0, UA, navHeaders } from "../fixtures/helpers.js";

const opts = resolveOptions({});
const params = (q: string) => new URLSearchParams(q);

describe("parseClickIds", () => {
  it("captures every supported click id under its canonical key", () => {
    const q =
      "gclid=G1&gbraid=GB1&wbraid=WB1&dclid=DC1&fbclid=F1&msclkid=M1&ttclid=T1&twclid=X1" +
      "&li_fat_id=L1&rdt_cid=R1&oppref=O1&irclickid=I1&epik=P1&ScCid=S1";
    expect(parseClickIds(params(q))).toEqual({
      gclid: "G1",
      gbraid: "GB1",
      wbraid: "WB1",
      dclid: "DC1",
      fbclid: "F1",
      msclkid: "M1",
      ttclid: "T1",
      twclid: "X1",
      li_fat_id: "L1",
      rdt_cid: "R1",
      oppref: "O1",
      irclickid: "I1",
      epik: "P1",
      sccid: "S1",
    });
    expect(CLICK_KEYS).toHaveLength(14);
  });

  it("maps Impact's im_ref (OpenArt's shim param) and lower-case sccid onto the canonical keys", () => {
    expect(parseClickIds(params("im_ref=IMP-9&sccid=abc"))).toEqual({ irclickid: "IMP-9", sccid: "abc" });
  });

  it("prefers the canonical alias when both spellings are present", () => {
    expect(parseClickIds(params("im_ref=B&irclickid=A"))).toEqual({ irclickid: "A" });
  });

  it("keeps click-id values byte-for-byte (case-sensitive, no trimming of valid chars)", () => {
    const fbclid = "IwZXh0bgNhZW0CMTEAAR2x_Yq-Kq9.abc~Z";
    expect(parseClickIds(params(`fbclid=${fbclid}`)).fbclid).toBe(fbclid);
  });

  it("allows base64 characters (+ / =) that platforms such as Pinterest use", () => {
    expect(parseClickIds(params("epik=dj0yJnU9%2BAb%2Fcd%3D%3D")).epik).toBe("dj0yJnU9+Ab/cd==");
  });

  it("rejects values with characters that could break cookies or headers", () => {
    for (const bad of ["a b", "a;b", 'a"b', "a,b", "a\\b", "a%0Ab", "a<b", "%00"]) {
      expect(parseClickIds(params(`gclid=${bad}`))).toEqual({});
    }
  });

  it("ignores empty values and enforces per-platform length caps (fbclid 500, ttclid 1000, others 512)", () => {
    expect(parseClickIds(params("gclid=&fbclid="))).toEqual({});
    expect(parseClickIds(params(`fbclid=${"f".repeat(500)}`)).fbclid).toHaveLength(500);
    expect(parseClickIds(params(`fbclid=${"f".repeat(501)}`)).fbclid).toBeUndefined();
    expect(parseClickIds(params(`ttclid=${"t".repeat(1000)}`)).ttclid).toHaveLength(1000);
    expect(parseClickIds(params(`ttclid=${"t".repeat(1001)}`)).ttclid).toBeUndefined();
    expect(parseClickIds(params(`gclid=${"g".repeat(512)}`)).gclid).toHaveLength(512);
    expect(parseClickIds(params(`gclid=${"g".repeat(513)}`)).gclid).toBeUndefined();
  });

  it("does not treat look-alike parameter names as click ids", () => {
    expect(parseClickIds(params("GCLID=x&fbclid_=y&gclsrc=aw.ds&gad_source=1&utm_source=z"))).toEqual({});
  });
});

describe("parseUtm", () => {
  it("captures the six utm fields", () => {
    expect(
      parseUtm(
        params("utm_source=meta&utm_medium=paid_social&utm_campaign=seedance&utm_term=ai+video&utm_content=v2&utm_id=123"),
      ),
    ).toEqual({ source: "meta", medium: "paid_social", campaign: "seedance", term: "ai video", content: "v2", id: "123" });
  });

  it("returns null when no utm field is present", () => {
    expect(parseUtm(params("q=1"))).toBeNull();
  });

  it("preserves case and unicode, trims whitespace and strips control characters", () => {
    expect(parseUtm(params("utm_campaign=%20Été%E2%80%94Launch%09%0A%20"))).toEqual({ campaign: "Été—Launch" });
  });

  it("caps each value at 200 characters", () => {
    expect(parseUtm(params(`utm_content=${"x".repeat(300)}`))?.content).toHaveLength(200);
  });

  it("drops values that look like email addresses (PII must not ride in campaign fields)", () => {
    expect(parseUtm(params("utm_source=newsletter&utm_content=jane.doe%40example.com"))).toEqual({
      source: "newsletter",
    });
  });
});

describe("parseReferrer", () => {
  const reqUrl = new URL("https://openart.ai/home");
  const r = (ref: string | null) => parseReferrer(ref, reqUrl, opts);

  it("classifies no referrer, internal (same site) and external hosts", () => {
    expect(r(null).kind).toBe("none");
    expect(r("https://openart.ai/?utm_source=x").kind).toBe("internal");
    expect(r("https://www.openart.ai/blog").kind).toBe("internal");
    expect(r("https://www.google.com/")).toMatchObject({ kind: "external", host: "www.google.com" });
    expect(r("https://chatgpt.com/")).toMatchObject({ kind: "external", host: "chatgpt.com" });
  });

  it("excludes payment and OAuth returns so they never become a referral touch", () => {
    for (const ref of [
      "https://checkout.stripe.com/",
      "https://stripe.com/",
      "https://accounts.google.com/",
      "https://appleid.apple.com/",
    ]) {
      expect(r(ref).kind).toBe("excluded");
    }
  });

  it("accepts app referrers (android-app://) as external", () => {
    expect(r("android-app://com.google.android.gm/")).toMatchObject({ kind: "external", host: "com.google.android.gm" });
  });

  it("treats garbage as invalid and does not match look-alike domains as internal", () => {
    expect(r("not a url").kind).toBe("invalid");
    expect(r("https://notopenart.ai/").kind).toBe("external");
    expect(r("https://openart.ai.evil.com/").kind).toBe("external");
  });
});

describe("landingPath", () => {
  it("keeps only the pathname (never the query, which may hold ids or PII) and caps it", () => {
    expect(landingPath(new URL("https://openart.ai/ai-model/seedance-2-0/?fbclid=x&email=a@b.c"))).toBe(
      "/ai-model/seedance-2-0/",
    );
    expect(landingPath(new URL(`https://openart.ai/${"z".repeat(400)}`))).toHaveLength(200);
  });
});

describe("landingPath never stores capability tokens", () => {
  const p = (path: string) => landingPath(new URL(`https://openart.ai${path}`));

  it("collapses auth, reset, magic-link and invite paths to their prefix", () => {
    expect(p("/auth/magic-link/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123456")).toBe("/auth/:redacted");
    expect(p("/reset-password/51e60b80-46f8-48c2-9780-f92e903bf8f8")).toBe("/reset-password/:redacted");
    expect(p("/invite/Ab3dE9")).toBe("/invite/:redacted");
    expect(p("/verify-email/abc")).toBe("/verify-email/:redacted");
    expect(p("/auth")).toBe("/auth");
  });

  it("redacts token-shaped segments anywhere (UUID, JWT, long hex, long mixed-case random)", () => {
    expect(p("/share/51e60b80-46f8-48c2-9780-f92e903bf8f8/view")).toBe("/share/:token/view");
    expect(p("/s/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123456")).toBe("/s/:token");
    expect(p("/u/0123456789abcdef0123")).toBe("/u/:token");
    expect(p("/r2/aB3dE9fG1hJ2kL4mN6pQ8rS")).toBe("/r2/:token");
  });

  it("keeps ordinary slugs, including long lower-case ones with digits", () => {
    for (const path of [
      "/",
      "/home",
      "/ai-model/seedance-2-0/",
      "/suite/create-video/byte-plus-seedance-2",
      "/blog/what-is-openart-and-how-to-use-it-in-2026/",
      "/features/ai-character/",
    ]) {
      expect(p(path)).toBe(path);
    }
  });
});

describe("detectInAppBrowser", () => {
  it("recognises the T11 Instagram and TikTok webviews and the Facebook Android webview", () => {
    expect(detectInAppBrowser(UA.instagram)).toBe("instagram");
    expect(detectInAppBrowser(UA.tiktok)).toBe("tiktok");
    expect(detectInAppBrowser(UA.facebookAndroid)).toBe("facebook");
  });

  it("returns null for regular browsers", () => {
    expect(detectInAppBrowser(UA.chrome)).toBeNull();
    expect(detectInAppBrowser(UA.iphoneSafari)).toBeNull();
    expect(detectInAppBrowser(UA.cubotPhone)).toBeNull();
  });
});

describe("extractFacts", () => {
  it("assembles click ids, utm, referrer, path, cookies, geo and GPC from one request", () => {
    const req = new Request("https://openart.ai/?gclid=G&utm_source=google&utm_medium=cpc", {
      headers: navHeaders({
        referer: "https://www.google.com/",
        cookie: "oa_device_id=51e60b80-46f8-48c2-9780-f92e903bf8f8; foo=bar",
        "sec-gpc": "1",
      }),
      cf: { country: "US" } as never,
    });
    const f = extractFacts(req, opts, T0);
    expect(f.clicks).toEqual({ gclid: "G" });
    expect(f.utm).toEqual({ source: "google", medium: "cpc" });
    expect(f.referrer).toMatchObject({ kind: "external", host: "www.google.com" });
    expect(f.path).toBe("/");
    expect(f.cookies.get("oa_device_id")).toBe("51e60b80-46f8-48c2-9780-f92e903bf8f8");
    expect(f.country).toBe("US");
    expect(f.gpc).toBe(true);
    expect(f.deviceId).toBe("51e60b80-46f8-48c2-9780-f92e903bf8f8");
    expect(f.now).toBe(T0);
  });

  it("recovers click ids and utm from a same-origin Referer when the URL has none (landing was skipped or consent came later)", () => {
    const req = new Request("https://openart.ai/home", {
      headers: navHeaders({ referer: "https://openart.ai/?fbclid=F&utm_source=ig", "sec-fetch-site": "same-origin" }),
    });
    const f = extractFacts(req, opts, T0);
    expect(f.clicks).toEqual({});
    expect(f.recovered).toEqual({ clicks: { fbclid: "F" }, utm: { source: "ig" }, path: "/" });
  });

  it("never recovers from cross-site referrers", () => {
    const req = new Request("https://openart.ai/home", {
      headers: navHeaders({ referer: "https://evil.example/?gclid=G" }),
    });
    expect(extractFacts(req, opts, T0).recovered).toBeNull();
  });

  it("rejects malformed oa_device_id values rather than using them as storage keys", () => {
    const req = new Request("https://openart.ai/", { headers: navHeaders({ cookie: "oa_device_id=../../etc" }) });
    expect(extractFacts(req, opts, T0).deviceId).toBeNull();
  });
});
