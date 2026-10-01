/**
 * The GTM fix pack as data: one definition drives both
 *  - the GTM container export (gtm/import/openart-gtm-fixpack.json, `buildImport()`), and
 *  - the compiled-container proof (gtm/proof/patched_resource.json, `patchContainerResource()`).
 *
 * Every existing tag it touches is identified by its compiled `tag_id` in GTM-56CMP8K v25
 * (raw/gtm_56CMP8K.js.json, resource.tags[*].tag_id) plus identifying fields, so the patcher can
 * refuse to run against a container that has changed.
 */

/** A code body references variables through `ref(name)`; the builders decide how to render them. */
export type Ref = (variableName: string) => string;

export const PREFIX = 'OA-FIX';

/**
 * New items get ids above this in both outputs: export tagId/triggerId/variableId/folderId/templateId
 * and compiled tag_id in the proof (v25's highest tag_id is 79). GTM matches import conflicts by name,
 * so the ids only have to be unique; keeping them clear of existing ids is defence in depth.
 */
export const FIX_ID_BASE = 1000;

export const IDS = {
  gtmPublicId: 'GTM-56CMP8K',
  /** Numeric container id in the compiled blob ("6":"92263201"). */
  containerId: '92263201',
  googleAdsPrimary: '11252321380',
  googleAdsSecondary: '16854695811',
  googleAdsSignupLabel: 'rVk2CJ7Ot8EZEOSYw_Up',
  /** Placeholder until OpenArt creates the "Business subscription" conversion action (CHANGES.md B2). */
  googleAdsBusinessLabelPlaceholder: 'OAFIX_BUSINESS_LABEL_TBD',
  xPixel: 'qwghh',
  xPurchaseEvent: 'tw-qwghh-13vj24',
  xSignupEvent: 'tw-qwghh-13vj22',
  uetTagId: '187107444',
  tiktokPixel: 'D9QOQ5JC77U6RO6J21IG',
  linkedinPartner: '10481401',
  linkedinPurchaseConversion: '29290225',
  linkedinSignupConversion: '29290241',
  redditPixel: 'a2_j6xo78gpljnf',
} as const;

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

export type VariableDef =
  | { kind: 'dlv'; name: string; key: string; note: string }
  | { kind: 'cookie'; name: string; cookie: string; decode: boolean; note: string }
  | { kind: 'jsm'; name: string; body: (r: Ref) => string; note: string }
  | { kind: 'upd'; name: string; emailVariable: string; note: string };

export const V = {
  email: `${PREFIX} DLV - user_data.email`,
  userId: `${PREFIX} DLV - user_id`,
  signupCookie: `${PREFIX} COOKIE - oa_signup_uid`,
  transactionId: `${PREFIX} DLV - eventModel.transaction_id`,
  value: `${PREFIX} DLV - eventModel.value`,
  currency: `${PREFIX} DLV - eventModel.currency`,
  pageLocation: `${PREFIX} DLV - page_location`,
  pageReferrer: `${PREFIX} DLV - page_referrer`,
  pageTitle: `${PREFIX} DLV - page_title`,
  pagePath: `${PREFIX} DLV - page_path`,
  regEventId: `${PREFIX} CJS - reg event_id`,
  purchaseOrderId: `${PREFIX} CJS - purchase order_id`,
  upd: `${PREFIX} UPD - user_data.email`,
} as const;

/** Mirrors app-patches/src/signup-push.ts USER_ID_PATTERN. */
export const USER_ID_REGEX_SOURCE = '^[A-Za-z0-9_-]{1,128}$';

