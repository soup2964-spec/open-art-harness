/**
 * Idempotent Amplitude init for the legacy app (Next.js Pages Router).
 *
 * Replaces `il` (exported as `S1`) in module 16585 of pages/_app-a1820d4f2194dce7.js, which
 * calls amplitude `init()` on every call. Two effects call it and re-run during navigation:
 *  - module 78491 `useInitAmplitude` (deps include the my-info object and LaunchDarkly/AB-flag
 *    memos, which change identity on refetch),
 *  - module 41545 page layout (js_legacy/…1545-e1d094c1b14e9241.js, deps [status, id, deviceId],
 *    re-run on every layout mount).
 * Each extra init re-runs `_init`: timeline.reset() tears the plugins down, the page-view plugin
 * is set up again and its `setup()` immediately tracks "[Amplitude] Page Viewed" for the current
 * URL, and a fresh destination plugin re-sends the persisted `AMP_unsent_*` queue with the same
 * insert_ids. Full analysis: app-patches/legacy-amplitude-dedupe.md.
 *
 * The fix: init once; afterwards only update identity (setUserId / setDeviceId).
 */

export const LEGACY_AMPLITUDE_API_KEY = '3e2fda7a5cbcc867099904a028486db4';

/** Same defaultTracking the shipped wrapper passes. */
export const LEGACY_DEFAULT_TRACKING = {
  attribution: true,
  pageViews: true,
  sessions: false,
  formInteractions: false,
  fileDownloads: false,
} as const;

export interface AmplitudeLike {
  init: (apiKey: string, userIdOrOptions?: string | Record<string, unknown>, options?: Record<string, unknown>) => unknown;
  setUserId: (userId: string | undefined) => void;
  setDeviceId: (deviceId: string) => void;
  getDeviceId?: () => string | undefined;
}

export interface LegacyInitArgs {
  userId?: string;
  deviceId?: string;
}

export type LegacyInitOutcome = 'initialized' | 'identity_updated' | 'noop';

/** Same cookie fallback as the shipped wrapper: oa_device_id, then unique_device_id. */
export function readDeviceIdCookie(cookie: string): string | undefined {
  return cookie.match(/(?:^|;\s*)oa_device_id=([^;]+)/)?.[1] ?? cookie.match(/(?:^|;\s*)unique_device_id=([^;]+)/)?.[1];
}

export function createIdempotentAmplitudeInit(
  amplitude: AmplitudeLike,
  readCookieDeviceId: () => string | undefined,
  apiKey: string = LEGACY_AMPLITUDE_API_KEY,
): (args: LegacyInitArgs) => LegacyInitOutcome {
  let initialized = false;
  let currentUserId: string | undefined;
  let currentDeviceId: string | undefined;

  return function initAmplitudeOnce({ userId, deviceId }: LegacyInitArgs): LegacyInitOutcome {
    const resolvedDeviceId = deviceId || readCookieDeviceId();
    if (!initialized) {
      initialized = true;
      currentUserId = userId;
      currentDeviceId = resolvedDeviceId;
      const options = { ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}), defaultTracking: { ...LEGACY_DEFAULT_TRACKING } };
      // Same call shape as the shipped wrapper: t ? io(r, t, o) : io(r, o)
      if (userId) amplitude.init(apiKey, userId, options);
      else amplitude.init(apiKey, options);
      return 'initialized';
    }
    let changed = false;
    if (userId !== undefined && userId !== currentUserId) {
      amplitude.setUserId(userId);
      currentUserId = userId;
      changed = true;
    }
    if (resolvedDeviceId && resolvedDeviceId !== currentDeviceId) {
      amplitude.setDeviceId(resolvedDeviceId);
      currentDeviceId = resolvedDeviceId;
      changed = true;
    }
    return changed ? 'identity_updated' : 'noop';
  };
}
