import { describe, expect, it } from 'vitest';
import { readFixture } from '../../test-utils/fixtures';
import {
  LEGACY_AMPLITUDE_API_KEY,
  createIdempotentAmplitudeInit,
  readDeviceIdCookie,
  type AmplitudeLike,
} from '../src/legacy-amplitude-init';

/** Shipped wrapper `il` (S1) from module 16585, with a recording `io` (= amplitude init). */
function loadShippedInit(cookie: string) {
  const calls: unknown[][] = [];
  const il = new Function('io', 'document', readFixture(import.meta.url, './fixtures/legacy-module-16585-init.js'))(
    (...args: unknown[]) => calls.push(args),
    { cookie },
  ) as (args: { userId?: string; deviceId?: string }) => void;
  return { il, calls };
}

function recordingAmplitude() {
  const calls: Array<[string, ...unknown[]]> = [];
  const amp: AmplitudeLike = {
    init: (...a) => calls.push(['init', ...a]),
    setUserId: (id) => calls.push(['setUserId', id]),
    setDeviceId: (id) => calls.push(['setDeviceId', id]),
  };
  return { amp, calls };
}

const COOKIE = 'country_code=US; oa_device_id=0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0; other=1';

describe('shipped wrapper (evidence)', () => {
  it('calls amplitude init on every call — one init per effect re-run', () => {
    const { il, calls } = loadShippedInit(COOKIE);
    il({ deviceId: undefined }); // layout effect, logged-out render
    il({ userId: 'u1', deviceId: 'dev-1' }); // useInitAmplitude after my-info resolves
    il({ userId: 'u1', deviceId: 'dev-1' }); // same values, new object identities in deps
    expect(calls).toHaveLength(3);
  });
});

describe('createIdempotentAmplitudeInit', () => {
  it('first call is argument-for-argument the shipped init', () => {
    for (const args of [{ userId: 'u1', deviceId: 'dev-1' }, { deviceId: undefined }]) {
      const shipped = loadShippedInit(COOKIE);
      shipped.il(args);
      const { amp, calls } = recordingAmplitude();
      createIdempotentAmplitudeInit(amp, () => readDeviceIdCookie(COOKIE))(args);
      expect(calls).toEqual([['init', ...shipped.calls[0]!]]);
    }
  });

  it('never re-inits; later calls only update identity', () => {
    const { amp, calls } = recordingAmplitude();
    const init = createIdempotentAmplitudeInit(amp, () => readDeviceIdCookie(COOKIE));
    expect(init({})).toBe('initialized');
    expect(init({})).toBe('noop');
    expect(init({ userId: 'u1', deviceId: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0' })).toBe('identity_updated');
    expect(init({ userId: 'u1', deviceId: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0' })).toBe('noop');
    expect(init({ userId: 'u1', deviceId: 'dev-2' })).toBe('identity_updated');
    expect(calls.map((c) => c[0])).toEqual(['init', 'setUserId', 'setDeviceId']);
    expect(calls[0]![1]).toBe(LEGACY_AMPLITUDE_API_KEY);
  });

  it('reads the device id cookie like the shipped wrapper', () => {
    expect(readDeviceIdCookie('unique_device_id=abc')).toBe('abc');
    expect(readDeviceIdCookie('oa_device_id=x; unique_device_id=abc')).toBe('x');
    expect(readDeviceIdCookie('')).toBeUndefined();
  });
});

describe('model of the observed page-view counts (P08_spa_legacy.json)', () => {
  /**
   * A deliberately small model of Amplitude Browser SDK 2.11.7 as shipped in module 16585:
   *  - init(): timeline.reset() tears plugins down; the page-view plugin's setup() tracks one
   *    page view for the current URL; a new destination re-sends the persisted unsent queue.
   *  - pushState: the single active page-view plugin tracks one page view.
   *  - the destination removes events from the persisted queue only after a later flush.
   */
  function simulate(initCallsDuringNavigation: number, idempotent: boolean) {
    const unique = new Set<string>();
    const payloads: string[] = [];
    let unsent: string[] = [];
    let seq = 0;
    const track = () => {
      const id = `pv-${++seq}`;
      unique.add(id);
      unsent.push(id);
      payloads.push(...unsent); // every flush carries the whole persisted queue
    };
    const rawInit = () => track();
    const amp: AmplitudeLike = { init: rawInit, setUserId: () => undefined, setDeviceId: () => undefined };
    const init = idempotent ? createIdempotentAmplitudeInit(amp, () => 'dev-1') : () => rawInit();
    init({ userId: 'u1' }); // hard load
    unsent = [];
    payloads.length = 0;
    unique.clear();
    track(); // pushState -> page-view plugin
    for (let i = 0; i < initCallsDuringNavigation; i += 1) init({ userId: 'u1' });
    return { unique: unique.size, payloads: payloads.length };
  }

  it('two re-inits per navigation reproduce "3 unique / 6 payloads" (soft1_video, soft5_image)', () => {
    expect(simulate(2, false)).toEqual({ unique: 3, payloads: 6 });
  });

  it('one re-init reproduces "2 unique / 3 payloads" (soft4_story)', () => {
    expect(simulate(1, false)).toEqual({ unique: 2, payloads: 3 });
  });

  it('with the idempotent init every navigation is 1 page view in 1 payload', () => {
    expect(simulate(2, true)).toEqual({ unique: 1, payloads: 1 });
  });
});