export const VARIABLES: readonly VariableDef[] = [
  { kind: 'dlv', name: V.email, key: 'user_data.email', note: 'Same key as existing macro 5 (used by the Reddit/X/TikTok signup tags).' },
  { kind: 'dlv', name: V.userId, key: 'user_id', note: 'New key pushed with `signup` by app-patches/src/signup-push.ts.' },
  {
    kind: 'cookie',
    name: V.signupCookie,
    cookie: 'oa_signup_uid',
    decode: true,
    note: 'Fallback until the app patch ships: the one-shot "<uid>:<email>" cookie is still present while GTM processes the signup push (module 764475 removes it after dataLayer.push returns).',
  },
  { kind: 'dlv', name: V.transactionId, key: 'eventModel.transaction_id', note: 'Same key as existing macro 1.' },
  { kind: 'dlv', name: V.value, key: 'eventModel.value', note: 'Same key as existing macro 2.' },
  { kind: 'dlv', name: V.currency, key: 'eventModel.currency', note: 'Same key as existing macro 3.' },
  { kind: 'dlv', name: V.pageLocation, key: 'page_location', note: 'From the virtual_page_view contract.' },
  { kind: 'dlv', name: V.pageReferrer, key: 'page_referrer', note: 'From the virtual_page_view contract.' },
  { kind: 'dlv', name: V.pageTitle, key: 'page_title', note: 'From the virtual_page_view contract.' },
  { kind: 'dlv', name: V.pagePath, key: 'page_path', note: 'From the virtual_page_view contract.' },
  {
    kind: 'jsm',
    name: V.regEventId,
    note: 'reg_<uid> — the id Meta (CompleteRegistration eventID) and OpenAI Ads (registration_completed event_id) already use. user_id from the push; else the uid part of oa_signup_uid.',
    body: (r) => `function() {
  var re = /${USER_ID_REGEX_SOURCE}/;
  var uid = ${r(V.userId)};
  if (typeof uid !== 'string' || !re.test(uid)) {
    var raw = ${r(V.signupCookie)};
    var sep = typeof raw === 'string' ? raw.indexOf(':') : -1;
    uid = sep > 0 ? raw.slice(0, sep) : undefined;
  }
  if (typeof uid !== 'string' || !re.test(uid)) { return undefined; }
  return 'reg_' + uid;
}`,
  },
  {
    kind: 'jsm',
    name: V.purchaseOrderId,
    note: 'sub_<invoiceId>: the transaction id itself when it is invoice-derived, undefined for the unstable fallback ids (sub_<tier>_<n>_<uid>_<Date.now()>). It is the purchase dedup key Google Ads, Reddit, TikTok, X and UET already receive and the LinkedIn eventId (packages/contracts: dedup_key_template sub_{invoice_id}).',
    body: (r) => `function() {
  var t = ${r(V.transactionId)};
  if (typeof t !== 'string') { return undefined; }
  var m = /^sub_([A-Za-z0-9_-]{4,128})$/.exec(t);
  if (!m) { return undefined; }
  var id = m[1];
  if (/_\\d{13}$/.test(id) || /^[A-Za-z0-9]+_\\d+_[^_]*_\\d{12,}$/.test(id)) { return undefined; }
  return t;
}`,
  },
  { kind: 'upd', name: V.upd, emailVariable: V.email, note: 'User-Provided Data, manual mode: email from the signup / purchase push.' },
];

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

export const BUILTIN_TRIGGERS = {
  allPages: { name: 'All Pages', id: '2147479553', event: 'gtm.js' },
  consentInit: { name: 'Consent Initialization - All Pages', id: '2147479572', event: 'gtm.init_consent' },
} as const;

export interface Condition {
  variable: string;
  op: 'MATCH_REGEX';
  value: string;
}

export type TriggerDef =
  | { kind: 'customEvent'; name: string; event: string; filters: Condition[]; note: string }
  | { kind: 'historyChange'; name: string; note: string };

export const T = {
  signup: `${PREFIX} CE - signup`,
  purchase: `${PREFIX} CE - purchase (deterministic id)`,
  business: `${PREFIX} CE - business_subscription`,
  virtualPageView: `${PREFIX} CE - virtual_page_view`,
  routeChange: `${PREFIX} HC - route change`,
} as const;

const DETERMINISTIC_PURCHASE: Condition = { variable: V.purchaseOrderId, op: 'MATCH_REGEX', value: '^sub_' };

