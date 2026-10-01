// SealedSession: one fresh, isolated Chrome under the collection seal, used for every journey,
// consent probe and the pilot. Patterns are ported, with attribution, from:
//   - src/legacy/sealed_replay.cjs (instrument(): per-target CDP setup; auto-attach with
//     waitForDebuggerOnStart so a new target is intercepted BEFORE it runs; SIGKILL teardown), and
//   - openart_2026-09-29/crawl/teardown2/harness.cjs (SHA-256 3c09251160b7f7e0…): snapshot(),
//     clickCTA() with human-like pacing, quiet(); and loggedin/_scripts/crawl.mjs dismissWhatsNew().
// Safety properties:
//   * own Chrome, pipe transport (no debugging port; port 9333 is never touched), fresh
//     --user-data-dir under packages/watchdog/.profiles/, deleted after the run;
//   * the browser's only network path is the gatekeeper proxy, which tunnels to first-party
//     openart.ai hosts only; every allowed third-party GET is fetched by the watchdog itself and
//     fulfilled (src/browser/nodefetch.ts); QUIC off, WebRTC restricted to proxied UDP;
//   * Fetch interception on the browser target AND every attached target from the first request;
//     a page/frame whose Fetch cannot be enabled is never resumed;
//   * channels Fetch cannot see are closed: speculation-rules prefetch/prerender (profile
//     preference "no preloading"), Reporting API / NEL (disabled features), WebSocket, service
//     workers, shared workers and popups (SEAL_INIT in every frame/worker; worker targets that
//     appear anyway are held paused and never run);
//   * teardown seals the proxy first, then SIGKILLs the whole process tree (no unload beacons).
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type CDPSession, type Page, type Protocol } from 'puppeteer-core';
import { startProxy, type GatekeeperProxy, type ProxySummary } from '../legacy/gatekeeper_proxy.cjs';
import { DESKTOP_META, DESKTOP_UA, killChromeTree, sealedLaunchArgs } from '../legacy/sealed_replay.cjs';
import type { CookieLite, StepSnapshot } from '../types.js';
import type { SessionEvidence } from '../observe/leakproof.js';
import { fetchPatterns, makePausedHandler, newInterceptState, type InterceptOptions, type InterceptState } from './intercept.js';
import { DISMISS_OVERLAYS, DOM_CLICK_CTA, FIND_CTA, SEAL_INIT, SEAL_LOG } from './pagejs.js';

export type Device = 'desktop' | 'iphone' | 'instagram';

export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
// Verbatim from crawl/teardown2/run.cjs (T11 in-app browser runs)
export const INSTAGRAM_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.28.85 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 745863112)';

export interface NetRecord {
  sess: string;
  requestId: string;
  url: string;
  method: string;
  type: string;
  t: number;
  step: string;
  responseReceived?: boolean;
  status?: number;
  failed?: string;
  blockedReason?: string | null;
  corsError?: string;
  canceled?: boolean;
  servedFromCache?: boolean;
  fromServiceWorker?: boolean;
  /** initiator.type ('preflight' for CORS preflights) and the request that triggered it. */
  initiatorType?: string;
  initiatorRequestId?: string;
}

export interface NavEvent {
  t: number;
  step: string;
  kind: 'hard' | 'soft';
  url: string;
}

export interface SessionOptions {
  name: string;
  profilesDir: string;
  chromePath: string;
  device: Device;
  intercept: InterceptOptions;
  captureLoaders: boolean;
  allowConnect: (host: string, port: number) => boolean;
  screenshotsDir?: string;
  log?: (m: string) => void;
}

export interface SessionTeardown {
  proxySealedBeforeKill: boolean;
  processTree?: number[];
  stillAlive?: number[];
  allDeadAfterMs?: number;
  profileDeleted: boolean;
  profile: string;
  pgrepProfile?: string[];
}

/**
 * Cut Chrome's own background traffic (component updater, network time, domain reliability,
 * hyperlink pings) and disable the Reporting API + Network Error Logging, whose uploads are made by
 * the network service outside the Fetch domain (verified on a loopback server: with these features
 * on, CSP reports are queued for upload; with them off, none is created).
 */
