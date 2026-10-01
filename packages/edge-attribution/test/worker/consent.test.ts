import { describe, expect, it, vi } from "vitest";
import { CONSENT_REQUIRED_REGIONS } from "../../../contracts/src/consent-regions.js";
import {
  REGULATED_COUNTRIES,
  consentFingerprint,
  createDefaultConsentPolicy,
  normalizeDecision,
  parseConsentModeCookie,
  parseCookiebotCookie,
  parseOneTrustCookie,
  parseUsPrivacyString,
  readOptOutSaleSharing,
} from "../../src/core/consent.js";
import { buildAdClickIdsPayload } from "../../src/core/record.js";
import { T0, cookiesByName } from "../fixtures/helpers.js";
import { journey, run } from "./run.js";

const PAID = "https://openart.ai/?gclid=G1&fbclid=F1&ttclid=T1&oppref=O1&utm_source=google&utm_campaign=eu";
const AD_COOKIES = ["oa_ad_clids", "_fbc", "ttclid", "__oppref"];
const consentCookie = (signals: Record<string, string | boolean>) => `oa_consent=${encodeURIComponent(JSON.stringify(signals))}`;
const names = (setCookies: readonly string[]) => [...cookiesByName(setCookies).keys()].sort();

describe("default consent policy: region gating", () => {
  it("US without a CMP decision: full capture (opt-out region)", async () => {
    const r = await run(PAID, { country: "US" });
    expect(names(r.setCookies)).toEqual([...AD_COOKIES, "oa_attr"].sort());
    expect(r.consent).toMatchObject({ mode: "full", region: "unregulated", explicit: false });
  });

  it("DE without ad_storage granted: no advertising cookies, only non-identifying utm in oa_attr", async () => {
    const r = await run(PAID, { country: "DE" });
    expect(names(r.setCookies)).toEqual(["oa_attr"]);
    expect(r.consent).toMatchObject({ mode: "utm-only", region: "regulated" });
    expect(r.record?.clickIds).toEqual({});
    expect(r.record?.fbc).toBeNull();
    // Which platforms were present is kept (keys only, no identifiers), so aggregate attribution still works.
    expect(r.record?.lastTouch).toMatchObject({ type: "paid", clickKeys: ["gclid", "fbclid", "ttclid", "oppref"], utm: { source: "google", campaign: "eu" } });
  });

  it("DE with ad_storage granted in the CMP cookie: full capture", async () => {
    const r = await run(PAID, { country: "DE", cookie: consentCookie({ ad_storage: "granted", analytics_storage: "granted" }) });
    expect(names(r.setCookies)).toEqual([...AD_COOKIES, "oa_attr"].sort());
    expect(r.consent).toMatchObject({ mode: "full", region: "regulated", explicit: true });
  });

  it("gates on packages/contracts CONSENT_REQUIRED_REGIONS: the EEA, UK and CH (incl. EU territories) and nothing else", () => {
    expect(REGULATED_COUNTRIES).toBe(CONSENT_REQUIRED_REGIONS);
    for (const cc of ["DE", "FR", "IE", "NL", "PL", "SE", "IS", "LI", "NO", "GB", "CH", "RE", "GF", "GP", "MQ", "YT", "MF", "AX", "IC", "EA"]) {
      expect(REGULATED_COUNTRIES.has(cc), cc).toBe(true);
    }
    for (const cc of ["US", "CA", "BR", "JP", "IN", "AU", "TR", "UA", "RS"]) {
      expect(REGULATED_COUNTRIES.has(cc), cc).toBe(false);
    }
  });

  it("regulates the codes the contracts list adds (Canary Islands IC, Ceuta and Melilla EA, the UK alias)", async () => {
    for (const country of ["IC", "EA", "UK"]) {
      const r = await run(PAID, { country });
      expect(r.consent, country).toMatchObject({ mode: "utm-only", region: "regulated" });
      expect(names(r.setCookies), country).toEqual(["oa_attr"]);
    }
  });

  it("treats Cloudflare's isEUCountry flag as regulated", async () => {
    const r = await run(PAID, { cf: { country: "ZZ", isEUCountry: "1" } });
    expect(r.consent?.region).toBe("regulated");
  });

  it("fails closed when the country is unknown (no cf, XX, Tor T1), unless configured otherwise", async () => {
    for (const cf of [undefined, { country: "XX" }, { country: "T1" }]) {
      const r = await run(PAID, cf ? { cf } : { country: null });
      expect(r.consent).toMatchObject({ mode: "utm-only", region: "unknown" });
    }
    const permissive = await run(PAID, {
      country: null,
      options: { consentPolicy: createDefaultConsentPolicy({ unknownCountry: "unregulated" }) },
    });
    expect(permissive.consent?.mode).toBe("full");
  });
});

