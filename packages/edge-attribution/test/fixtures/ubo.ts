/**
 * Query parameters removed by uBlock Origin's default-on "uBlock filters – Privacy" list through
 * generic `$removeparam=` rules, restricted to the ad/attribution parameters this package cares
 * about.
 *
 * Provenance: openart_2026-09-29/crawl/teardown2/blocklists/ubo_privacy.txt (uAssets commit
 * 49a27359d4cbfe1abe52b9e76f70b8dce6ae1772), lines 1480 gbraid, 1481 wbraid, 1482 gclsrc,
 * 1483 gclid, 1485 gad_source, 1487 gad_campaignid, 1489 _gl, 1491 dclid, 1497 fbclid,
 * 1519 msclkid, 1523 twclid, 1654 ttclid. Default-on status: ubo_assets_defaults.json
 * (`ublock-privacy`, commit 01092d95). Summarised in 01_live_teardown.md §T7(c).
 * test/node/provenance.test.ts re-derives this list from the file when it is available.
 */
export const UBO_REMOVED_PARAMS = [
  "gbraid",
  "wbraid",
  "gclsrc",
  "gclid",
  "gad_source",
  "gad_campaignid",
  "_gl",
  "dclid",
  "fbclid",
  "msclkid",
  "twclid",
  "ttclid",
] as const;

/** Parameters the same lists leave alone (01 §T7(c)): what a uBO user's landing still carries. */
export const UBO_SURVIVING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "li_fat_id",
  "rdt_cid",
  "oppref",
  "irclickid",
  "im_ref",
  "epik",
  "ScCid",
] as const;

/** Applies the removeparam rules to a URL, as uBO does before the navigation request is sent. */
export function uboStrip(url: string): string {
  const u = new URL(url);
  for (const p of UBO_REMOVED_PARAMS) u.searchParams.delete(p);
  return u.toString();
}
