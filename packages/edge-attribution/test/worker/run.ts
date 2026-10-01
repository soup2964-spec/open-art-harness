// Worker-side test harness around captureAttribution.
import { env } from "cloudflare:workers";
import { captureAttribution } from "../../src/capture.js";
import type { CaptureOptions, CaptureResult } from "../../src/capture.js";
import { T0, applyToJar, navHeaders } from "../fixtures/helpers.js";

export interface RunInit {
  headers?: Record<string, string>;
  cookie?: string;
  referer?: string;
  country?: string | null;
  cf?: Record<string, unknown>;
  now?: number;
  ua?: string;
  method?: string;
  options?: CaptureOptions;
  env?: Record<string, unknown>;
}

export function fakeCtx(): ExecutionContext & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext & { promises: Promise<unknown>[] };
}

export function makeRequest(url: string, init: RunInit = {}): Request {
  const headers: Record<string, string> = { ...navHeaders({}, init.ua), ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.referer) headers.referer = init.referer;
  const cf = init.cf ?? (init.country === null ? undefined : { country: init.country ?? "US" });
  const requestInit: RequestInit = { method: init.method ?? "GET", headers, ...(cf ? { cf: cf as never } : {}) };
  return new Request(url, requestInit);
}

export async function run(url: string, init: RunInit = {}): Promise<CaptureResult> {
  const now = init.now ?? T0;
  return captureAttribution(makeRequest(url, init), (init.env ?? env) as never, fakeCtx(), {
    now: () => now,
    persistence: false,
    ...(init.options ?? {}),
  });
}

/** Runs a sequence of navigations through one cookie jar (a multi-hop journey). */
export async function journey(
  steps: Array<{ url: string; at: number } & Omit<RunInit, "now" | "cookie">>,
  startJar = "",
): Promise<{ jar: string; results: CaptureResult[] }> {
  let jar = startJar;
  const results: CaptureResult[] = [];
  for (const s of steps) {
    const r = await run(s.url, { ...s, now: s.at, cookie: jar });
    results.push(r);
    jar = applyToJar(jar, r.setCookies);
  }
  return { jar, results };
}