describe("explicit choices", () => {
  it("explicit ad_storage denial (any region) keeps utm only and expires the advertising cookies already in the browser", async () => {
    const { jar } = await journey([{ url: PAID, at: T0, country: "US" }]);
    const r = await run("https://openart.ai/home", {
      country: "FR",
      now: T0 + 60_000,
      cookie: `${jar}; ${consentCookie({ ad_storage: "denied", analytics_storage: "granted" })}`,
    });
    const byName = cookiesByName(r.setCookies);
    for (const n of AD_COOKIES) expect(byName.get(n)?.attrs["max-age"], n).toBe("0");
    expect(r.record?.clickIds).toEqual({});
    expect(r.record?.firstTouch.utm).toEqual({ source: "google", campaign: "eu" });
  });

  it("US visitor who explicitly denied ad_storage: utm only", async () => {
    const r = await run(PAID, { country: "US", cookie: consentCookie({ ad_storage: "denied" }) });
    expect(names(r.setCookies)).toEqual(["oa_attr"]);
    expect(r.consent).toMatchObject({ mode: "utm-only", explicit: true });
  });

  it("denying both ad and analytics storage stores nothing and expires an existing oa_attr", async () => {
    const { jar } = await journey([{ url: PAID, at: T0, country: "US" }]);
    const r = await run("https://openart.ai/home", {
      country: "DE",
      cookie: `${jar}; ${consentCookie({ ad_storage: "denied", analytics_storage: "denied" })}`,
    });
    expect(r.consent?.mode).toBe("none");
    expect(r.record).toBeNull();
    expect(cookiesByName(r.setCookies).get("oa_attr")?.attrs["max-age"]).toBe("0");
  });

  it("a stored record with click ids is stripped (not purged) when the same browser shows up without consent in a regulated region", async () => {
    const { jar } = await journey([{ url: PAID, at: T0, country: "US" }]);
    const r = await run("https://openart.ai/home", { country: "DE", cookie: jar, now: T0 + 60_000 });
    expect(r.record?.clickIds).toEqual({});
    expect(names(r.setCookies)).toEqual(["oa_attr"]); // no Max-Age=0 for others: no explicit denial
  });
});

