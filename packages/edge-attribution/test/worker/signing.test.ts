import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { attrSigningInput, encodeStatePayload } from "../../src/core/codec.js";
import type { AttributionState } from "../../src/core/model.js";
import { readSecrets, signAttrState, verifyAttrCookie } from "../../src/crypto.js";
import { base64urlToBytes, bytesToBase64url } from "../../src/core/base64url.js";
import { DAY, T0, cookiesByName } from "../fixtures/helpers.js";
import { TEST_SECRET, TEST_SECRET_PREVIOUS } from "../fixtures/secrets.js";
import { run } from "./run.js";

const secrets = { current: TEST_SECRET, previous: TEST_SECRET_PREVIOUS };

function state(overrides: Partial<AttributionState> = {}): AttributionState {
  const touch = {
    at: T0,
    type: "paid" as const,
    utm: { source: "google", medium: "cpc" },
    clickKeys: ["gclid" as const],
    referrerHost: "www.google.com",
    landingPath: "/",
    inAppBrowser: null,
    seenBefore: false,
    recovered: false,
  };
  return {
    createdAt: T0,
    firstTouch: touch,
    lastTouch: touch,
    clickIds: { gclid: { v: "G1", ts: T0 } },
    consentMode: "full",
    persistedAt: null,
    handoffFrom: null,
    ...overrides,
  };
}

/** Flip one base64url character in a segment without changing its length. */
function flip(segment: string, at = 5): string {
  const c = segment[at]!;
  return segment.slice(0, at) + (c === "A" ? "B" : "A") + segment.slice(at + 1);
}

describe("HMAC signing and verification", () => {
  it("round-trips: sign then verify returns the same state", async () => {
    const s = state();
    const value = await signAttrState(s, TEST_SECRET);
    expect(value).toMatch(/^1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyAttrCookie(value, secrets, T0 + DAY)).toEqual({ state: s, needsResign: false });
  });

  it("is plain HMAC-SHA256 over 'oa_attr.1.<payload>' so any backend can verify it", async () => {
    const s = state();
    const value = await signAttrState(s, TEST_SECRET);
    const [, payload, tag] = value.split(".") as [string, string, string];
    expect(payload).toBe(encodeStatePayload(s));
    expect(attrSigningInput(payload)).toBe(`oa_attr.1.${payload}`);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(TEST_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`oa_attr.1.${payload}`)));
    expect(tag).toBe(bytesToBase64url(mac));
  });

  it("stores a last touch identical to the first touch by reference (compact encoding)", async () => {
    const s = state();
    const json = JSON.parse(new TextDecoder().decode(base64urlToBytes(encodeStatePayload(s))!)) as Record<string, unknown>;
    expect(json.l).toBe("f");
    const distinct = state({ lastTouch: { ...state().firstTouch, at: T0 + 1000, utm: { source: "bing" } } });
    const json2 = JSON.parse(new TextDecoder().decode(base64urlToBytes(encodeStatePayload(distinct))!)) as Record<string, unknown>;
    expect(typeof json2.l).toBe("object");
    expect((await verifyAttrCookie(await signAttrState(distinct, TEST_SECRET), secrets, T0 + DAY))?.state).toEqual(distinct);
  });

  it("rejects a tampered payload", async () => {
    const [v, p, t] = (await signAttrState(state(), TEST_SECRET)).split(".") as [string, string, string];
    expect(await verifyAttrCookie(`${v}.${flip(p)}.${t}`, secrets, T0)).toBeNull();
  });

  it("rejects a tampered or truncated signature", async () => {
    const [v, p, t] = (await signAttrState(state(), TEST_SECRET)).split(".") as [string, string, string];
    expect(await verifyAttrCookie(`${v}.${p}.${flip(t)}`, secrets, T0)).toBeNull();
    expect(await verifyAttrCookie(`${v}.${p}.${t.slice(0, 22)}`, secrets, T0)).toBeNull();
  });

  it("rejects a payload re-signed without the domain-separation prefix", async () => {
    const payload = encodeStatePayload(state());
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bare = bytesToBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
    expect(await verifyAttrCookie(`1.${payload}.${bare}`, secrets, T0)).toBeNull();
  });

  it("rejects a value signed with an unknown secret", async () => {
    const value = await signAttrState(state(), "some-other-secret-that-is-long-enough-000");
    expect(await verifyAttrCookie(value, secrets, T0)).toBeNull();
  });

  it("accepts the previous secret during rotation and asks for a re-sign", async () => {
    const s = state();
    const value = await signAttrState(s, TEST_SECRET_PREVIOUS);
    expect(await verifyAttrCookie(value, secrets, T0)).toEqual({ state: s, needsResign: true });
    expect(await verifyAttrCookie(value, { current: TEST_SECRET }, T0)).toBeNull();
  });

  it("rejects records past the 13-month lifetime and records from the future", async () => {
    const value = await signAttrState(state(), TEST_SECRET);
    expect(await verifyAttrCookie(value, secrets, T0 + 389 * DAY)).not.toBeNull();
    expect(await verifyAttrCookie(value, secrets, T0 + 390 * DAY + 1)).toBeNull();
    expect(await verifyAttrCookie(value, secrets, T0 - DAY)).toBeNull();
  });

  it("rejects malformed values without throwing", async () => {
    for (const bad of [undefined, "", "1", "1.x", "2.a.b", "1..", "1.!!!.@@@", "1.e30.AAAA", `1.${"A".repeat(5000)}.x`]) {
      expect(await verifyAttrCookie(bad, secrets, T0)).toBeNull();
    }
  });

  it("rejects correctly signed payloads that violate the schema (defence in depth)", async () => {
    const bad: unknown[] = [
      { ...state(), consentMode: "utm-only" }, // utm-only records must not carry click ids
      { ...state(), clickIds: { gclid: { v: "has space", ts: T0 } } },
      { ...state(), clickIds: { notaclick: { v: "x", ts: T0 } } },
      { ...state(), firstTouch: { ...state().firstTouch, type: "bogus" } },
    ];
    for (const s of bad) {
      const value = await signAttrState(s as AttributionState, TEST_SECRET);
      expect(await verifyAttrCookie(value, secrets, T0)).toBeNull();
    }
  });
});