export const TRIGGERS: readonly TriggerDef[] = [
  { kind: 'customEvent', name: T.signup, event: 'signup', filters: [], note: 'Pushed by Suite module 764475 (SignUpDataLayerEvent).' },
  {
    kind: 'customEvent',
    name: T.purchase,
    event: 'purchase',
    filters: [DETERMINISTIC_PURCHASE],
    note: 'gtag purchase from Suite module 114607 / legacy 49808, only when the id is invoice-derived.',
  },
  {
    kind: 'customEvent',
    name: T.business,
    event: 'business_subscription',
    filters: [DETERMINISTIC_PURCHASE],
    note: 'Pushed by Suite module 111958 eA() for first business purchases (in addition to purchase/first_purchase).',
  },
  { kind: 'customEvent', name: T.virtualPageView, event: 'virtual_page_view', filters: [], note: 'Exactly one per settled route change (app contract or the route settler).' },
  { kind: 'historyChange', name: T.routeChange, note: 'Feeds the route settler; never fires a platform tag directly.' },
];

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

export type FiringOption = 'ONCE_PER_EVENT' | 'UNLIMITED';

/**
 * Optional LinkedIn purchase set-ups (CHANGES.md B3), each shipped paused in the import and
 * compiled into its own proof file; the default proof is option a.
 *  - 'linkedin-server-only' (option b): tag 58 paused; conversion-service sends LinkedIn purchases
 *    through the Conversions API only, with value.
 *  - 'linkedin-lintrk-value' (option c): LinkedIn purchase sent with lintrk() incl. conversion_value.
 */
export type ProofVariant = 'linkedin-lintrk-value' | 'linkedin-server-only';

/** Original compiled tag this definition replaces (paused in the UI; unreferenced in the proof). */
export interface Replaces {
  tagId: number;
  function: string;
  /** A field that must match in the compiled tag, as a guard against a changed container. */
  guard: [string, string];
  what: string;
}

/**
 * GTM "Additional consent checks" for non-Google ad tags: ad_storage, plus ad_user_data for tags
 * that send user-provided data (an email) to the platform.
 */
export const AD_TAG_CONSENT = ['ad_storage'] as const;
export const USER_DATA_TAG_CONSENT = ['ad_storage', 'ad_user_data'] as const;

interface TagBase {
  name: string;
  triggers: string[];
  firing: FiringOption;
  /** GTM "Additional consent checks": consent types required for the tag to fire. */
  consent: readonly string[];
  replaces?: Replaces;
  /** Included in the compiled proof (false when it needs runtime code the v25 container lacks). */
  inProof: boolean;
  /** Exported paused (optional variant OpenArt can switch on). */
  paused?: boolean;
  /** Proof variant this tag belongs to (only compiled when that variant is requested). */
  variant?: ProofVariant;
  note: string;
}

export interface HtmlTagDef extends TagBase {
  kind: 'html';
  html: (r: Ref) => string;
}

export interface AwctTagDef extends TagBase {
  kind: 'awct';
  conversionId: string;
  conversionLabel: string;
  orderIdVariable?: string;
  valueVariable?: string;
  currencyVariable?: string;
  updVariable?: string;
}

export interface TemplateTagDef extends TagBase {
  kind: 'consentTemplate';
}

export type TagDef = HtmlTagDef | AwctTagDef | TemplateTagDef;

/** X base code exactly as tag_id 74 has it, plus the dataLayerTracking opt-out before config. */
export const X_BASE_ORIGINAL =
  '!function(d,e,f,a,b,c){d.twq||(a=d.twq=function(){a.exe?a.exe.apply(a,arguments):a.queue.push(arguments)},a.version="1.1",a.queue=[],b=e.createElement(f),b.async=!0,b.src="https://static.ads-twitter.com/uwt.js",c=e.getElementsByTagName(f)[0],c.parentNode.insertBefore(b,c))}(window,document,"script");twq.integration="gtm-ad-manager";twq("config","qwghh");';

export const X_DATALAYER_OPT_OUT = 'twq("set","dataLayerTracking","false","qwghh");';

export function xBaseFixed(): string {
  return X_BASE_ORIGINAL.replace('twq("config","qwghh");', `${X_DATALAYER_OPT_OUT}twq("config","qwghh");`);
}

