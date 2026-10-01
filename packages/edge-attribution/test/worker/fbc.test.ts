import { describe, expect, it } from "vitest";
import { DAY, MIN, T0, applyToJar, cookiesByName, metaUnpackFbc } from "../fixtures/helpers.js";
import { journey, run } from "./run.js";

const fbcOf = (setCookies: readonly string[]) => cookiesByName(setCookies).get("_fbc")?.value;
const dropCookie = (jar: string, name: string) =>
  jar
    .split("; ")
    .filter((p) => p && !p.startsWith(`${name}=`))
    .join("; ");

describe("_fbc minting follows Meta's rules", () => {
  it("new fbclid, no _fbc: mints fb.1.<now ms>.<fbclid>", async () => {
    const r = await run("https://openart.ai/?fbclid=IwAR0abc");
    expect(fbcOf(r.setCookies)).toBe(`fb.1.${T0}.IwAR0abc`);
    expect(r.record?.fbc).toBe(`fb.1.${T0}.IwAR0abc`);
  });

  it("same fbclid as the existing _fbc: keeps the original value and timestamp (no Set-Cookie)", async () => {
    const pixelSet = `fb.1.${T0 - 3 * DAY}.IwAR0abc`;
    const r = await run("https://openart.ai/suite/video?fbclid=IwAR0abc", { cookie: `_fbc=${pixelSet}` });
    expect(fbcOf(r.setCookies)).toBeUndefined();
    expect(r.record?.fbc).toBe(pixelSet);
    expect(r.record?.clickIds.fbclid).toEqual({ v: "IwAR0abc", ts: T0 - 3 * DAY });
  });

  it("reloading the landing URL does not re-mint", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?fbclid=F1", at: T0 },
      { url: "https://openart.ai/?fbclid=F1", at: T0 + MIN },
    ]);
    expect(fbcOf(results[1]!.setCookies)).toBeUndefined();
    expect(results[1]!.record?.fbc).toBe(`fb.1.${T0}.F1`);
  });

  it("a different fbclid replaces the value with a new timestamp; the most recent click always wins", async () => {
    const { results } = await journey([
      { url: "https://openart.ai/?fbclid=F1", at: T0 },
      { url: "https://openart.ai/?fbclid=F2", at: T0 + DAY },
      { url: "https://openart.ai/?fbclid=F1", at: T0 + 2 * DAY },
    ]);
    expect(fbcOf(results[1]!.setCookies)).toBe(`fb.1.${T0 + DAY}.F2`);
    // Meta's maybeUpdatePayload compares with the current cookie only: F1 again is "new".
    expect(fbcOf(results[2]!.setCookies)).toBe(`fb.1.${T0 + 2 * DAY}.F1`);
  });

  it("fixes the multi-hop loss (T1f): _fbc exists before the app pageview even two hops after the landing", async () => {
    const { jar, results } = await journey([
      { url: "https://openart.ai/?utm_source=meta&fbclid=KJAUDIT_F", at: T0 },
      { url: "https://openart.ai/ai-model/seedance-2-5/", at: T0 + MIN, referer: "https://openart.ai/?utm_source=meta&fbclid=KJAUDIT_F" },
      { url: "https://openart.ai/home", at: T0 + 2 * MIN, referer: "https://openart.ai/ai-model/seedance-2-5/" },
    ]);
    expect(jar).toContain(`_fbc=fb.1.${T0}.KJAUDIT_F`);
    expect(results[2]!.record?.fbc).toBe(`fb.1.${T0}.KJAUDIT_F`);
  });

  it("fixes the typed-return loss (T1g) and ITP deletion: restores _fbc with the ORIGINAL timestamp", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?fbclid=KJAUDIT_F", at: T0 }]);
    const afterItp = dropCookie(jar, "_fbc"); // script-set copy deleted after 7 days
    const r = await run("https://openart.ai/home", { cookie: afterItp, now: T0 + 8 * DAY });
    expect(fbcOf(r.setCookies)).toBe(`fb.1.${T0}.KJAUDIT_F`);
  });

  it("does not restore an fbclid older than 90 days", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?fbclid=OLD", at: T0 }]);
    const r = await run("https://openart.ai/home", { cookie: dropCookie(jar, "_fbc"), now: T0 + 91 * DAY });
    expect(fbcOf(r.setCookies)).toBeUndefined();
    expect(r.record?.fbc).toBeNull();
    expect(r.record?.clickIds.fbclid).toBeUndefined();
  });

  it("an expired observation is forgotten: the same fbclid on a new landing after 90 days gets a fresh timestamp", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?fbclid=F1", at: T0 }]);
    const stripped = dropCookie(dropCookie(jar, "_fbc"), "oa_ad_clids");
    const r = await run("https://openart.ai/?fbclid=F1", { cookie: stripped, now: T0 + 100 * DAY });
    expect(r.record?.clickIds.fbclid).toEqual({ v: "F1", ts: T0 + 100 * DAY });
    expect(fbcOf(r.setCookies)).toBe(`fb.1.${T0 + 100 * DAY}.F1`);
  });

  it("a stale fbclid on a same-origin Referer never overrides a newer click", async () => {
    const { jar } = await journey([
      { url: "https://openart.ai/?fbclid=F1", at: T0 },
      { url: "https://openart.ai/?fbclid=F2", at: T0 + DAY },
    ]);
    const r = await run("https://openart.ai/home", { cookie: jar, referer: "https://openart.ai/?fbclid=F1", now: T0 + 2 * DAY });
    expect(r.record?.clickIds.fbclid).toEqual({ v: "F2", ts: T0 + DAY });
    expect(fbcOf(r.setCookies)).toBeUndefined();
  });

  it("escapes dots the way the pixel packs them (fbclid payload a.b -> a__DOT__b)", async () => {
    const r = await run("https://openart.ai/?fbclid=a.b");
    const value = fbcOf(r.setCookies)!;
    expect(value).toBe(`fb.1.${T0}.a__DOT__b`);
    expect(metaUnpackFbc(value)?.payload).toBe("a.b");
  });

  it("keeps an existing _fbc that carries a Parameter-Builder appendix when the fbclid matches", async () => {
    const withAppendix = `fb.1.${T0 - DAY}.F1.AQ`;
    const r = await run("https://openart.ai/?fbclid=F1", { cookie: `_fbc=${withAppendix}` });
    expect(fbcOf(r.setCookies)).toBeUndefined();
    expect(r.record?.fbc).toBe(withAppendix);
  });

  it("replaces a malformed _fbc", async () => {
    const r = await run("https://openart.ai/?fbclid=F1", { cookie: "_fbc=garbage" });
    expect(fbcOf(r.setCookies)).toBe(`fb.1.${T0}.F1`);
  });

  it("imports an existing pixel-set _fbc into the vault when the edge never saw that click (pre-deploy visitors)", async () => {
    const pixelSet = `fb.1.${T0 - 2 * DAY}.PRE`;
    const r = await run("https://openart.ai/home", { cookie: `_fbc=${pixelSet}` });
    expect(r.record?.clickIds.fbclid).toEqual({ v: "PRE", ts: T0 - 2 * DAY });
    expect(fbcOf(r.setCookies)).toBeUndefined();
  });

  it("never mints _fbc from a value Meta's own URL check would reject", async () => {
    const r = await run("https://openart.ai/?fbclid=ab%2Bcd");
    expect(fbcOf(r.setCookies)).toBeUndefined();
    expect(r.record?.fbc).toBeNull();
  });

  it("mints from a same-origin Referer when the landing itself was never processed (e.g. prerendered)", async () => {
    const r = await run("https://openart.ai/home", { referer: "https://openart.ai/?fbclid=FREF", now: T0 + MIN });
    expect(fbcOf(r.setCookies)).toBe(`fb.1.${T0 + MIN}.FREF`);
    expect(r.record?.lastTouch?.recovered).toBe(true);
  });

  it("the jar keeps working if the pixel rewrites _fbc with the same value (no fight over the cookie)", async () => {
    const { jar } = await journey([{ url: "https://openart.ai/?fbclid=F1", at: T0 }]);
    const pixelRewrite = applyToJar(jar, [`_fbc=fb.1.${T0}.F1; Path=/`]);
    const r = await run("https://openart.ai/home", { cookie: pixelRewrite, now: T0 + MIN });
    expect(fbcOf(r.setCookies)).toBeUndefined();
  });
});
