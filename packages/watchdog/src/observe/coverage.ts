// CLICK-ID COVERAGE per platform across journeys: of the journeys whose ad URL carried the
// platform's click ID, in how many did the ID reach the platform's dedicated attribution field on a
// hit fired on the app page (where signup and purchase conversions later fire)?
// Journeys that simulate uBlock Origin are reported separately (the blocker cohort).
import type { JourneyObservation, Platform } from '../types.js';
import { AD_PLATFORMS } from '../types.js';
import { clickIdPresence, type PlatformClickIdResult } from './clickids.js';

export interface CoverageCell {
  covered: number;
  total: number;
  pct: number | null;
  stored: number;
  journeys: Array<{ id: string; covered: boolean; stored: boolean; urlOnly: boolean }>;
  /** Journeys that carried the click id but did not run as specified (step error / never reached the app): not in the denominator. */
  excluded: string[];
}

export interface PlatformCoverage {
  platform: Platform;
  standard: CoverageCell;
  blocker: CoverageCell;
  all: CoverageCell;
}

const valid = (j: JourneyObservation) => j.errors.length === 0 && j.appSteps.length > 0;

function cell(rows: Array<{ j: JourneyObservation; r: PlatformClickIdResult }>): CoverageCell {
  const excluded = rows.filter((x) => x.r.relevant && !valid(x.j)).map((x) => x.j.id);
  const relevant = rows.filter((x) => x.r.relevant && valid(x.j));
  const covered = relevant.filter((x) => x.r.sentOnFinalPage).length;
  return {
    covered,
    total: relevant.length,
    pct: relevant.length ? Math.round((1000 * covered) / relevant.length) / 10 : null,
    stored: relevant.filter((x) => x.r.stored.any).length,
    journeys: relevant.map((x) => ({ id: x.j.id, covered: x.r.sentOnFinalPage, stored: x.r.stored.any, urlOnly: x.r.urlOnlyOnFinal })),
    excluded,
  };
}

export function coverage(journeys: JourneyObservation[], platforms: Platform[] = AD_PLATFORMS): PlatformCoverage[] {
  const rows = journeys.flatMap((j) => clickIdPresence(j, platforms).map((r) => ({ j, r })));
  return platforms.map((platform) => {
    const mine = rows.filter((x) => x.r.platform === platform);
    return {
      platform,
      standard: cell(mine.filter((x) => !x.j.blocker)),
      blocker: cell(mine.filter((x) => !!x.j.blocker)),
      all: cell(mine),
    };
  });
}
