# Legacy app: why one navigation produces up to 6 Amplitude page views, and the patch

**Scope.** The legacy front-end (Next.js Pages Router: `/image`, `/video`, `/story` …) running Amplitude Browser SDK **2.11.7** (wire `library: "amplitude-ts/2.11.7"`) [O].

**Patch.** `src/legacy-amplitude-init.ts`. Placement is in `PATCHES.md` §7.

## Evidence [O]

Source: `crawl/loggedin/pages/P08_spa_legacy.json`, a logged-in session with soft navigations between legacy routes. The table shows every `[Amplitude] Page Viewed` event in the `api2.amplitude.com/2/httpapi` request bodies (insert ids truncated to 8 characters):

| Soft navigation | Page Viewed payloads | Distinct `insert_id`s (copies) | Page views Amplitude keeps |
|---|---|---|---|
| `/image` → `/video` (soft1_video) | **6** | `30aab6c9` ×3, `4c4fb0ed` ×2, `9126667b` ×1 | **3** |
| `/video` → `/story` (soft4_story) | **3** | `b435fbaf` ×2, `2536a8dd` ×1 | **2** |
| `/story` → `/image` (soft5_image) | **6** | `09b6e2c5` ×3, `9c9398fb` ×2, `194d3982` ×1 | **3** |

In the same bursts, `$identify` and `experiment_flags_ready` are sent again with new insert ids.

**What Amplitude keeps.** The HTTP V2 API docs say *"Amplitude deduplicates subsequent events sent with the same `device_id` and `insert_id` within the past 7 days"*. So Amplitude drops the repeated copies, but it keeps every distinct insert id. The result is **2–3 page views per navigation instead of 1**. That inflates page-view counts, funnels that start from page views, and session depth on legacy routes.

## Cause [C]

1. **Legacy module 16585** (`pages/_app-a1820d4f2194dce7.js`) exports `S1`, the wrapper `il`.
   - It calls Amplitude `init()` **on every call**: `t ? io(r, t, o) : io(r, o)`.
   - Its options are `deviceId` from `oa_device_id` and `defaultTracking: {attribution:true, pageViews:true, …}`.
   - Extract: `test/fixtures/legacy-module-16585-init.js`.
2. Two effects call it and re-run while the user navigates (`test/fixtures/legacy-amplitude-init-callsites.txt`):
   - **module 78491** `useInitAmplitude`. Its dependency list includes the my-info data and the LaunchDarkly/AB-flag memos, which get new identities when they refetch.
   - **module 41545**, the page layout (`1545-e1d094c1b14e9241.js`), with deps `[status, id, deviceId]`. It re-runs on every layout mount.
3. Each extra `init()` runs the SDK's `_init`, which calls `this.timeline.reset(this)` (bundle offset 2448289):
   - The plugins are torn down and set up again.
   - The page-view plugin's setup tracks `[Amplitude] Page Viewed` for the current URL. That is a new event with a new insert id.
   - The new destination plugin re-sends the persisted `AMP_unsent_*` queue. Those are copies with the same insert ids.

**How the counts fit.**

- Two extra inits during one navigation give 1 (history) + 2 (re-inits) = 3 distinct page views. The re-sent queue brings the payload count to 6.
- One extra init gives 2 distinct and 3 payloads.

The model in `test/legacy-amplitude-init.test.ts` reproduces both rows: 3 unique / 6 payloads, and 2 unique / 3 payloads.

## Patch

Replace the wrapper with an idempotent one:

```ts
import { createIdempotentAmplitudeInit, readDeviceIdCookie } from '@openart-signal/web-fixes/app-patches/legacy-amplitude-init';
export const S1 = createIdempotentAmplitudeInit(amplitude, () => readDeviceIdCookie(document.cookie));
```

- **First call.** Exactly the shipped `init`: same API key `3e2fda7a5c…`, same `deviceId` fallback (`oa_device_id`, then `unique_device_id`), same `defaultTracking`. The test compares the calls argument by argument.
- **Later calls.** No re-init. It calls `setUserId(uid)` when the user id changes (login) and `setDeviceId(id)` when the device id changes, and does nothing otherwise.
- **Result.** One `[Amplitude] Page Viewed` per navigation, in one payload. The model's idempotent case gives 1 / 1.

**Not changed.** Logout handling. [I] If the app clears identity on logout, it does so outside `S1` today, and it still does.

**The Suite is not affected [O].** `P07_spa_suite.json` has exactly one `[Amplitude] Page Viewed` per navigation: 8 page views for 8 routes. Astro pages are full page loads.

**Verify after deploy.** Repeat the P08 navigation. `api2.amplitude.com/2/httpapi` bodies should contain exactly one `[Amplitude] Page Viewed` per route and no repeated insert ids.