export const QUIET_CHROME_FLAGS = ['--no-pings', '--disable-component-update', '--disable-domain-reliability', '--no-service-autorun', '--disable-features=NetworkTimeServiceQuerying,OptimizationGuideModelDownloading,AutofillServerCommunication,CertificateTransparencyComponentUpdater,Reporting,NetworkErrorLogging'];

/** puppeteer defaults the seal must not inherit (automation banner; popup blocking OFF). */
export const IGNORED_DEFAULT_ARGS = ['--enable-automation', '--disable-popup-blocking'];

/**
 * Preferences written into the fresh profile before Chrome starts. "Preload pages: no preloading"
 * (net.network_prediction_options = 2) is what stops speculation-rules prefetch and prerender:
 * those requests are issued by the browser process and reach the server WITHOUT any
 * Fetch.requestPaused event (verified on a loopback server; Page.setPrerenderingAllowed(false) and
 * --disable-features=Prerender2,SpeculationRules did not stop them, this preference did).
 */
export const SEALED_PROFILE_PREFS = {
  net: { network_prediction_options: 2 },
  safebrowsing: { enabled: false },
  search: { suggest_enabled: false },
  profile: { default_content_setting_values: { popups: 2, notifications: 2 } },
};

export function writeSealedProfilePrefs(profileDir: string): void {
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify(SEALED_PROFILE_PREFS));
}

/** The only extra Chrome flags accepted from WATCHDOG_CHROME_ARGS (container sandboxing / GPU). */
export const ENV_FLAG_ALLOWLIST = /^--(no-sandbox|disable-setuid-sandbox|disable-gpu|disable-dev-shm-usage|disable-software-rasterizer|enable-unsafe-swiftshader|use-gl=[a-z0-9_-]+|use-angle=[a-z0-9_-]+|font-render-hinting=[a-z]+)$/;

/**
 * Extra Chrome flags from the environment (e.g. WATCHDOG_CHROME_ARGS="--no-sandbox" inside a Cloud
 * Run container). Allowlist only: a flag such as --no-proxy-server, --proxy-pac-url,
 * --host-resolver-rules or --disable-web-security would silently remove a seal layer, so anything
 * else aborts the run.
 */
