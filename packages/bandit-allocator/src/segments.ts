/**
 * Allocation segments = country bucket x device x acquisition channel.
 *
 * Every dimension is derived from fields OpenArt already collects (no app change):
 *   - country: the Amplitude export `country` column (a country name) or an ISO-2 code
 *     (Cloudflare / consent `region`), bucketed below;
 *   - device: the Amplitude export `platform` / `os_name` / `device_type` columns;
 *   - channel: the attribution plugin's `initial_*` user properties (click ids and UTMs,
 *     research/01 T4), the same fields the cohort generator writes.
 * The country buckets are ILLUSTRATIVE (a high-income "tier1" group); production should
 * bucket by observed ARPU per country from the warehouse.
 */

export const COUNTRY_BUCKETS = ['us', 'tier1', 'rest', 'unknown'] as const;
export type CountryBucket = (typeof COUNTRY_BUCKETS)[number];

export const DEVICES = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type Device = (typeof DEVICES)[number];

export const ACQUISITION_CHANNELS = [
  'google_cpc',
  'meta_paid_social',
  'tiktok_paid_social',
  'affiliate',
  'other_paid',
  'organic',
  'unknown',
] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

export interface Segment {
  country_bucket: CountryBucket;
  device: Device;
  acquisition_channel: AcquisitionChannel;
}

/** ILLUSTRATIVE high-income markets outside the US (ISO 3166-1 alpha-2). */
const TIER1_ISO2 = new Set([
  'CA', 'GB', 'IE', 'DE', 'FR', 'NL', 'BE', 'LU', 'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'IS',
  'IT', 'ES', 'AU', 'NZ', 'JP', 'KR', 'SG', 'IL', 'AE',
]);

/** Amplitude `country` names for the ISO codes above (plus the US). */
const COUNTRY_NAME_TO_ISO2: Readonly<Record<string, string>> = {
  'united states': 'US',
  canada: 'CA',
  'united kingdom': 'GB',
  ireland: 'IE',
  germany: 'DE',
  france: 'FR',
  netherlands: 'NL',
  'the netherlands': 'NL',
  belgium: 'BE',
  luxembourg: 'LU',
  austria: 'AT',
  switzerland: 'CH',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  iceland: 'IS',
  italy: 'IT',
  spain: 'ES',
  australia: 'AU',
  'new zealand': 'NZ',
  japan: 'JP',
  'south korea': 'KR',
  'republic of korea': 'KR',
  singapore: 'SG',
  israel: 'IL',
  'united arab emirates': 'AE',
};

export function countryBucket(country: string | null | undefined): CountryBucket {
  const raw = (country ?? '').trim();
  if (raw === '') return 'unknown';
  const iso = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : COUNTRY_NAME_TO_ISO2[raw.toLowerCase()];
  if (iso === 'US') return 'us';
  if (iso && TIER1_ISO2.has(iso)) return 'tier1';
  return 'rest';
}

export function deviceFromAmplitude(row: { platform?: string | null; os_name?: string | null; device_type?: string | null }): Device {
  const platform = (row.platform ?? '').toLowerCase();
  const os = (row.os_name ?? '').toLowerCase();
  const type = (row.device_type ?? '').toLowerCase();
  if (!platform && !os && !type) return 'unknown';
  if (/ipad|tablet|kindle|galaxy tab/.test(type)) return 'tablet';
  if (platform === 'ios' || platform === 'android') return 'mobile';
  if (/mobile|iphone|android|ios/.test(os) || /iphone|android|pixel|galaxy|mobile/.test(type)) return 'mobile';
  return 'desktop';
}

const str = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

/** Channel from Amplitude's initial_* attribution user properties (first touch). */
export function channelFromUserProperties(props: Record<string, unknown>): AcquisitionChannel {
  const source = str(props.initial_utm_source);
  const medium = str(props.initial_utm_medium);
  if (props.initial_gclid || props.initial_gbraid || props.initial_wbraid) return 'google_cpc';
  if (props.initial_fbclid) return 'meta_paid_social';
  if (props.initial_ttclid) return 'tiktok_paid_social';
  if (medium === 'affiliate' || source === 'tolt' || props.initial_ref || props.tolt_referral) return 'affiliate';
  if (/cpc|ppc|paid|display|cpm/.test(medium)) return 'other_paid';
  return 'organic';
}

export function segmentKey(s: Segment): string {
  return `${s.country_bucket}|${s.device}|${s.acquisition_channel}`;
}

export function parseSegmentKey(key: string): Segment {
  const [country_bucket, device, acquisition_channel, extra] = key.split('|');
  if (
    extra !== undefined ||
    !COUNTRY_BUCKETS.includes(country_bucket as CountryBucket) ||
    !DEVICES.includes(device as Device) ||
    !ACQUISITION_CHANNELS.includes(acquisition_channel as AcquisitionChannel)
  ) {
    throw new Error(`not a segment key: ${key}`);
  }
  return {
    country_bucket: country_bucket as CountryBucket,
    device: device as Device,
    acquisition_channel: acquisition_channel as AcquisitionChannel,
  };
}

/** A predicate over segments (used by LaunchDarkly rule targets). Empty/missing = any. */
export interface SegmentMatch {
  country_bucket?: readonly CountryBucket[];
  device?: readonly Device[];
  acquisition_channel?: readonly AcquisitionChannel[];
}

export function segmentMatches(s: Segment, m: SegmentMatch): boolean {
  const ok = <T>(value: T, allowed: readonly T[] | undefined) => !allowed || allowed.length === 0 || allowed.includes(value);
  return ok(s.country_bucket, m.country_bucket) && ok(s.device, m.device) && ok(s.acquisition_channel, m.acquisition_channel);
}
