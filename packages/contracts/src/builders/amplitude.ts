/**
 * Builder for Amplitude → BigQuery export rows (src/sources/amplitude-export-row.schema.json).
 * Property names follow what OpenArt's Suite sends (crawl/loggedin/generation/
 * 03_amplitude_events_after_click.json, research/02 §3.6, research/10 §0.5).
 */

import type { Prng } from '../cohort/prng.js';

export interface AmplitudeRow {
  uuid: string;
  event_id: number;
  event_type: string;
  event_time: string;
  client_event_time: string;
  server_upload_time: string;
  user_id: string | null;
  device_id: string;
  session_id: number;
  event_properties: Record<string, unknown>;
  user_properties: Record<string, unknown>;
  platform: string;
  os_name: string;
  device_type: string;
  country: string;
  library: string;
  language: string;
}

/** Suite SDK build observed in the logged-in crawl (research/01 T4). */
export const SUITE_AMPLITUDE_LIBRARY = 'amplitude-ts/2.34.0';

export function amplitudeRow(
  prng: Prng,
  r: {
    eventType: string;
    atMs: number;
    userId: string | null;
    deviceId: string;
    sessionId: number;
    eventId: number;
    eventProperties: Record<string, unknown>;
    userProperties: Record<string, unknown>;
    country?: string;
  },
): AmplitudeRow {
  const iso = new Date(r.atMs).toISOString();
  return {
    uuid: prng.uuidv4(),
    event_id: r.eventId,
    event_type: r.eventType,
    event_time: iso,
    client_event_time: iso,
    server_upload_time: new Date(r.atMs + 800).toISOString(),
    user_id: r.userId,
    device_id: r.deviceId,
    session_id: r.sessionId,
    event_properties: r.eventProperties,
    user_properties: r.userProperties,
    platform: 'Web',
    os_name: 'Chrome',
    device_type: 'Mac',
    country: r.country ?? 'United States',
    library: SUITE_AMPLITUDE_LIBRARY,
    language: 'English',
  };
}

/** asset_created properties exactly as the Suite sends them (openart-sdxl example observed). */
export function assetCreatedProperties(opts: {
  model: string;
  creationMode: 'image' | 'video';
  featureName: string;
  assetNum: number;
  creditsNum: number;
}): Record<string, unknown> {
  return {
    device: 'pc',
    creation_panel_version: 'v2',
    model: opts.model,
    creation_mode: opts.creationMode,
    create_source: 'suite',
    feature_name: opts.featureName,
    asset_num: opts.assetNum,
    credits_num: opts.creditsNum,
    reference_assets: { image: 0, character: 0, world: 0, audio: 0, video: 0, brand_kit: 0 },
  };
}
