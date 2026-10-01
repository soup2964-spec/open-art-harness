import { describe, expect, it } from "vitest";
import { mergeAttributionForSignup } from "../../src/merge.js";
import { buildAdClickIdsPayload } from "../../src/core/record.js";
import type { AttributionRecord, Touch } from "../../src/core/model.js";
import { DAY, HOUR, MIN, T0, suiteBuildMigrationPayload } from "../fixtures/helpers.js";

function touch(at: number, over: Partial<Touch> = {}): Touch {
  return {
    at,
    type: "paid",
    utm: null,
    clickKeys: [],
    referrerHost: null,
    landingPath: "/",
    inAppBrowser: null,
    seenBefore: false,
    recovered: false,
    ...over,
  };
}

function rec(over: Partial<AttributionRecord>): AttributionRecord {
  const first = over.firstTouch ?? touch(T0);
  return {
    schema: "oa_attr/1",
    createdAt: first.at,
    expiresAt: first.at + 390 * DAY,
    updatedAt: first.at,
    firstTouch: first,
    lastTouch: first.type === "direct" ? null : first,
    clickIds: {},
    fbc: null,
    consent: { mode: "full", region: "unregulated", explicit: false, gpc: false, signals: {} },
    deviceId: "dev-1",
    handoffFrom: null,
    ...over,
  };
}

const kvSnapshot = rec({
  firstTouch: touch(T0, { type: "paid", utm: { source: "meta" }, clickKeys: ["fbclid"] }),
  clickIds: { fbclid: { v: "F1", ts: T0 } },
  fbc: `fb.1.${T0}.F1`,
  updatedAt: T0,
});
const cookieNow = rec({
  firstTouch: touch(T0, { type: "paid", utm: { source: "meta" }, clickKeys: ["fbclid"] }),
  lastTouch: touch(T0 + 2 * DAY, { type: "paid", utm: { source: "google" }, clickKeys: ["gclid"] }),
  clickIds: { fbclid: { v: "F1", ts: T0 }, gclid: { v: "G1", ts: T0 + 2 * DAY } },
  fbc: `fb.1.${T0}.F1`,
  updatedAt: T0 + 2 * DAY,
});