export function envChromeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args = (env.WATCHDOG_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  const bad = args.filter((a) => !ENV_FLAG_ALLOWLIST.test(a));
  if (bad.length) throw new Error(`WATCHDOG_CHROME_ARGS may only contain sandbox/GPU flags (${ENV_FLAG_ALLOWLIST.source}); refusing: ${bad.join(' ')}`);
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = (a: number, b: number) => sleep(a + Math.floor(Math.random() * (b - a)));

export class SealedSession {
  readonly state: InterceptState = newInterceptState();
  readonly net: NetRecord[] = [];
  readonly navLog: NavEvent[] = [];
  readonly snapshots: StepSnapshot[] = [];
  readonly consoleErrors: string[] = [];
  /** WebSocket handshakes Chrome reported (expected: none — SEAL_INIT stops them before creation). */
  readonly webSockets: Array<{ sess: string; url: string; t: number; step: string }> = [];
  readonly sessionsInfo: Array<{ label: string; type: string; fetch: string }> = [];
  /** Service/shared worker targets: held paused (never instrumented, never resumed by the watchdog). */
  readonly heldTargets: Array<{ type: string; url: string; step: string; via: string }> = [];
  /** Page targets other than the journey's own page (popups/new tabs): closed on sight. */
  readonly extraPages: Array<{ url: string; step: string; closed: boolean }> = [];
  /** ServiceWorker domain: every registration/version Chrome reported (expected: none). */
  readonly serviceWorkerVersions: Array<{ scriptURL: string; runningStatus: string; status: string; step: string }> = [];
  /** Reporting API reports Chrome queued (expected: none — the feature is disabled). */
  readonly reportingReports: Array<{ type: string; destination: string; status: string; url: string }> = [];
  /** Attempts the in-page seal blocked (WebSocket, service worker, window.open, ...), per snapshot. */
  readonly sealLog: Array<{ step: string; entry: string }> = [];
  /** Targets whose Fetch interception could not be enabled (never resumed; fails the proof). */
  readonly fetchFailures: string[] = [];
  /** Main-frame navigations actually allowed to load (redirect stubs and failed navigations excluded). */
  get pageLoads(): number {
    // Allowed requests are paused twice (target layer, then browser layer): count distinct network ids.
    return new Set(this.state.requests.filter((r) => r.resourceType === 'Document' && r.action === 'allow' && !!r.frameId && this.state.mainFrameIds.has(r.frameId)).map((r) => r.networkId ?? r.id)).size;
  }
  browser!: Browser;
  page!: Page;
  pageSession!: CDPSession;
  browserSession!: CDPSession;
  proxy!: GatekeeperProxy;
  proxySummary: ProxySummary | null = null;
  teardown: SessionTeardown | null = null;
  profile: string;
  private closed = false;
  private netById = new Map<string, NetRecord>();
  private handler: ReturnType<typeof makePausedHandler>;

  private constructor(readonly opts: SessionOptions) {
    this.profile = path.join(opts.profilesDir, `${opts.name}-${Date.now().toString(36)}`);
    this.handler = makePausedHandler(this.state, opts.intercept);
  }

  static async launch(opts: SessionOptions): Promise<SealedSession> {
    const s = new SealedSession(opts);
    await s.start();
    return s;
  }

  set step(label: string) {
    this.state.step = label;
  }
  get step(): string {
    return this.state.step;
  }

  private log(m: string) {
    this.opts.log?.(`[${this.opts.name}] ${m}`);
  }

  private async start() {
    fs.mkdirSync(this.opts.profilesDir, { recursive: true });
    fs.rmSync(this.profile, { recursive: true, force: true });
    writeSealedProfilePrefs(this.profile);
    const mobile = this.opts.device !== 'desktop';
    const extra = [...QUIET_CHROME_FLAGS, ...envChromeArgs(), mobile ? '--window-size=390,844' : '--window-size=1440,900'];
    this.proxy = await startProxy({ allowConnect: this.opts.allowConnect });
    try {
      this.browser = await puppeteer.launch({
        executablePath: this.opts.chromePath,
        headless: true,
        pipe: true, // no remote-debugging port at all
        userDataDir: this.profile,
        ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
        args: sealedLaunchArgs(this.proxy.port).filter((a) => !a.startsWith('--window-size=')).concat(extra),
        defaultViewport: null,
        protocolTimeout: 120_000,
      });
    } catch (e) {
      // never leave a listening proxy or a profile behind when Chrome cannot start
      this.proxy.seal();
      await this.proxy.close().catch(() => {});
      fs.rmSync(this.profile, { recursive: true, force: true });
      throw e;
    }
    this.browserSession = await this.browser.target().createCDPSession();
    // Browser-level interception: requests not owned by an attached target (popups, worker script
    // fetches) are decided by the same policy. Without it the seal is incomplete: abort.
    this.browserSession.on('Fetch.requestPaused', (e: Protocol.Fetch.RequestPausedEvent) => void this.handler(this.browserSession, e, 'fetch-browser', 'browser'));
    try {
      await this.browserSession.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      this.sessionsInfo.push({ label: 'browser', type: 'browser', fetch: 'enabled' });
    } catch (e) {
      await this.close();
      throw new Error('browser-level Fetch interception unavailable — refusing to run: ' + (e as Error).message);
    }
    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    const mainTarget = this.page.target();
    this.browser.on('targetcreated', async (t) => {
      const ty = t.type();
      if (ty === 'service_worker' || ty === 'shared_worker') {
        // Held, not instrumented: SEAL_INIT refuses registrations; a worker that appears anyway stays
        // paused by the page session's waitForDebuggerOnStart and is recorded for the proof.
        this.heldTargets.push({ type: ty, url: t.url(), step: this.step, via: 'browser' });
        return;
      }
      if (ty === 'page' && t !== mainTarget) {
        const rec = { url: t.url(), step: this.step, closed: false };
        this.extraPages.push(rec);
        try {
          await this.browserSession.send('Target.closeTarget', { targetId: (t as unknown as { _targetId: string })._targetId });
          rec.closed = true;
        } catch {
          /* recorded as not closed; the proof fails either way */
        }
      }
    });
    this.pageSession = await this.page.createCDPSession();
    await this.instrument(this.pageSession, 'page', 'page');
    if (this.fetchFailures.length) {
      await this.close();
      throw new Error('page Fetch interception unavailable — refusing to run: ' + this.fetchFailures.join('; '));
    }
    // Channels outside Fetch, observed so the proof can assert they stayed silent.
    this.pageSession.on('ServiceWorker.workerVersionUpdated', (e: Protocol.ServiceWorker.WorkerVersionUpdatedEvent) => {
      for (const v of e.versions) this.serviceWorkerVersions.push({ scriptURL: v.scriptURL, runningStatus: v.runningStatus, status: v.status, step: this.step });
    });
    this.pageSession.on('Network.reportingApiReportAdded', (e: Protocol.Network.ReportingApiReportAddedEvent) => {
      this.reportingReports.push({ type: e.report.type, destination: e.report.destination, status: e.report.status, url: e.report.initiatorUrl });
    });
    for (const [m, p] of [
      ['ServiceWorker.enable', {}],
      ['Network.enableReportingApi', { enable: true }],
      ['Page.setPrerenderingAllowed', { isAllowed: false }],
    ] as const) {
      await this.pageSession.send(m as any, p as any).catch((e: Error) => this.state.errors.push(`${m}: ${e.message}`));
    }
    const tree = await this.pageSession.send('Page.getFrameTree');
    this.state.mainFrameIds.add(tree.frameTree.frame.id);
    this.pageSession.on('Page.frameNavigated', (e: Protocol.Page.FrameNavigatedEvent) => {
      if (!e.frame.parentId) {
        this.state.mainFrameIds.add(e.frame.id);
        this.navLog.push({ t: Date.now() - this.state.t0, step: this.step, kind: 'hard', url: e.frame.url });
      }
    });
    this.pageSession.on('Page.navigatedWithinDocument', (e: Protocol.Page.NavigatedWithinDocumentEvent) => {
      if (this.state.mainFrameIds.has(e.frameId)) this.navLog.push({ t: Date.now() - this.state.t0, step: this.step, kind: 'soft', url: e.url });
    });
    await this.pageSession.send('Page.enable');
    await this.applyDevice(this.pageSession, true);
    this.page.on('dialog', (d) => void d.dismiss().catch(() => {}));
  }

  private async applyDevice(s: CDPSession, isPage: boolean) {
    const d = this.opts.device;
    try {
      if (d === 'desktop') {
        await s.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA, acceptLanguage: 'en-US,en', platform: 'MacIntel', userAgentMetadata: DESKTOP_META as Protocol.Emulation.UserAgentMetadata });
        if (isPage) await s.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
      } else {
        await s.send('Emulation.setUserAgentOverride', { userAgent: d === 'instagram' ? INSTAGRAM_UA : IPHONE_UA, acceptLanguage: 'en-US,en', platform: 'iPhone' });
        if (isPage) {
          await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenWidth: 390, screenHeight: 844 });
          await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        }
      }
    } catch {
      /* some targets lack Emulation */
    }
  }

  /**
   * Port of legacy instrument(): Fetch FIRST, then recording, then recursive auto-attach. Returns
   * false when the target must not be resumed (a page/frame whose Fetch interception failed).
   */
  private async instrument(s: CDPSession, label: string, kind: string): Promise<boolean> {
    s.on('Fetch.requestPaused', (e: Protocol.Fetch.RequestPausedEvent) => void this.handler(s, e, 'fetch-target', label));
    let fetchState = 'enabled';
    let resumable = true;
    try {
      await s.send('Fetch.enable', { patterns: fetchPatterns({ patches: this.opts.intercept.patches, captureLoaders: this.opts.captureLoaders }) });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 80);
      if (kind === 'worker' && /wasn't found/.test(msg)) {
        fetchState = 'parent (dedicated worker: its requests are paused by the parent target)';
      } else {
        fetchState = 'FAILED: ' + msg;
        this.fetchFailures.push(`${label}: ${msg}`);
        resumable = false;
      }
    }
    this.sessionsInfo.push({ label, type: kind, fetch: fetchState });
    s.on('Network.requestWillBeSent', (e: Protocol.Network.RequestWillBeSentEvent) => {
      const r: NetRecord = { sess: label, requestId: e.requestId, url: e.request.url, method: e.request.method, type: e.type ?? 'Other', t: Date.now() - this.state.t0, step: this.step, initiatorType: e.initiator?.type, initiatorRequestId: (e.initiator as { requestId?: string } | undefined)?.requestId };
      this.net.push(r);
      this.netById.set(label + ':' + e.requestId, r);
    });
    s.on('Network.responseReceived', (e: Protocol.Network.ResponseReceivedEvent) => {
      const r = this.netById.get(label + ':' + e.requestId);
      if (!r) return;
      r.responseReceived = true;
      r.status = e.response.status;
      r.fromServiceWorker = !!e.response.fromServiceWorker;
    });
    s.on('Network.requestServedFromCache', (e: Protocol.Network.RequestServedFromCacheEvent) => {
      const r = this.netById.get(label + ':' + e.requestId);
      if (r) r.servedFromCache = true;
    });
    s.on('Network.loadingFailed', (e: Protocol.Network.LoadingFailedEvent) => {
      const r = this.netById.get(label + ':' + e.requestId);
      if (!r) return;
      r.failed = e.errorText;
      r.blockedReason = e.blockedReason ?? null;
      r.corsError = e.corsErrorStatus?.corsError;
      r.canceled = !!e.canceled;
    });
    s.on('Network.webSocketCreated', (e: Protocol.Network.WebSocketCreatedEvent) => {
      this.webSockets.push({ sess: label, url: e.url, t: Date.now() - this.state.t0, step: this.step });
    });
    s.on('Runtime.exceptionThrown', (e: Protocol.Runtime.ExceptionThrownEvent) => {
      if (this.consoleErrors.length < 200) this.consoleErrors.push(`${this.step}: ${(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).slice(0, 300)}`);
    });
    s.on('Target.attachedToTarget', async (e: Protocol.Target.AttachedToTargetEvent) => {
      const ty = e.targetInfo.type;
      if (ty === 'service_worker' || ty === 'shared_worker') {
        // Held paused: never instrumented and never resumed, so it fetches and sends nothing.
        this.heldTargets.push({ type: ty, url: e.targetInfo.url, step: this.step, via: label });
        return;
      }
      let child: CDPSession | undefined;
      let resume = false;
      try {
        child = s.connection()?.session(e.sessionId) ?? undefined;
        if (child) {
          resume = await this.instrument(child, `${ty}:${(e.targetInfo.url || '').slice(0, 80)}`, ty);
          if (ty === 'iframe') await this.applyDevice(child, false);
        }
      } catch (err) {
        resume = false;
        if (!this.closed) this.state.errors.push('attach ' + (err as Error).message);
      } finally {
        if (child && e.waitingForDebugger && resume) await child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
      }
    });
    for (const [m, p] of [
      ['Network.enable', { maxPostDataSize: 16 * 1024 * 1024 }],
      ['Runtime.enable', {}],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ] as const) {
      try {
        await s.send(m as any, p as any);
      } catch {
        /* some targets lack a domain */
      }
    }
    // Channels Fetch cannot see (WebSocket, service/shared workers, popups): SEAL_INIT runs before any
    // script of this target.
    try {
      // Page.enable first: without it addScriptToEvaluateOnNewDocument is accepted but not applied to
      // later documents of the target (verified on the replay harness)
      if (kind === 'page' || kind === 'iframe') {
        await s.send('Page.enable');
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: SEAL_INIT, runImmediately: true });
      }
      await s.send('Runtime.evaluate', { expression: SEAL_INIT });
    } catch {
      /* targets without Page/Runtime */
    }
    if (kind === 'page' || kind === 'iframe') {
      // Page requests never route through a service worker, so every one reaches this target's Fetch.
      try {
        await s.send('Network.setBypassServiceWorker', { bypass: true });
      } catch {
        /* ignore */
      }
    }
    if (kind !== 'page' && kind !== 'iframe') {
      try {
        await s.send('Network.setUserAgentOverride', { userAgent: this.opts.device === 'desktop' ? DESKTOP_UA : this.opts.device === 'instagram' ? INSTAGRAM_UA : IPHONE_UA });
      } catch {
        /* ignore */
      }
    }
    return resumable;
  }

  // ------------------------------------------------------------------ actions
  async goto(url: string, step: string, opts: { referer?: string } = {}): Promise<{ ok: boolean; err?: string; finalUrl: string; ms: number }> {
    this.step = step;
    const t = Date.now();
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout: 60_000, referer: opts.referer });
      return { ok: true, finalUrl: this.page.url(), ms: Date.now() - t };
    } catch (e) {
      return { ok: false, err: (e as Error).message, finalUrl: this.page.url(), ms: Date.now() - t };
    }
  }

  /** Wait until the request log has been idle for idleMs (min..max). Ported from teardown2 quiet(). */
  async quiet(minMs = 4000, maxMs = 20000, idleMs = 2500) {
    const start = Date.now();
    await sleep(minMs);
    let last = this.state.requests.length;
    let lastChange = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(500);
      if (this.state.requests.length !== last) {
        last = this.state.requests.length;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange > idleMs) break;
    }
  }

  async evaluate<T>(fn: string): Promise<T | null> {
    try {
      const r = await this.pageSession.send('Runtime.evaluate', { expression: fn, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return null;
      return (r.result?.value ?? null) as T;
    } catch {
      return null;
    }
  }

  async cookies(): Promise<CookieLite[]> {
    try {
      const r = await this.browserSession.send('Storage.getCookies');
      return r.cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, expires: c.expires, partitionKey: (c as any).partitionKey }));
    } catch {
      return [];
    }
  }

  async cookieHeaderFor(url: string): Promise<string> {
    try {
      const r = await this.pageSession.send('Network.getCookies', { urls: [url] });
      return r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return '';
    }
  }

  async snapshot(step: string, extra: Record<string, unknown> = {}): Promise<StepSnapshot> {
    const state = await this.evaluate<any>(`(function(){
      var ls = {}; try { for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); ls[k]=(localStorage.getItem(k)||'').slice(0,4000); } } catch(e){}
      var dl = []; var consent = [];
      try { (window.dataLayer||[]).forEach(function(m){ try {
        if (m && typeof m.length === 'number' && m[0] !== undefined && !Array.isArray(m)) { var a = Array.prototype.slice.call(m); dl.push('gtag:' + a[0] + (a[1] && typeof a[1] === 'string' ? ':' + a[1] : '')); if (a[0] === 'consent') consent.push(JSON.parse(JSON.stringify(a))); }
        else if (m && m.event) dl.push(m.event);
      } catch(e){} }); } catch(e){}
      var ics = null; try { var g = window.google_tag_data && window.google_tag_data.ics; if (g && g.entries) { ics = {}; Object.keys(g.entries).forEach(function(k){ var x = g.entries[k] || {}; ics[k] = { default: x.default, update: x.update, region: x.region, declare: x.declare }; }); } } catch(e){}
      var fb = null; try { if (window.fbq && window.fbq.getState) { var st = window.fbq.getState(); fb = (st.pixels||[]).map(function(p){ return { id: p.id, eventCount: p.eventCount }; }); } } catch(e){}
      var inj = null; try { inj = window.__openartWatchdogInjected || null; } catch(e){}
      return { href: location.href, referrer: document.referrer, ls: ls, dl: dl, consent: consent, ics: ics, fb: fb, inj: inj };
    })()`);
    const snap: StepSnapshot = {
      step,
      href: state?.href ?? this.page.url(),
      referrer: state?.referrer ?? '',
      cookies: await this.cookies(),
      localStorage: state?.ls ?? {},
      dataLayerEvents: state?.dl ?? [],
      consentCommands: state?.consent ?? [],
      googleConsentState: state?.ics ?? null,
      fbq: state?.fb ?? null,
      injectSentinel: state?.inj ?? null,
      extra,
    };
    this.snapshots.push(snap);
    for (const entry of (await this.evaluate<string[]>(SEAL_LOG)) ?? []) if (!this.sealLog.some((x) => x.entry === entry)) this.sealLog.push({ step, entry });
    if (this.opts.screenshotsDir) {
      try {
        fs.mkdirSync(this.opts.screenshotsDir, { recursive: true });
        await this.page.screenshot({ path: path.join(this.opts.screenshotsDir, `${this.opts.name}__${step}.png`) as `${string}.png` });
      } catch {
        /* screenshots are evidence only */
      }
    }
    return snap;
  }

  /**
   * Find a CTA by ordered candidate selectors / text regexes, mark it and click it like a user
   * (mouse click with human delay; if another element covers it, a DOM click). Ported from
   * crawl/teardown2/harness.cjs clickCTA().
   */
  async clickCTA(candidates: Array<{ sel?: string; text?: string; within?: string }>, step: string, opts: { expectNavigation?: boolean; timeoutMs?: number } = {}): Promise<{ found: boolean; how?: unknown; text?: string; href?: string | null; method?: 'mouse' | 'dom-click'; navigated: boolean; before: string; after: string }> {
    const before = this.page.url();
    const found = await this.evaluate<{ how: unknown; text: string; href: string | null; covered: boolean } | null>(`(${FIND_CTA})(${JSON.stringify(candidates)})`);
    if (!found) return { found: false, navigated: false, before, after: before };
    this.step = step;
    const navP = opts.expectNavigation === false ? Promise.resolve('skip') : this.page.waitForNavigation({ waitUntil: 'load', timeout: opts.timeoutMs ?? 45_000 }).then(() => 'nav', () => 'nonav');
    await jitter(600, 1400);
    let method: 'mouse' | 'dom-click' = 'mouse';
    if (found.covered) {
      method = 'dom-click';
      await this.evaluate<boolean>(DOM_CLICK_CTA);
    } else {
      const el = await this.page.$('[data-wd-cta="1"]');
      await el?.click({ delay: 60 + Math.floor(Math.random() * 80) });
    }
    const nav = await navP;
    return { found: true, how: found.how, text: found.text, href: found.href, method, navigated: nav === 'nav', before, after: this.page.url() };
  }

  /** Close promo / what's-new dialogs that sit over the app (port of loggedin crawl.mjs dismissWhatsNew). */
  async dismissOverlays(): Promise<string> {
    const r = (await this.evaluate<string>(DISMISS_OVERLAYS)) ?? 'err';
    await sleep(800);
    return r;
  }

  /** Everything the zero-leak proof needs about this session (call after close()). */
  evidence(id: string, kind: SessionEvidence['kind'], markers: string[], extraAllowedHosts?: RegExp[]): SessionEvidence {
    return {
      id,
      kind,
      requests: this.state.requests,
      net: this.net,
      proxy: this.proxySummary,
      teardown: this.teardown,
      markers,
      extraAllowedHosts,
      extraCollection: this.opts.intercept.policy.extraCollection,
      fetchLayers: {
        browser: this.sessionsInfo.some((x) => x.label === 'browser' && x.fetch === 'enabled'),
        page: this.sessionsInfo.some((x) => x.label === 'page' && x.fetch === 'enabled'),
        failed: [...this.fetchFailures],
      },
      webSockets: this.webSockets,
      heldTargets: this.heldTargets,
      serviceWorkerVersions: this.serviceWorkerVersions,
      extraPages: this.extraPages,
      reportingReports: this.reportingReports,
      sealLog: this.sealLog,
    };
  }

  // ------------------------------------------------------------------ teardown
  async close(): Promise<SessionTeardown> {
    if (this.closed) return this.teardown!;
    this.closed = true;
    this.proxy.seal(); // never let anything out during shutdown
    const sealedBeforeKill = this.proxy.state.sealed;
    const pid = this.browser.process()?.pid;
    const td = pid ? await killChromeTree(pid, this.profile) : {};
    await sleep(500);
    this.proxySummary = this.proxy.summary();
    this.proxySummary.log = this.proxy.state.log;
    await this.proxy.close();
    try {
      fs.rmSync(this.profile, { recursive: true, force: true });
    } catch {
      /* reported below */
    }
    this.teardown = { proxySealedBeforeKill: sealedBeforeKill, processTree: td.processTree, stillAlive: td.stillAlive, allDeadAfterMs: td.allDeadAfterMs, pgrepProfile: td.pgrepProfile, profileDeleted: !fs.existsSync(this.profile), profile: this.profile };
    this.log(`closed; profile deleted=${this.teardown.profileDeleted}; still alive=${(td.stillAlive ?? []).length}`);
    return this.teardown;
  }
}