/** UET base code exactly as tag_id 38 has it; the fix turns automatic SPA tracking off. */
export const UET_BASE_ORIGINAL =
  '(function(c,d,f,g,e){c[e]=c[e]||[];var h=function(){var b={ti:"187107444",enableAutoSpaTracking:!0};b.q=c[e];c[e]=new UET(b);c[e].push("pageLoad")};var a=d.createElement(f);a.src=g;a.async=1;a.onload=a.onreadystatechange=function(){var b=this.readyState;b&&b!=="loaded"&&b!=="complete"||(h(),a.onload=a.onreadystatechange=null)};d=d.getElementsByTagName(f)[0];d.parentNode.insertBefore(a,d)})(window,document,"script","https://bat.bing.net/bat.js","uetq");';

export function uetBaseFixed(): string {
  return UET_BASE_ORIGINAL.replace('enableAutoSpaTracking:!0', 'enableAutoSpaTracking:!1');
}

/** TikTok base code exactly as tag_id 77 has it (script body, trimmed). */
export const TIKTOK_BASE_ORIGINAL =
  "!function(d,h,e){d.TiktokAnalyticsObject=e;var a=d[e]=d[e]||[];a.methods=\"page track identify instances debug on off once ready alias group enableCookie disableCookie holdConsent revokeConsent grantConsent\".split(\" \");a.setAndDefer=function(b,c){b[c]=function(){b.push([c].concat(Array.prototype.slice.call(arguments,0)))}};for(d=0;d<a.methods.length;d++)a.setAndDefer(a,a.methods[d]);a.instance=function(b){b=a._i[b]||[];for(var c=0;c<a.methods.length;c++)a.setAndDefer(b,a.methods[c]);return b};a.load=\nfunction(b,c){var f=\"https://analytics.tiktok.com/i18n/pixel/events.js\",g=c&&c.partner;a._i=a._i||{};a._i[b]=[];a._i[b]._u=f;a._i[b]._partner=g||\"GoogleTagManagerClient\";a._t=a._t||{};a._t[b]=+new Date;a._o=a._o||{};a._o[b]=c||{};a._partner=a._partner||\"GoogleTagManagerClient\";c=document.createElement(\"script\");c.type=\"text/javascript\";c.async=!0;c.src=f+\"?sdkid\\x3d\"+b+\"\\x26lib\\x3d\"+e;b=document.getElementsByTagName(\"script\")[0];b.parentNode.insertBefore(c,b)};a.load(\"D9QOQ5JC77U6RO6J21IG\");a.page()}(window,\ndocument,\"ttq\");";

export const TIKTOK_LOAD_ORIGINAL = 'a.load("D9QOQ5JC77U6RO6J21IG")';

/**
 * The fix passes the per-pixel option the TikTok SDK checks before observing the History API:
 * main.*.js fo(t) = `t.options && t.options.historyObserver !== false && t.plugins.HistoryObserver`
 * (gtm/test/fixtures/tiktok-sdk-history-observer.js). ttq.load(pixel, options) stores options in
 * ttq._o[pixel], which the pixel config hands to the SDK as `options`. [C: shipped SDK code; the option
 * is not in TikTok's public docs.]
 */
export function tiktokBaseFixed(): string {
  return TIKTOK_BASE_ORIGINAL.replace(TIKTOK_LOAD_ORIGINAL, 'a.load("D9QOQ5JC77U6RO6J21IG",{historyObserver:!1})');
}

export const ROUTE_SETTLER_SETTLE_MS = 500;
export const ROUTE_SETTLER_MAX_WAIT_MS = 2000;