describe("defence in depth on validly signed input", () => {
  async function signRaw(json: string): Promise<string> {
    const payload = bytesToBase64url(new TextEncoder().encode(json));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const tag = bytesToBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`oa_attr.1.${payload}`))));
    return `1.${payload}.${tag}`;
  }

  it("rejects inherited-property names used as enum codes (constructor, __proto__, toString)", async () => {
    const touch = (t: string, u: Record<string, string> = {}) => ({ a: T0, t, p: "/", u });
    for (const bad of [
      { v: 1, c: T0, f: touch("constructor"), m: "f" },
      { v: 1, c: T0, f: touch("c", { constructor: "x" }), m: "f" },
      { v: 1, c: T0, f: touch("c", { __proto__: "x" } as never), m: "f" },
      { v: 1, c: T0, f: touch("toString"), m: "f" },
    ]) {
      expect(await verifyAttrCookie(await signRaw(JSON.stringify(bad)), secrets, T0)).toBeNull();
    }
  });

  it("refuses placeholder and low-entropy secrets (fail closed)", () => {
    expect(readSecrets({ ATTRIBUTION_SECRET: "replace-with-32-or-more-random-characters" })).toBeNull();
    expect(readSecrets({ ATTRIBUTION_SECRET: "a".repeat(64) })).toBeNull();
    expect(readSecrets({ ATTRIBUTION_SECRET: "abababababababababababababababababab" })).toBeNull();
    expect(readSecrets({ ATTRIBUTION_SECRET: TEST_SECRET })).not.toBeNull();
  });
});

describe("signing inside the capture flow", () => {
  it("ignores a forged oa_attr (bad signature) and starts a fresh first touch from the real request", async () => {
    const forged = await signAttrState(
      state({ firstTouch: { ...state().firstTouch, utm: { source: "affiliate-x" } } }),
      "attacker-guessed-secret-000000000000000000",
    );
    const r = await run("https://openart.ai/?utm_source=google", { cookie: `oa_attr=${forged}` });
    expect(r.record?.firstTouch.utm).toEqual({ source: "google" });
    expect(r.changes).toContain("attr:invalid-ignored");
  });

  it("re-signs a cookie signed with the previous secret using the current one", async () => {
    const old = await signAttrState(state(), TEST_SECRET_PREVIOUS);
    const r = await run("https://openart.ai/home", { cookie: `oa_attr=${old}`, now: T0 + DAY });
    const fresh = cookiesByName(r.setCookies).get("oa_attr")!.value;
    expect(await verifyAttrCookie(fresh, { current: TEST_SECRET }, T0 + DAY)).not.toBeNull();
    expect(r.record?.firstTouch.utm).toEqual({ source: "google", medium: "cpc" });
  });

  it("fails closed and passes through when the secret is missing or too short", async () => {
    const onError = vi.fn();
    for (const secret of [undefined, "short"]) {
      const r = await run("https://openart.ai/?gclid=G1", {
        env: { ...env, ATTRIBUTION_SECRET: secret },
        options: { onError },
      });
      expect(r.skipped).toBe("misconfigured");
      expect(r.setCookies).toEqual([]);
    }
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