describe("mergeAttributionForSignup", () => {
  it("combines the verified cookie and the device-keyed record: earliest first touch, latest last touch, newest click per platform", () => {
    const { record } = mergeAttributionForSignup({ records: [kvSnapshot, cookieNow], signupAt: T0 + 3 * DAY, deviceId: "dev-1" });
    expect(record?.firstTouch).toEqual(kvSnapshot.firstTouch);
    expect(record?.lastTouch).toEqual(cookieNow.lastTouch);
    expect(record?.clickIds).toEqual({ fbclid: { v: "F1", ts: T0 }, gclid: { v: "G1", ts: T0 + 2 * DAY } });
    expect(record?.fbc).toBe(`fb.1.${T0}.F1`);
    expect(record?.createdAt).toBe(T0);
  });

  it("is order-independent and idempotent", () => {
    const a = mergeAttributionForSignup({ records: [kvSnapshot, cookieNow], signupAt: T0 + 3 * DAY });
    const b = mergeAttributionForSignup({ records: [cookieNow, kvSnapshot, cookieNow, null, undefined], signupAt: T0 + 3 * DAY });
    expect(b).toEqual(a);
  });

  it("merges the webview record handed off to the external browser (lineage kept)", () => {
    const webview = rec({
      deviceId: "dev-webview",
      firstTouch: touch(T0, { utm: { source: "ig" }, clickKeys: ["fbclid", "ttclid"], inAppBrowser: "instagram" }),
      clickIds: { fbclid: { v: "F1", ts: T0 }, ttclid: { v: "T1", ts: T0 } },
    });
    const external = rec({
      deviceId: "dev-safari",
      firstTouch: touch(T0 - 30 * DAY, { type: "direct" }),
      lastTouch: touch(T0, { utm: { source: "ig" }, clickKeys: ["fbclid", "ttclid"], inAppBrowser: "instagram" }),
      clickIds: { fbclid: { v: "F1", ts: T0 }, ttclid: { v: "T1", ts: T0 } },
      handoffFrom: "dev-webview",
      updatedAt: T0 + 5 * MIN,
    });
    const { record } = mergeAttributionForSignup({ records: [webview, external], signupAt: T0 + 10 * MIN, deviceId: "dev-safari" });
    expect(record?.firstTouch.type).toBe("direct");
    expect(record?.lastTouch?.inAppBrowser).toBe("instagram");
    expect(record?.handoffFrom).toBe("dev-webview");
    expect(record?.deviceId).toBe("dev-safari");
  });

  it("ignores touches and click ids observed after signup", () => {
    const later = rec({
      firstTouch: touch(T0, { utm: { source: "meta" }, clickKeys: ["fbclid"] }),
      lastTouch: touch(T0 + 5 * DAY, { utm: { source: "retargeting" }, clickKeys: ["gclid"] }),
      clickIds: { fbclid: { v: "F1", ts: T0 }, gclid: { v: "G-after", ts: T0 + 5 * DAY } },
    });
    const { record } = mergeAttributionForSignup({ records: [later], signupAt: T0 + DAY });
    expect(record?.lastTouch).toEqual(later.firstTouch);
    expect(record?.clickIds).toEqual({ fbclid: { v: "F1", ts: T0 } });
  });

  it("never replaces a first touch already stored on the user", () => {
    const existing = rec({ firstTouch: touch(T0 + DAY, { utm: { source: "podcast" }, type: "campaign" }) });
    const { record } = mergeAttributionForSignup({ existing, records: [kvSnapshot], signupAt: T0 + 3 * DAY });
    expect(record?.firstTouch.utm).toEqual({ source: "podcast" });
  });

  it("strips identifiers when the consent at signup is utm-only", () => {
    const { record, payload } = mergeAttributionForSignup({ records: [cookieNow], signupAt: T0 + 3 * DAY, consentMode: "utm-only" });
    expect(record?.clickIds).toEqual({});
    expect(record?.fbc).toBeNull();
    expect(record?.consent.mode).toBe("utm-only");
    expect(payload).not.toHaveProperty("gclid");
    expect(payload?.attribution.last_touch?.utm).toEqual({ source: "google" });
  });

  describe("binding device records to the signed cookie (device ids are client-held)", () => {
    const cookie = rec({
      deviceId: "dev-victim",
      firstTouch: touch(T0, { utm: { source: "meta" }, clickKeys: ["fbclid"] }),
      lastTouch: touch(T0 + HOUR, { utm: { source: "meta" }, clickKeys: ["fbclid"] }),
      clickIds: { fbclid: { v: "F1", ts: T0 } },
      updatedAt: T0 + HOUR,
    });

    it("ignores a device record from another lineage (someone replaying the victim's oa_device_id)", () => {
      const poisoned = rec({
        deviceId: "dev-victim",
        createdAt: T0 + 2 * HOUR,
        firstTouch: touch(T0 + 2 * HOUR, { utm: { source: "affiliate-x" }, clickKeys: ["irclickid"] }),
        clickIds: { irclickid: { v: "STOLEN", ts: T0 + 2 * HOUR } },
        updatedAt: T0 + 2 * HOUR,
      });
      const { record } = mergeAttributionForSignup({ cookie, records: [poisoned], signupAt: T0 + 3 * HOUR });
      expect(record?.lastTouch).toEqual(cookie.lastTouch);
      expect(record?.clickIds).toEqual({ fbclid: { v: "F1", ts: T0 } });
    });

    it("merges device records of the same lineage (same createdAt, set only by the edge)", () => {
      const snapshot = rec({
        deviceId: "dev-victim",
        firstTouch: touch(T0, { utm: { source: "meta" }, clickKeys: ["fbclid"] }),
        clickIds: { fbclid: { v: "F1", ts: T0 }, gbraid: { v: "GB1", ts: T0 } },
      });
      const { record } = mergeAttributionForSignup({ cookie, records: [snapshot], signupAt: T0 + 3 * HOUR });
      expect(record?.clickIds.gbraid).toEqual({ v: "GB1", ts: T0 });
    });

    it("merges the handed-off webview record only when the signed cookie names that device", () => {
      const external = { ...cookie, createdAt: T0 - 30 * DAY, firstTouch: touch(T0 - 30 * DAY, { type: "direct" }), handoffFrom: "dev-webview" };
      const webview = rec({ deviceId: "dev-webview", firstTouch: touch(T0, { utm: { source: "ig" }, clickKeys: ["ttclid"] }), clickIds: { ttclid: { v: "T1", ts: T0 } } });
      const stranger = rec({ deviceId: "dev-other", firstTouch: touch(T0, { utm: { source: "x" }, clickKeys: ["twclid"] }), clickIds: { twclid: { v: "X1", ts: T0 } } });
      const { record } = mergeAttributionForSignup({ cookie: external, records: [webview, stranger], signupAt: T0 + 3 * HOUR });
      expect(record?.clickIds.ttclid).toEqual({ v: "T1", ts: T0 });
      expect(record?.clickIds.twclid).toBeUndefined();
    });

    it("without a cookie (cleared at signup) falls back to every device record", () => {
      const { record } = mergeAttributionForSignup({ records: [cookie], signupAt: T0 + 3 * HOUR });
      expect(record?.lastTouch).toEqual(cookie.lastTouch);
    });
  });

  it("returns nulls when there is nothing to merge", () => {
    expect(mergeAttributionForSignup({ records: [null, undefined], signupAt: T0 })).toEqual({ record: null, payload: null, storeRecord: null });
  });

  it("emits the extended /api/user/ad-click-ids payload: legacy keys unchanged, new keys alongside", () => {
    const { payload } = mergeAttributionForSignup({ records: [cookieNow], signupAt: T0 + 3 * DAY, deviceId: "dev-1" });
    const legacy = suiteBuildMigrationPayload({ fbclid: { v: "F1", ts: T0 }, gclid: { v: "G1", ts: T0 + 2 * DAY } }).payload;
    for (const [k, v] of Object.entries(legacy)) expect(payload?.[k as keyof typeof payload], k).toBe(v);
    expect(payload).toMatchObject({ device_id: "dev-1", fbc: `fb.1.${T0}.F1`, attribution: { schema: "oa_attr/1", source: "edge" } });
    expect(buildAdClickIdsPayload(cookieNow)).toMatchObject({ gclid: "G1", gclid_created_at: T0 + 2 * DAY });
  });
});