function routeSettler(r: Ref): string {
  return `<script>
(function (w, d) {
  // OA-FIX route settler: History Change events -> exactly one virtual_page_view per settled route.
  // Same algorithm as app-patches/src/page-view-contract.ts; stands down when the app emits it.
  var S = w.__oaRouteSettler = w.__oaRouteSettler || { last: null, lastHref: null, timer: null, firstAt: 0, hooked: false };
  function routeKey() {
    var p = w.location.pathname || '/';
    if (p.length > 1) { p = p.replace(/\\/+$/, '') || '/'; }
    return p;
  }
  function pageViewId() {
    var b = [], i, h = '', c = w.crypto;
    for (i = 0; i < 16; i++) { b[i] = Math.floor(Math.random() * 256); }
    if (c && typeof c.getRandomValues === 'function') {
      var a = new Uint8Array(16);
      c.getRandomValues(a);
      for (i = 0; i < 16; i++) { b[i] = a[i]; }
    }
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    for (i = 0; i < 16; i++) {
      h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
      if (i === 3 || i === 5 || i === 7 || i === 9) { h += '-'; }
    }
    return h;
  }
  function flush() {
    S.timer = null;
    S.firstAt = 0;
    if (w.__oaPageViewContract === 'app') { return; }
    var k = routeKey();
    if (k === S.last) { return; }
    var referrer = S.lastHref;
    S.last = k;
    S.lastHref = w.location.href;
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({
      event: 'virtual_page_view',
      page_view_id: pageViewId(),
      page_location: w.location.href,
      page_path: k,
      page_title: d.title,
      page_referrer: referrer,
      page_view_source: 'gtm_history'
    });
  }
  if (S.last === null) { S.last = routeKey(); S.lastHref = w.location.href; }
  if (!S.hooked) {
    S.hooked = true;
    w.addEventListener('pagehide', function () { if (S.timer) { clearTimeout(S.timer); flush(); } });
  }
  if (${r('Event')} === 'gtm.js') { return; }
  if (w.__oaPageViewContract === 'app') { return; }
  var now = new Date().getTime();
  if (!S.firstAt) { S.firstAt = now; }
  if (S.timer) { clearTimeout(S.timer); }
  S.timer = setTimeout(flush, Math.max(0, Math.min(${ROUTE_SETTLER_SETTLE_MS}, S.firstAt + ${ROUTE_SETTLER_MAX_WAIT_MS} - now)));
})(window, document);
</script>`;
}

