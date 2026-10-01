import { describe, expect, it } from "vitest";
import { DAY, MIN, T0, UA } from "../fixtures/helpers.js";
import { journey, run } from "./run.js";

describe("first touch / last touch", () => {
  it("a campaign landing becomes both first and last touch", async () => {
    const r = await run("https://openart.ai/ai-video-generator/?utm_source=newsletter&utm_campaign=sept", {
      referer: "https://mail.google.com/",
    });
    const expected = {
      at: T0,
      type: "campaign",
      utm: { source: "newsletter", campaign: "sept" },
      clickKeys: [],
      referrerHost: "mail.google.com",
      landingPath: "/ai-video-generator/",
      inAppBrowser: null,
      seenBefore: false,
      recovered: false,
    };
    expect(r.record?.firstTouch).toEqual(expected);
    expect(r.record?.lastTouch).toEqual(expected);
    expect(r.changes).toEqual(expect.arrayContaining(["first-touch", "last-touch"]));
  });

  it("a paid click outranks utm for the touch type and records which platforms were present", async () => {
    const r = await run("https://openart.ai/?utm_source=google&gclid=G1&gbraid=GB1");
    expect(r.record?.lastTouch).toMatchObject({ type: "paid", clickKeys: ["gclid", "gbraid"], utm: { source: "google" } });
  });

  it("direct and internal navigations never move the last touch", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?utm_source=meta", at: T0 },
      { url: "https://openart.ai/home", at: T0 + MIN, referer: "https://openart.ai/?utm_source=meta" },
      { url: "https://openart.ai/pricing", at: T0 + 2 * DAY },
    ]);
    // step 2's Referer carries the landing's utm: recovered, but identical to the stored touch, so ignored
    expect(results[1]!.record?.lastTouch?.at).toBe(T0);
    expect(results[2]!.record?.lastTouch?.at).toBe(T0);
    expect(results[2]!.changes).not.toContain("last-touch");
  });

  it("a later campaign updates only the last touch; the first touch is immutable", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?utm_source=tiktok&ttclid=T1", at: T0 },
      { url: "https://openart.ai/?utm_source=google&gclid=G1", at: T0 + 3 * DAY },
      { url: "https://openart.ai/blog/", at: T0 + 4 * DAY, referer: "https://chatgpt.com/" },
    ]);
    const last = results[2]!.record!;
    expect(last.firstTouch).toMatchObject({ at: T0, type: "paid", clickKeys: ["ttclid"], utm: { source: "tiktok" } });
    expect(last.lastTouch).toMatchObject({ at: T0 + 4 * DAY, type: "referral", referrerHost: "chatgpt.com", landingPath: "/blog/" });
    expect(last.clickIds).toMatchObject({ ttclid: { v: "T1", ts: T0 }, gclid: { v: "G1", ts: T0 + 3 * DAY } });
  });

  it("returns from Stripe Checkout or OAuth do not clobber the last touch", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?utm_source=meta&fbclid=F1", at: T0 },
      { url: "https://openart.ai/home?success=subscription_purchased", at: T0 + HOURS(1), referer: "https://checkout.stripe.com/" },
      { url: "https://openart.ai/home", at: T0 + HOURS(2), referer: "https://accounts.google.com/" },
    ]);
    expect(results[2]!.record?.lastTouch).toMatchObject({ at: T0, type: "paid", utm: { source: "meta" } });
  });

  it("a reload inside 30 minutes is the same touch; the same link after 30 minutes is a new visit", async () => {
    const url = "https://openart.ai/?utm_source=newsletter";
    const { results } = await journey([
      { url, at: T0 },
      { url, at: T0 + 10 * MIN },
      { url, at: T0 + 45 * MIN },
    ]);
    expect(results[1]!.record?.lastTouch?.at).toBe(T0);
    expect(results[1]!.setCookies).toEqual([]);
    expect(results[2]!.record?.lastTouch?.at).toBe(T0 + 45 * MIN);
    expect(results[2]!.record?.firstTouch.at).toBe(T0);
  });

  it("a stale landing tab (its URL on the Referer) never flips the last touch back to the first touch", async () => {
    const { jar } = await journey([
      { url: "https://openart.ai/?utm_source=a", at: T0 },
      { url: "https://openart.ai/?utm_source=b", at: T0 + DAY },
    ]);
    const r = await run("https://openart.ai/pricing", { cookie: jar, referer: "https://openart.ai/?utm_source=a", now: T0 + 2 * DAY });
    expect(r.record?.lastTouch).toMatchObject({ at: T0 + DAY, utm: { source: "b" } });
    expect(r.setCookies).toEqual([]);
  });

  it("a new click on the same campaign inside 30 minutes is a new arrival (new click id value)", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?utm_source=google&gclid=A", at: T0 },
      { url: "https://openart.ai/?utm_source=google&gclid=B", at: T0 + 5 * MIN },
    ]);
    expect(results[1]!.record?.lastTouch?.at).toBe(T0 + 5 * MIN);
    expect(results[1]!.record?.clickIds.gclid).toEqual({ v: "B", ts: T0 + 5 * MIN });
  });

  it("boundaries: the same link is one touch until exactly 30 minutes, then a new one", async () => {
    const url = "https://openart.ai/?utm_source=newsletter";
    const { results } = await journey([
      { url, at: T0 },
      { url, at: T0 + 30 * MIN - 1 },
      { url, at: T0 + 60 * MIN - 1 },
    ]);
    expect(results[1]!.record?.lastTouch?.at).toBe(T0);
    expect(results[2]!.record?.lastTouch?.at).toBe(T0 + 60 * MIN - 1);
  });

  it("a direct first visit is recorded as the first touch with no last touch until a marketing touch arrives", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/", at: T0 },
      { url: "https://openart.ai/?utm_source=reddit&rdt_cid=R1", at: T0 + DAY },
    ]);
    expect(results[0]!.record?.firstTouch).toMatchObject({ type: "direct", landingPath: "/" });
    expect(results[0]!.record?.lastTouch).toBeNull();
    expect(results[1]!.record?.firstTouch.type).toBe("direct");
    expect(results[1]!.record?.lastTouch).toMatchObject({ type: "paid", clickKeys: ["rdt_cid"] });
  });

  it("flags visitors who already had an OpenArt device id when first observed (left-censored first touch)", async () => {
    const r = await run("https://openart.ai/home", { cookie: "oa_device_id=51e60b80-46f8-48c2-9780-f92e903bf8f8" });
    expect(r.record?.firstTouch.seenBefore).toBe(true);
  });

  it("records the in-app browser on the touch (T11: Instagram, TikTok)", async () => {
    const r = await run("https://openart.ai/?fbclid=F1&utm_source=ig", { ua: UA.instagram });
    expect(r.record?.lastTouch?.inAppBrowser).toBe("instagram");
  });

  it("starts a new record once the 13-month lifetime has passed", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?utm_source=old", at: T0 },
      { url: "https://openart.ai/?utm_source=new", at: T0 + 391 * DAY },
    ]);
    expect(results[1]!.record?.firstTouch).toMatchObject({ at: T0 + 391 * DAY, utm: { source: "new" } });
    expect(results[1]!.record?.createdAt).toBe(T0 + 391 * DAY);
  });

  it("the first touch survives a long, many-campaign journey", async () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      url: `https://openart.ai/?utm_source=s${i}&utm_campaign=c${i}`,
      at: T0 + i * DAY,
    }));
    const { results } = await journey(steps);
    const final = results.at(-1)!.record!;
    expect(final.firstTouch.utm).toEqual({ source: "s0", campaign: "c0" });
    expect(final.lastTouch?.utm).toEqual({ source: "s11", campaign: "c11" });
  });
});

function HOURS(n: number): number {
  return n * 60 * MIN;
}