describe("GPC and custom policies", () => {
  it("treats Sec-GPC as an ad-storage opt-out by default and records it", async () => {
    const r = await run(PAID, { country: "US", headers: { "sec-gpc": "1" } });
    expect(r.consent).toMatchObject({ mode: "utm-only", gpc: true, reason: "gpc" });
    expect(r.record?.consent.gpc).toBe(true);
    expect([...cookiesByName(r.setCookies).keys()]).toEqual(["oa_attr"]);
  });

  it("can downgrade GPC to a recorded flag", async () => {
    const r = await run(PAID, {
      country: "US",
      headers: { "sec-gpc": "1" },
      options: { consentPolicy: createDefaultConsentPolicy({ gpc: "flag" }) },
    });
    expect(r.consent).toMatchObject({ mode: "full", gpc: true });
  });

  it("an explicit CMP grant is honoured over GPC (the visitor opted back in)", async () => {
    const r = await run(PAID, { country: "US", headers: { "sec-gpc": "1" }, cookie: consentCookie({ ad_storage: "granted" }) });
    expect(r.consent?.mode).toBe("full");
  });

  it("fails closed when a custom policy returns an unknown mode", async () => {
    const onError = vi.fn();
    const r = await run(PAID, {
      country: "US",
      options: { onError, consentPolicy: () => ({ mode: "everything" as never, region: "unregulated", explicit: false, gpc: false, signals: {}, reason: "bug" }) },
    });
    expect(r.consent?.mode).toBe("none");
    expect(r.setCookies).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "consent");
  });

  it("accepts an injected (async) policy", async () => {
    const r = await run(PAID, {
      country: "US",
      options: {
        consentPolicy: async () => ({ mode: "none", region: "unregulated", explicit: true, gpc: false, signals: {}, reason: "test" }),
      },
    });
    expect(r.setCookies).toEqual([]);
    expect(r.record).toBeNull();
  });

  it("maps Cookiebot and OneTrust cookies onto consent-mode signals", async () => {
    const cookiebot =
      "%7Bstamp%3A%27abc%3D%3D%27%2Cnecessary%3Atrue%2Cpreferences%3Atrue%2Cstatistics%3Afalse%2Cmarketing%3Atrue%2Cmethod%3A%27explicit%27%2Cver%3A1%2Cutc%3A1790000000000%2Cregion%3A%27de%27%7D";
    expect(parseCookiebotCookie(cookiebot)).toEqual({
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "granted",
      analytics_storage: "denied",
    });
    const onetrust = "isGpcEnabled=0&datestamp=Tue+Sep+29+2026&version=202409.1.0&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A0";
    expect(parseOneTrustCookie(onetrust)).toEqual({
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted",
    });

    const r = await run(PAID, {
      country: "DE",
      cookie: `CookieConsent=${cookiebot}`,
      options: { consentPolicy: createDefaultConsentPolicy({ cmpCookie: "CookieConsent", parseCmpCookie: parseCookiebotCookie }) },
    });
    expect(r.consent?.mode).toBe("full");
  });

  it("parses the oa_consent contract (URL-encoded consent-mode JSON) and ignores garbage", () => {
    expect(parseConsentModeCookie(encodeURIComponent('{"ad_storage":"granted","ad_user_data":"denied","x":"y"}'))).toEqual({
      ad_storage: "granted",
      ad_user_data: "denied",
    });
    expect(parseConsentModeCookie('{"ad_storage":"granted"}')).toEqual({ ad_storage: "granted" });
    expect(parseConsentModeCookie("%%%")).toBeNull();
    expect(parseConsentModeCookie('{"ad_storage":"maybe"}')).toEqual({});
  });

  it("persists the consent snapshot with the record for server-side propagation (Data Manager consent, LDU)", async () => {
    const r = await run(PAID, {
      country: "DE",
      cookie: consentCookie({ ad_storage: "granted", ad_user_data: "granted", ad_personalization: "denied" }),
    });
    expect(r.record?.consent).toEqual({
      mode: "full",
      region: "regulated",
      explicit: true,
      gpc: false,
      optOutSaleSharing: false,
      signals: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "denied" },
    });
  });
});