export const TAGS: readonly TagDef[] = [
  {
    kind: 'consentTemplate',
    name: `${PREFIX} Consent Mode v2 - defaults (EEA/UK/CH denied)`,
    triggers: [BUILTIN_TRIGGERS.consentInit.name],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: false,
    note: 'Custom template (setDefaultConsentState + gtagSet). The v25 runtime has no template code for it; the proof injects consent/dist/openart-consent-defaults.min.js instead.',
  },
  {
    kind: 'awct',
    name: `${PREFIX} Google Ads - signup conversion (rVk2) on signup`,
    triggers: [T.signup],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: true,
    conversionId: IDS.googleAdsPrimary,
    conversionLabel: IDS.googleAdsSignupLabel,
    orderIdVariable: V.regEventId,
    updVariable: V.upd,
    replaces: { tagId: 17, function: '__awct', guard: ['vtp_conversionLabel', IDS.googleAdsSignupLabel], what: 'Google Ads signup conversion on new_user_signed_up (never emitted)' },
    note: 'Fires on the event the app actually pushes; order id reg_<uid> dedups repeats and matches a server twin; user-provided data from user_data.email.',
  },
  {
    kind: 'awct',
    name: `${PREFIX} Google Ads - business_subscription (secondary action)`,
    triggers: [T.business],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: true,
    conversionId: IDS.googleAdsPrimary,
    conversionLabel: IDS.googleAdsBusinessLabelPlaceholder,
    orderIdVariable: V.transactionId,
    valueVariable: V.value,
    currencyVariable: V.currency,
    updVariable: V.upd,
    note: 'Separate "Business subscription" conversion (set as Secondary in Google Ads). Business sales already fire the purchase conversions, so re-firing those would double count.',
  },
  {
    kind: 'html',
    name: `${PREFIX} Google Ads - page_view on route change`,
    triggers: [T.virtualPageView],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: true,
    note: 'Remarketing page_view for both Ads destinations of the Google tag on SPA routes (Suite/legacy soft navigations send none today).',
    html: (r) => `<script>
(function () {
  window.dataLayer = window.dataLayer || [];
  var gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  gtag('event', 'page_view', {
    send_to: ['AW-${IDS.googleAdsPrimary}', 'AW-${IDS.googleAdsSecondary}'],
    page_location: ${r(V.pageLocation)},
    page_referrer: ${r(V.pageReferrer)},
    page_title: ${r(V.pageTitle)}
  });
})();
</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} X - base pixel (no automatic gtm_purchase)`,
    triggers: [BUILTIN_TRIGGERS.allPages.name, T.virtualPageView],
    firing: 'ONCE_PER_EVENT',
    consent: ['ad_storage'],
    inProof: true,
    replaces: { tagId: 74, function: '__html', guard: ['vtp_html', 'twq("config","qwghh")'], what: 'X base pixel' },
    note: "uwt.js 2.4.11 turns dataLayer ecommerce events into automatic `gtm_<event>` events (module 9115) unless twq('set','dataLayerTracking','false',pixel) runs before config. Re-running config on virtual_page_view is X's page view for SPA routes. The purchase event itself stays on the existing tag (conversion_id = transaction id sub_<invoiceId>), now on the deterministic purchase trigger.",
    html: () => `<script>${xBaseFixed()}</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} X - signup ${IDS.xSignupEvent} (conversion_id reg_<uid>)`,
    triggers: [T.signup],
    firing: 'ONCE_PER_EVENT',
    consent: USER_DATA_TAG_CONSENT, // sends email_address
    inProof: true,
    replaces: { tagId: 76, function: '__html', guard: ['vtp_html', IDS.xSignupEvent], what: 'X signup event' },
    note: 'Adds the reg_<uid> dedup key for a future X Conversions API twin.',
    html: (r) => `<script>twq("event","${IDS.xSignupEvent}",{email_address:${r(V.email)},conversion_id:${r(V.regEventId)}});</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} TikTok - CompleteRegistration (event_id reg_<uid>)`,
    triggers: [T.signup],
    firing: 'ONCE_PER_EVENT',
    consent: USER_DATA_TAG_CONSENT, // sends the email via ttq.identify
    inProof: true,
    replaces: { tagId: 79, function: '__html', guard: ['vtp_html', 'CompleteRegistration'], what: 'TikTok CompleteRegistration (empty event_id)' },
    note: 'TikTok dedups pixel vs Events API on event_source_id + event + event_id.',
    html: (r) => `<script>
(function () {
  if (typeof ttq === 'undefined') { return; }
  var email = ${r(V.email)};
  var eventId = ${r(V.regEventId)};
  if (typeof email === 'string' && email.indexOf('@') > -1) { ttq.identify({ email: email.toLowerCase() }); }
  if (typeof eventId === 'string' && eventId) { ttq.track('CompleteRegistration', {}, { event_id: eventId }); }
  else { ttq.track('CompleteRegistration'); }
})();
</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} UET - base (automatic SPA tracking off)`,
    triggers: [BUILTIN_TRIGGERS.allPages.name],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: true,
    replaces: { tagId: 38, function: '__html', guard: ['vtp_html', 'ti:"187107444"'], what: 'UET base with enableAutoSpaTracking' },
    note: 'bat.js auto-SPA tracking sends one page_view per URL change (3 for one create-image navigation in P07); page views now come from virtual_page_view.',
    html: () => `<script>${uetBaseFixed()}</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} UET - page_view on route change`,
    triggers: [T.virtualPageView],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: true,
    note: "Same call bat.js makes internally for SPA page views: uetq.push('event','page_view',{page_path}).",
    html: (r) => `<script>
(function () {
  window.uetq = window.uetq || [];
  window.uetq.push('event', 'page_view', {
    page_path: window.location.pathname + window.location.search,
    page_title: ${r(V.pageTitle)}
  });
})();
</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} TikTok - base pixel (automatic SPA page views off)`,
    triggers: [BUILTIN_TRIGGERS.allPages.name],
    firing: 'ONCE_PER_EVENT',
    consent: ['ad_storage'],
    inProof: true,
    replaces: { tagId: 77, function: '__html', guard: ['vtp_html', IDS.tiktokPixel], what: 'TikTok base pixel (SDK HistoryObserver on)' },
    note: 'The SDK HistoryObserver sends one Pageview per URL change (2 for one create-image navigation in the 2026-09-30 watchdog baseline); page views now come from virtual_page_view.',
    html: () => `<script>${tiktokBaseFixed()}</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} TikTok - page on route change`,
    triggers: [T.virtualPageView],
    firing: 'ONCE_PER_EVENT',
    consent: ['ad_storage'],
    inProof: true,
    note: 'ttq.page() is the call the base code makes on load and the SDK makes per URL change.',
    html: () => `<script>
(function () {
  if (typeof ttq === 'undefined' || typeof ttq.page !== 'function') { return; }
  ttq.page();
})();
</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} LinkedIn - purchase 29290225 via lintrk (value variant, paused)`,
    triggers: [T.purchase],
    firing: 'ONCE_PER_EVENT',
    consent: ['ad_storage'],
    inProof: false,
    paused: true,
    variant: 'linkedin-lintrk-value',
    replaces: { tagId: 58, function: '__cvt_TB7ZX', guard: ['vtp_conversionId', IDS.linkedinPurchaseConversion], what: 'LinkedIn purchase conversion 29290225 (template)' },
    note: "OPTIONAL. LinkedIn's documented event call (lintrk('track',{conversion_id,event_id}), dedup guide) plus conversion_value/conversion_currency, which the Insight library OpenArt loads (insight.beta.min.js) maps to val/cur but LinkedIn does not document publicly. Unpause only after confirming values in Campaign Manager; pause the template tag 29290225 at the same time.",
    html: (r) => `<script>
(function () {
  var eventId = ${r(V.purchaseOrderId)};
  var value = parseFloat(${r(V.value)});
  var currency = ${r(V.currency)};
  var payload = { conversion_id: ${IDS.linkedinPurchaseConversion} };
  if (typeof eventId === 'string' && eventId) { payload.event_id = eventId; }
  if (!isNaN(value) && isFinite(value)) { payload.conversion_value = value; }
  if (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)) { payload.conversion_currency = currency.toUpperCase(); }
  if (typeof window.lintrk === 'function') { window.lintrk('track', payload); return; }
  var img = new Image(1, 1);
  img.src = 'https://px.ads.linkedin.com/collect/?pid=${IDS.linkedinPartner}&conversionId=${IDS.linkedinPurchaseConversion}&fmt=gif' + (payload.event_id ? '&eventId=' + encodeURIComponent(payload.event_id) : '');
})();
</script>`,
  },
  {
    kind: 'html',
    name: `${PREFIX} Route settler (History Change -> virtual_page_view)`,
    triggers: [BUILTIN_TRIGGERS.allPages.name, T.routeChange],
    firing: 'UNLIMITED',
    consent: [],
    inProof: false,
    note: 'Needs the History Change listener (__hl), which the v25 runtime does not contain; the proof pushes virtual_page_view directly.',
    html: routeSettler,
  },
  // Appended last on purpose: new tags take FIX_ID_BASE + position, so the default proof's tag_ids never move.
  {
    kind: 'html',
    name: `${PREFIX} LinkedIn - server-only purchases via conversion-service (option b, paused)`,
    triggers: [T.purchase],
    firing: 'ONCE_PER_EVENT',
    consent: [],
    inProof: false,
    paused: true,
    variant: 'linkedin-server-only',
    replaces: { tagId: 58, function: '__cvt_TB7ZX', guard: ['vtp_conversionId', IDS.linkedinPurchaseConversion], what: 'LinkedIn purchase conversion 29290225 (template)' },
    note:
      "OPTIONAL option (b) of CHANGES.md B3: LinkedIn purchases server-only, with value. Choosing it = pause tag_id 58 (LinkedIn purchase conversion 29290225) and unpause this tag in the same version; conversion-service's LinkedIn Conversions API purchase (eventId sub_<invoiceId>, conversionValue) then becomes the only copy. Why: when a browser and a CAPI event share an eventId, LinkedIn keeps the Insight Tag event and discards the CAPI one, so with tag 58 live the server value never counts for browser-seen purchases. This tag sends nothing to LinkedIn: it records the choice in the container and fires on the deterministic purchase trigger for Tag Assistant QA. Needs conversion-service live for LinkedIn; only CAPI-matched purchases count.",
    html: () => `<script>
/* OA-FIX LinkedIn option (b): LinkedIn purchases are reported server-side only, by conversion-service
   (Conversions API, eventId sub_<invoiceId>, conversionValue). Tag 58 is paused in this set-up.
   This tag sends nothing. */
</script>`,
  },
];

