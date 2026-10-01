// Ties the package's compatibility constants to the captured evidence. Runs only when the
// research folder is present, otherwise skipped: set OPENART_RESEARCH_DIR to it, or keep the
// workspace openart_2026-09-29/ next to (or inside) the repository. No local path is recorded here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLICK_PARAM_ALIASES, OA_AD_CLIDS_VALUE_RE, TTL } from "../../src/core/constants.js";
import { UBO_REMOVED_PARAMS } from "../fixtures/ubo.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKSPACE = "openart_2026-09-29";
const ROOT =
  process.env.OPENART_RESEARCH_DIR ??
  [join(REPO, WORKSPACE), join(REPO, "..", WORKSPACE), join(REPO, "..", "test", WORKSPACE)].find((dir) => existsSync(dir)) ??
  join(REPO, WORKSPACE);
const have = (p: string) => existsSync(join(ROOT, p));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const UBO = "crawl/teardown2/blocklists/ubo_privacy.txt";
const SHIM = "raw/bundles/page_.html";
const SUITE = "raw/bundles/js/openart.ai__suite___next__static__chunks__91db8069961c7577.js";
const T3B = "crawl/teardown2/T3b_ctrl_home_otherclids.json";
const BODIES = "crawl/teardown2/bodies";

describe.skipIf(!have(UBO))("uBO removeparam fixture vs ubo_privacy.txt", () => {
  it("our stripped/surviving split for every captured parameter matches the list's generic rules", () => {
    const generic = new Set(
      read(UBO)
        .split("\n")
        .map((l) => /^\$removeparam=([A-Za-z0-9_]+)\s*$/.exec(l)?.[1])
        .filter((x): x is string => Boolean(x)),
    );
    const ours = new Set<string>(UBO_REMOVED_PARAMS);
    const params = [...Object.values(CLICK_PARAM_ALIASES).flat(), "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];
    for (const p of params) expect(ours.has(p), p).toBe(generic.has(p));
    for (const p of UBO_REMOVED_PARAMS) expect(generic.has(p), p).toBe(true);
  });
});

describe.skipIf(!have(SHIM))("Astro inline click-ID shim (raw/bundles/page_.html)", () => {
  it("uses the value regex and 90-day Max-Age that the server-set oa_ad_clids reproduces", () => {
    const html = read(SHIM);
    expect(html).toContain("var oaAdClidPattern = /^[A-Za-z0-9._-]{1,512}$/;");
    expect(OA_AD_CLIDS_VALUE_RE.source).toBe("^[A-Za-z0-9._-]{1,512}$");
    expect(html).toContain("setOpenArtCookie('oa_ad_clids', oaJson, 7776000)");
    expect(TTL.adClidsMs / 1000).toBe(7776000);
    expect(html).toContain("encodeURIComponent(value)");
  });
});

describe.skipIf(!have(SUITE))("Suite reader, module 162070", () => {
  it("reads 4 keys with the same regex and {v:string, ts:number} shape our test transcription uses", () => {
    const js = read(SUITE);
    expect(js).toContain('let n=["gclid","fbclid","msclkid","ttclid"],r="oa_ad_clids",i=/^[A-Za-z0-9._-]{1,512}$/;');
    expect(js).toContain('"string"==typeof s&&i.test(s)&&"number"==typeof a&&(r[e]={v:s,ts:a})');
    expect(js).toContain('r[`${i}_created_at`]=n.ts');
    expect(js).toContain('"Max-Age=7776000"');
  });
});

describe.skipIf(!have(T3B))("vendor cookie formats observed live (T3b)", () => {
  it("TikTok writes ttclid=<id>.<13-digit ms> for 1 day; the OpenAI SDK writes a raw __oppref for 30 days", () => {
    const scenario = JSON.parse(read(T3B)) as { steps: Array<{ cookies?: Array<Record<string, unknown>> }> };
    const cookies = scenario.steps.flatMap((s) => s.cookies ?? []);
    const ttclid = cookies.find((c) => c.name === "ttclid")!;
    expect(ttclid.value).toMatch(/^KJAUDIT_T\.\d{13}$/);
    expect(Math.round(((ttclid.expires as number) - Number(String(ttclid.value).split(".")[1]) / 1000) / 3600)).toBe(24);
    const oppref = cookies.find((c) => c.name === "__oppref")!;
    expect(oppref.value).toBe("KJAUDIT_O");
    expect(TTL.opprefMs).toBe(30 * 86_400_000);
    expect(TTL.ttclidMinMs).toBe(28 * 86_400_000);
  });
});

// fbevents.js as served on the app (module SignalsFBEventsPixelCookie + SignalsPixelCookieUtils)
const META = `${BODIES}/a169ba40a402b831674f823e6cd5bc8d3e1208e4.js`;
// analytics.tiktok.com/i18n/pixel/static/main.MWU2MzIzODM0MQ.js
const TIKTOK = `${BODIES}/854097695c4c8bbf8d446b4b504d51194b258766.js`;

describe.skipIf(!have(META))("Meta pixel code (fbevents)", () => {
  it("keeps _fbc's creation time for the same fbclid, uses a 90-day TTL and __DOT__ escaping", () => {
    const src = read(META);
    expect(src).toContain(
      'key:"maybeUpdatePayload",value:function(t){(this.payload===null||this.payload!==t)&&(this.payload=t,this.creationTime=i())}',
    );
    expect(src).toContain('p="__DOT__"');
    expect(src).toContain("h=2160*60*60*1e3");
    expect(TTL.fbcMs).toBe(2160 * 60 * 60 * 1e3);
  });
});

describe.skipIf(!have(TIKTOK))("TikTok pixel code", () => {
  it("keeps an existing ttclid cookie whose click id matches the URL (eB) and parses a 13-digit suffix (eq)", () => {
    const src = read(TIKTOK);
    expect(src).toContain('eB=function(t,e){return t?e&&eq(e).clickId===t?e:t+"."+J():""}');
    expect(src).toContain("eV=/^\\d{13}$/");
  });
});