describe("US sale/sharing opt-out (opt_out_sale_sharing, review finding)", () => {
  it("parses the IAB US Privacy string: the third character is the opt-out of sale", () => {
    expect(parseUsPrivacyString("1YYN")).toBe(true);
    expect(parseUsPrivacyString("1nYy")).toBe(true);
    expect(parseUsPrivacyString("1YNN")).toBe(false);
    for (const bad of ["1---", "", "YYN", "2YYN", "1YYNN", "1Y?N"]) expect(parseUsPrivacyString(bad), bad).toBeNull();
  });

  it("reads oa_consent opt_out_sale_sharing:true and usprivacy (1?Y?); nothing else counts", () => {
    const cookies = (h: string) => new Map(h.split("; ").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as [string, string]));
    expect(readOptOutSaleSharing(cookies(consentCookie({ opt_out_sale_sharing: true })))).toBe(true);
    expect(readOptOutSaleSharing(cookies(consentCookie({ opt_out_sale_sharing: "true" })))).toBe(false);
    expect(readOptOutSaleSharing(cookies("usprivacy=1YYN"))).toBe(true);
    expect(readOptOutSaleSharing(cookies("usprivacy=1YNN"))).toBe(false);
    expect(readOptOutSaleSharing(new Map())).toBe(false);
  });

  it("is an ad opt-out that wins over an ad_storage grant (US CMPs grant by default), recorded on the record", async () => {
    const r = await run(PAID, { country: "US", cookie: consentCookie({ ad_storage: "granted", opt_out_sale_sharing: true }) });
    expect(r.consent).toMatchObject({ mode: "utm-only", explicit: true, optOutSaleSharing: true, reason: "opt-out:sale-sharing" });
    expect(r.record?.consent.optOutSaleSharing).toBe(true);
    expect(names(r.setCookies)).toEqual(["oa_attr"]);
    expect(r.record?.clickIds).toEqual({});
  });

  it("maps the IAB usprivacy cookie the same way", async () => {
    const r = await run(PAID, { country: "US", cookie: "usprivacy=1YYN" });
    expect(r.consent).toMatchObject({ mode: "utm-only", optOutSaleSharing: true });
    const notOut = await run(PAID, { country: "US", cookie: "usprivacy=1YNN" });
    expect(notOut.consent).toMatchObject({ mode: "full", optOutSaleSharing: false });
  });

  it("withdraws: expires the advertising cookies already in the browser", async () => {
    const { jar } = await journey([{ url: PAID, at: T0, country: "US" }]);
    const r = await run("https://openart.ai/home", { country: "US", now: T0 + 60_000, cookie: `${jar}; usprivacy=1YYN` });
    const byName = cookiesByName(r.setCookies);
    for (const n of AD_COOKIES) expect(byName.get(n)?.attrs["max-age"], n).toBe("0");
  });

  it("reaches the backend payload as consent.opt_out_sale_sharing (the contracts field name)", async () => {
    const r = await run(PAID, { country: "US", headers: { "sec-gpc": "1" }, cookie: "usprivacy=1YYN" });
    expect(buildAdClickIdsPayload(r.record!).attribution.consent).toMatchObject({ gpc: true, opt_out_sale_sharing: true });
    const plain = await run(PAID, { country: "US" });
    expect(buildAdClickIdsPayload(plain.record!).attribution.consent).toMatchObject({ gpc: false, opt_out_sale_sharing: false });
  });

  it("can be downgraded to a recorded flag, which still changes the consent fingerprint", async () => {
    const policy = createDefaultConsentPolicy({ optOutSaleSharing: "flag" });
    const r = await run(PAID, { country: "US", cookie: "usprivacy=1YYN", options: { consentPolicy: policy } });
    expect(r.consent).toMatchObject({ mode: "full", optOutSaleSharing: true });
    const base = { region: "unregulated" as const, explicit: false, gpc: false, signals: {} };
    expect(consentFingerprint({ ...base, optOutSaleSharing: true })).not.toBe(consentFingerprint({ ...base, optOutSaleSharing: false }));
    expect(consentFingerprint({ ...base, optOutSaleSharing: false })).toBe(consentFingerprint(base)); // stored keys stay valid
  });

  it("GPC is unchanged: an ad opt-out an explicit grant overrides", async () => {
    const r = await run(PAID, { country: "US", headers: { "sec-gpc": "1" }, cookie: consentCookie({ ad_storage: "granted" }) });
    expect(r.consent).toMatchObject({ mode: "full", gpc: true, optOutSaleSharing: false });
  });

  it("custom policies written before the field still validate (optOutSaleSharing defaults to false)", () => {
    const { decision, error } = normalizeDecision({ mode: "full", region: "unregulated", explicit: false, gpc: false, signals: {}, reason: "legacy" });
    expect(error).toBeNull();
    expect(decision.optOutSaleSharing).toBe(false);
    expect(normalizeDecision({ mode: "full", region: "unregulated", explicit: false, gpc: false, optOutSaleSharing: "yes", signals: {}, reason: "x" }).decision.mode).toBe("none");
  });
});