/* ------------------------------------------------------------------ */
/* Gallery-template tags: documented field changes (CHANGES.md)        */
/* ------------------------------------------------------------------ */

export interface GalleryEdit {
  tagId: number;
  function: '__cvt_PBGZL' | '__cvt_TB7ZX';
  template: string;
  guard: [string, string];
  what: string;
  /** Template field -> new value (variable reference or literal). */
  fields?: Record<string, string>;
  addTriggers?: string[];
  /** Swap the firing trigger (e.g. purchase -> deterministic purchase). */
  replaceTrigger?: { from: string; to: string };
  firing?: 'ONCE_PER_EVENT';
}

export const GALLERY_EDITS: readonly GalleryEdit[] = [
  {
    tagId: 58,
    function: '__cvt_TB7ZX',
    template: 'LinkedIn Insight Tag 2.0',
    guard: ['vtp_conversionId', IDS.linkedinPurchaseConversion],
    what: 'LinkedIn purchase conversion 29290225',
    fields: { eventId: `{{${V.purchaseOrderId}}}` },
    replaceTrigger: { from: 'purchase', to: T.purchase },
  },
  {
    tagId: 72,
    function: '__cvt_TB7ZX',
    template: 'LinkedIn Insight Tag 2.0',
    guard: ['vtp_conversionId', IDS.linkedinSignupConversion],
    what: 'LinkedIn signup conversion 29290241',
    fields: { eventId: `{{${V.regEventId}}}` },
  },
  {
    tagId: 52,
    function: '__cvt_TB7ZX',
    template: 'LinkedIn Insight Tag 2.0',
    guard: ['vtp_partnerId', IDS.linkedinPartner],
    what: 'LinkedIn base Insight Tag (page view)',
    addTriggers: [T.virtualPageView],
  },
  {
    tagId: 34,
    function: '__cvt_PBGZL',
    template: 'Reddit Pixel',
    guard: ['vtp_eventType', 'PageVisit'],
    what: 'Reddit PageVisit',
    addTriggers: [T.virtualPageView],
    firing: 'ONCE_PER_EVENT',
  },
  {
    tagId: 35,
    function: '__cvt_PBGZL',
    template: 'Reddit Pixel',
    guard: ['vtp_eventType', 'Purchase'],
    what: 'Reddit Purchase',
    replaceTrigger: { from: 'purchase', to: T.purchase },
  },
  {
    tagId: 57,
    function: '__cvt_PBGZL',
    template: 'Reddit Pixel',
    guard: ['vtp_eventType', 'SignUp'],
    what: 'Reddit SignUp',
    fields: { conversionId: `{{${V.regEventId}}}` },
  },
];

/**
 * Built-in tag types (Google Ads, Custom HTML) whose content is already right: trigger swap only
 * (manual in the UI, applied in the proof). Their ids are invoice-derived whenever the new trigger fires.
 */
export const BUILTIN_TRIGGER_SWAPS: ReadonlyArray<{ tagId: number; function: '__awct' | '__html'; guard: [string, string]; what: string; from: string; to: string }> = [
  { tagId: 15, function: '__awct', guard: ['vtp_conversionLabel', 'OfGcCJisoLQZEOSYw_Up'], what: 'Google Ads purchase AW-11252321380', from: 'purchase', to: T.purchase },
  { tagId: 19, function: '__awct', guard: ['vtp_conversionLabel', '4Rf-CM6EhJMcEIP_-OQ-'], what: 'Google Ads purchase AW-16854695811', from: 'purchase', to: T.purchase },
  { tagId: 75, function: '__html', guard: ['vtp_html', IDS.xPurchaseEvent], what: `X purchase ${IDS.xPurchaseEvent} (conversion_id = transaction id)`, from: 'purchase', to: T.purchase },
];
