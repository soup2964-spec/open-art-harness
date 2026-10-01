import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { captureAttribution } from "../../src/capture.js";
import { buildAdClickIdsPayload } from "../../src/core/record.js";
import type { AttributionRecord } from "../../src/core/model.js";
import { MIN, T0, cookiesByName } from "../fixtures/helpers.js";
import { uboStrip } from "../fixtures/ubo.js";
import { fakeCtx, journey, makeRequest, run } from "./run.js";

// The teardown's synthetic landing (01 §1 "Params"), with every click id it used.
const FULL =
  "https://openart.ai/?utm_source=kj_audit&utm_medium=test&utm_campaign=audit_20260929" +
  "&gclid=KJAUDIT_G&fbclid=KJAUDIT_F&ttclid=KJAUDIT_T&msclkid=KJAUDIT_M&twclid=KJAUDIT_X" +
  "&gbraid=KJAUDIT_GB&wbraid=KJAUDIT_WB&li_fat_id=KJAUDIT_L&rdt_cid=KJAUDIT_R&oppref=KJAUDIT_O";

describe("uBlock Origin-stripped landings still produce a useful record", () => {
  it("the stripped URL keeps only utm, li_fat_id, rdt_cid and oppref (fixture sanity)", () => {
    expect(uboStrip(FULL)).toBe(
      "https://openart.ai/?utm_source=kj_audit&utm_medium=test&utm_campaign=audit_20260929&li_fat_id=KJAUDIT_L&rdt_cid=KJAUDIT_R&oppref=KJAUDIT_O",
    );
  });

  it("captures the campaign and the three surviving click ids server-side, where no blocker can reach", async () => {
    const r = await run(uboStrip(FULL));
    expect(r.record?.lastTouch).toMatchObject({
      type: "paid",
      clickKeys: ["li_fat_id", "rdt_cid", "oppref"],
      utm: { source: "kj_audit", medium: "test", campaign: "audit_20260929" },
    });
    expect(r.record?.clickIds).toEqual({
      li_fat_id: { v: "KJAUDIT_L", ts: T0 },
      rdt_cid: { v: "KJAUDIT_R", ts: T0 },
      oppref: { v: "KJAUDIT_O", ts: T0 },
    });
    const cookies = cookiesByName(r.setCookies);
    expect([...cookies.keys()].sort()).toEqual(["__oppref", "oa_ad_clids", "oa_attr"]);
    expect(Object.keys(JSON.parse(decodeURIComponent(cookies.get("oa_ad_clids")!.value))).sort()).toEqual([
      "li_fat_id",
      "oppref",
      "rdt_cid",
    ]);
  });

  it("fixes the ChatGPT-ads loss on marketing landings (T3a): __oppref exists before the app SDK runs", async () => {
    const { jar } = await journey([
      { url: uboStrip(FULL), at: T0 },
      { url: "https://openart.ai/home", at: T0 + MIN, referer: uboStrip(FULL) },
    ]);
    expect(jar).toContain("__oppref=KJAUDIT_O");
  });

  it("a landing with only manual utm tags left (auto-tagging stripped) is a campaign touch", async () => {
    const r = await run(uboStrip("https://openart.ai/?gclid=G&utm_source=google&utm_medium=cpc&utm_campaign=brand"));
    expect(r.record?.lastTouch).toMatchObject({ type: "campaign", utm: { source: "google", medium: "cpc", campaign: "brand" } });
    expect([...cookiesByName(r.setCookies).keys()]).toEqual(["oa_attr"]);
  });

  it("with every parameter stripped, the Referer still yields the channel", async () => {
    const r = await run(uboStrip("https://openart.ai/?gclid=G&gad_source=1"), { referer: "https://www.google.com/" });
    expect(r.record?.lastTouch).toMatchObject({ type: "referral", referrerHost: "www.google.com" });
  });

  it("the device-keyed record and the extended /api/user/ad-click-ids payload carry what survived", async () => {
    const id = crypto.randomUUID();
    const ctx = fakeCtx();
    await captureAttribution(makeRequest(uboStrip(FULL), { cookie: `oa_device_id=${id}` }), env as never, ctx, { now: () => T0 });
    await Promise.all(ctx.promises);
    const stored = (await env.ATTRIBUTION_KV.get<AttributionRecord>(`dev:${id}`, "json"))!;
    const payload = buildAdClickIdsPayload(stored);
    expect(payload).toMatchObject({
      device_id: id,
      li_fat_id: "KJAUDIT_L",
      li_fat_id_created_at: T0,
      rdt_cid: "KJAUDIT_R",
      rdt_cid_created_at: T0,
      oppref: "KJAUDIT_O",
      oppref_created_at: T0,
      attribution: { last_touch: { utm: { source: "kj_audit", medium: "test", campaign: "audit_20260929" } } },
    });
    expect(payload).not.toHaveProperty("gclid");
  });
});
