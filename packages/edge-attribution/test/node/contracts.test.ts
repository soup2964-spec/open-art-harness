// Interop with packages/contracts: what the edge hands the backend must validate against the
// shared ClickIdStoreRecordExtended schema that conversion-service reads. Skipped if the
// contracts package cannot be loaded.
import { describe, expect, it } from "vitest";
import { captureAttribution } from "../../src/capture.js";
import { toClickIdStoreRecordExtended } from "../../src/core/record.js";
import { mergeAttributionForSignup } from "../../src/merge.js";
import { originEndpointPersistence, verifyOriginSignature } from "../../src/persistence.js";
import { DAY, T0, navHeaders } from "../fixtures/helpers.js";
import { TEST_SECRET } from "../fixtures/secrets.js";

type Contracts = typeof import("@openart-signal/contracts");
const contracts = (await import("@openart-signal/contracts").catch(() => null)) as Contracts | null;

function fakeCtx() {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (p: Promise<unknown>) => void promises.push(p), passThroughOnException() {}, props: {} };
}

async function capture(url: string, extraHeaders: Record<string, string> = {}, now = T0) {
  const req = new Request(url, { headers: navHeaders(extraHeaders) });
  Object.defineProperty(req, "cf", { value: { country: "US" } });
  return captureAttribution(req, { ATTRIBUTION_SECRET: TEST_SECRET } as never, fakeCtx() as never, { now: () => now, persistence: false });
}

describe.skipIf(!contracts)("ClickIdStoreRecordExtended (packages/contracts)", () => {
  it("the converted record passes the shared strict schema and round-trips through clickIdsFromStoreRecord", async () => {
    const r = await capture(
      "https://openart.ai/ai-model/seedance-2-0/?gclid=G1&gbraid=GB1&fbclid=F1&ttclid=T1&rdt_cid=R1&oppref=O1&epik=P1&utm_source=google&utm_campaign=seedance",
      { referer: "https://www.google.com/" },
    );
    const store = toClickIdStoreRecordExtended(r.record!);
    const parsed = contracts!.ClickIdStoreRecordExtendedSchema.safeParse(store);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(store).toMatchObject({
      gclid: "G1",
      gclid_created_at: T0,
      gbraid: "GB1",
      rdt_cid: "R1",
      oppref: "O1",
      utm_source: "google",
      utm_campaign: "seedance",
      landing_url: "https://openart.ai/ai-model/seedance-2-0/",
      referrer: "https://www.google.com/",
      context_captured_at: T0,
    });
    expect(store).not.toHaveProperty("epik"); // not in the contract's key set: stays in the richer payload
    const ids = contracts!.clickIdsFromStoreRecord(store);
    expect(ids.fbclid).toEqual({ value: "F1", created_at: new Date(T0).toISOString() });
    expect(contracts!.utmFromStoreRecord(store)).toEqual({ utm_source: "google", utm_campaign: "seedance" });
  });

  it("our _fbc equals the contract's buildMetaFbc for the same first-seen time", async () => {
    const r = await capture("https://openart.ai/?fbclid=IwAR0abc");
    expect(r.record!.fbc).toBe(contracts!.buildMetaFbc("IwAR0abc", T0));
  });

  it("a direct, utm-less record still validates (context only)", async () => {
    const r = await capture("https://openart.ai/pricing");
    const parsed = contracts!.ClickIdStoreRecordExtendedSchema.safeParse(toClickIdStoreRecordExtended(r.record!));
    expect(parsed.success).toBe(true);
  });

  it("mergeAttributionForSignup also returns the store record in the contract shape", async () => {
    const a = await capture("https://openart.ai/?gclid=G1&utm_source=google", {}, T0);
    const { storeRecord } = mergeAttributionForSignup({ cookie: a.record, records: [], signupAt: T0 + DAY });
    expect(contracts!.ClickIdStoreRecordExtendedSchema.safeParse(storeRecord).success).toBe(true);
    expect(storeRecord).toMatchObject({ gclid: "G1", utm_source: "google" });
  });

  it("the origin adapter can post the contract shape, with the device id in a signed header", async () => {
    const calls: Request[] = [];
    const adapter = originEndpointPersistence({
      url: "https://origin.internal/api/internal/attribution",
      format: "contract",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(null, { status: 204 });
      },
    });
    const r = await capture("https://openart.ai/?gclid=G1");
    await adapter.persist({ record: r.record!, deviceId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", env: { ATTRIBUTION_SECRET: TEST_SECRET }, now: T0 });
    const req = calls[0]!;
    const body = await req.text();
    expect(contracts!.ClickIdStoreRecordExtendedSchema.safeParse(JSON.parse(body)).success).toBe(true);
    const device = req.headers.get("x-oa-device-id")!;
    expect(device).toBe("0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0");
    const ts = req.headers.get("x-oa-attribution-timestamp")!;
    const sig = req.headers.get("x-oa-attribution-signature")!;
    expect(await verifyOriginSignature(body, ts, sig, TEST_SECRET, T0, undefined, device)).toBe(true);
    expect(await verifyOriginSignature(body, ts, sig, TEST_SECRET, T0, undefined, "someone-else-0000")).toBe(false);
  });
});
