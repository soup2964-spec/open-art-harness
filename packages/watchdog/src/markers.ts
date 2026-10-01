// Synthetic data used by every watchdog run. Every value carries the WD_TEST marker so the
// zero-leak scanner can find it in any URL, header or body, and every value is unique per run
// (runTag) so anything ever seen elsewhere is traceable to exactly one run.
import { createHash } from 'node:crypto';

export const MARKER = 'WD_TEST';
export const SYNTHETIC_EMAIL = 'wd.test@example.com'; // RFC 2606 reserved domain

export interface SyntheticClickIds {
  gclid: string;
  fbclid: string;
  ttclid: string;
  msclkid: string;
  rdt_cid: string;
  li_fat_id: string;
  twclid: string;
  oppref: string;
  gbraid: string;
  wbraid: string;
  fbclid2: string;
}

export interface SyntheticData {
  runTag: string;
  email: string;
  uid: string;
  invoices: { purchase: string; firstPurchase: string; business: string; purchaseFirst: string };
  clickIds: SyntheticClickIds;
  utm: { utm_source: string; utm_medium: string; utm_campaign: string };
}

export function makeRunTag(now = Date.now()): string {
  return now.toString(36).slice(-6).toUpperCase();
}

export function syntheticData(runTag: string): SyntheticData {
  const t = runTag.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const v = (name: string) => `${MARKER}_${name}_${t}`;
  return {
    runTag: t,
    email: SYNTHETIC_EMAIL,
    uid: v('UID'),
    invoices: { purchase: `in_${v('INV1')}`, firstPurchase: `in_${v('INV2')}`, business: `in_${v('INV3')}`, purchaseFirst: `in_${v('INV4')}` },
    clickIds: {
      gclid: v('GCLID'),
      fbclid: v('FBCLID'),
      ttclid: v('TTCLID'),
      msclkid: v('MSCLKID'),
      rdt_cid: v('RDTCID'),
      li_fat_id: v('LIFATID'),
      twclid: v('TWCLID'),
      oppref: v('OPPREF'),
      gbraid: v('GBRAID'),
      wbraid: v('WBRAID'),
      fbclid2: v('FBCLID2'),
    },
    utm: { utm_source: 'wd_watchdog', utm_medium: 'synthetic', utm_campaign: v('UTM') },
  };
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Every string whose appearance in a request proves synthetic data travelled with it. */
export function markerNeedles(d: SyntheticData): string[] {
  const at = d.email.indexOf('@');
  const dotless = d.email.slice(0, at).replace(/\./g, '') + d.email.slice(at);
  return [
    MARKER,
    d.email,
    encodeURIComponent(d.email),
    sha256hex(d.email),
    sha256hex(dotless),
    ...Object.values(d.invoices).map((i) => sha256hex(`sub_${i}`)),
  ];
}

export function containsMarker(haystack: string | null | undefined, needles: string[] = [MARKER]): boolean {
  if (!haystack) return false;
  let decoded = haystack;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, ' '));
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const hay = (haystack + '\n' + decoded).toLowerCase();
  return needles.some((n) => n && hay.includes(n.toLowerCase()));
}

export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
