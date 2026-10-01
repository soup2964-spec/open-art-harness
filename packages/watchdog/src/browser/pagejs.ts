// Page-side code, kept as plain JavaScript STRINGS on purpose: tsx/esbuild compile TypeScript with
// keep-names, which wraps named inner functions in a `__name()` helper that does not exist inside
// the page. The snippets are evaluated with Runtime.evaluate in the page's main world; apart from
// SEAL_INIT (the in-page part of the seal) they only read the DOM, mark one element or click a
// close button; none of them issues a request.

/**
 * In-page part of the collection seal, installed in every page, frame and worker BEFORE its own
 * scripts run (Page.addScriptToEvaluateOnNewDocument + Runtime.evaluate while the target is still
 * paused by waitForDebuggerOnStart). It closes the channels the CDP Fetch domain cannot see:
 *   - WebSocket / WebSocketStream / WebTransport: handshakes bypass Fetch (and Network.setBlockedURLs
 *     does not stop them — verified on a loopback server), so their constructors throw;
 *   - service workers: a registration's script fetch and the worker's own requests can escape
 *     Fetch, so ServiceWorkerContainer.register() rejects before any fetch;
 *   - SharedWorker, window.open: blocked (popups would need their own instrumentation).
 * Every blocked attempt is logged in a non-enumerable global (__wdSealLog) that snapshots read.
 * Same-origin about:blank child frames are sealed when first reached through contentWindow /
 * contentDocument. (Speculation-rules prefetch/prerender and the Reporting API are disabled by
 * Chrome preferences / flags in the harness, not here.)
 */
export const SEAL_INIT = `(function () {
  function seal(g) {
    try {
      if (!g || g.__wdSealInstalled) return;
      var log = [];
      try { Object.defineProperty(g, '__wdSealLog', { value: log, enumerable: false, configurable: false, writable: false }); Object.defineProperty(g, '__wdSealInstalled', { value: true, enumerable: false, configurable: false, writable: false }); } catch (e) { return; }
      var DE = g.DOMException || Error;
      function note(kind, detail) { try { if (log.length < 200) log.push(kind + ' ' + String(detail === undefined ? '' : detail).slice(0, 300)); } catch (e) {} }
      function refuse(name) { return new DE(name + ' blocked by the OpenArt watchdog collection seal', 'SecurityError'); }
      function blockCtor(name) {
        var C = g[name];
        if (!C || C.__wdBlocked) return;
        var P = function () { note(name, arguments[0]); throw refuse(name); };
        P.prototype = C.prototype; P.CONNECTING = 0; P.OPEN = 1; P.CLOSING = 2; P.CLOSED = 3; P.__wdBlocked = true;
        try { Object.defineProperty(C.prototype, 'constructor', { value: P, configurable: true, writable: true }); } catch (e) {}
        try { Object.defineProperty(g, name, { value: P, configurable: true, writable: true }); } catch (e) { try { g[name] = P; } catch (e2) {} }
      }
      blockCtor('WebSocket'); blockCtor('WebSocketStream'); blockCtor('WebTransport'); blockCtor('SharedWorker');
      var SWC = g.ServiceWorkerContainer;
      if (SWC && SWC.prototype && SWC.prototype.register) {
        try { Object.defineProperty(SWC.prototype, 'register', { value: function (u) { note('serviceWorker.register', u); return Promise.reject(refuse('service worker registration')); }, configurable: true, writable: true }); } catch (e) {}
      }
      if (g.Window && g instanceof g.Window) {
        try { Object.defineProperty(g, 'open', { value: function (u) { note('window.open', u); return null; }, configurable: true, writable: true }); } catch (e) {}
        var F = g.HTMLIFrameElement && g.HTMLIFrameElement.prototype;
        ['contentWindow', 'contentDocument'].forEach(function (prop) {
          var d = F && Object.getOwnPropertyDescriptor(F, prop);
          if (!d || !d.get) return;
          var get = d.get;
          try { Object.defineProperty(F, prop, { get: function () { var v = get.call(this); try { seal(prop === 'contentWindow' ? v : v && v.defaultView); } catch (e) {} return v; }, configurable: true, enumerable: d.enumerable }); } catch (e) {}
        });
      }
    } catch (e) {}
  }
  seal(typeof self !== 'undefined' ? self : window);
})();`;

/** Read (and not clear) the in-page seal log of the main frame. */
export const SEAL_LOG = `(function () { try { return (window.__wdSealLog || []).slice(0, 200); } catch (e) { return []; } })()`;

/** Find the first visible element matching ordered candidates; mark it data-wd-cta="1". Port of teardown2 clickCTA(). */
export const FIND_CTA = `function (cands) {
  function visible(el) { var r = el.getBoundingClientRect(); var cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; }
  document.querySelectorAll('[data-wd-cta]').forEach(function (x) { x.removeAttribute('data-wd-cta'); });
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i]; var els = [];
    if (c.sel) els = Array.prototype.slice.call(document.querySelectorAll(c.sel));
    if (c.text) {
      var re = new RegExp(c.text, 'i');
      els = Array.prototype.slice.call(document.querySelectorAll(c.within || 'a, button')).filter(function (e) { return re.test(((e.innerText || e.textContent || '') + '').trim()); });
    }
    els = els.filter(visible);
    if (els.length) {
      var el = els[0];
      el.setAttribute('data-wd-cta', '1');
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { how: c, text: ((el.innerText || '') + '').trim().slice(0, 80), href: el.getAttribute('href'), covered: !(top && (top === el || el.contains(top))) };
    }
  }
  return null;
}`;

export const DOM_CLICK_CTA = `(function () { var el = document.querySelector('[data-wd-cta="1"]'); if (el) el.click(); return !!el; })()`;

/** Close promo / what's-new dialogs (port of loggedin/_scripts/crawl.mjs dismissWhatsNew). */
export const DISMISS_OVERLAYS = `(function () {
  var dialogs = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));
  var d = dialogs.filter(function (x) { return /What's New|% off|promo/i.test(x.innerText || ''); })[0];
  if (!d) return 'none';
  var btn = d.querySelector('button[aria-label*="lose" i]') || Array.prototype.slice.call(d.querySelectorAll('button')).filter(function (b) { return !((b.innerText || '') + '').trim(); })[0];
  if (!btn) return 'no-close-btn';
  btn.click();
  return 'closed';
})()`;

/** Port of teardown2 run.cjs inspectHandoff(): the in-app-browser "Open page in your browser" hint + overlay. */
export const INSPECT_HANDOFF = `(function () {
  function txt(el) { return ((el.innerText || el.textContent || '') + '').trim().replace(/\\s+/g, ' '); }
  var hint = Array.prototype.slice.call(document.querySelectorAll('button, a')).filter(function (el) { return /Trouble redirecting|Open page in your browser/i.test(txt(el)); });
  var overlays = Array.prototype.slice.call(document.querySelectorAll('[data-guide-backdrop], [role="dialog"]')).map(function (e) {
    return { text: txt(e).slice(0, 900), spans: Array.prototype.slice.call(e.querySelectorAll('span[data-notranslate]')).map(function (x) { return x.textContent || ''; }) };
  });
  return { href: location.href, hintCount: hint.length, overlays: overlays };
})()`;

/**
 * Close the anonymous sign-up / sign-in wall via its close button (never touching its email/password
 * fields). Returns 'closed' | 'none' | 'no-close-btn'.
 */
export const CLOSE_AUTH_WALL = `(function () {
  var dialogs = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'));
  var d = dialogs.filter(function (x) { var r = x.getBoundingClientRect(); return r.width > 50 && r.height > 50 && /Sign[- ]?up|Sign in|Log in|Welcome to OpenArt/i.test(x.innerText || ''); })[0];
  if (!d) return 'none';
  var labelled = d.querySelector('button[aria-label*="lose" i], [data-dialog-close], [aria-label*="dismiss" i]');
  var btn = labelled;
  if (!btn) {
    // the icon-only button nearest the dialog's top-right corner (the X), never one inside a form
    var box = d.getBoundingClientRect();
    var cands = Array.prototype.slice.call(d.querySelectorAll('button, [role="button"]')).filter(function (b) {
      var r = b.getBoundingClientRect();
      return !((b.innerText || '') + '').trim() && b.querySelector('svg') && !b.closest('form') && r.width > 4 && r.width < 64 && r.top < box.top + 80;
    });
    cands.sort(function (a, b) { var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (rb.right - rb.top) - (ra.right - ra.top); });
    btn = cands[0];
  }
  if (!btn) return 'no-close-btn';
  btn.click();
  return 'closed';
})()`;

/** Mark the generation prompt editor (textarea / contenteditable) outside any dialog; returns a description or null. */
export const FIND_PROMPT = `(function () {
  document.querySelectorAll('[data-wd-prompt]').forEach(function (x) { x.removeAttribute('data-wd-prompt'); });
  var els = Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter(function (e) {
    var r = e.getBoundingClientRect(); var cs = getComputedStyle(e);
    return r.width > 100 && r.height > 18 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[role="dialog"], [aria-modal="true"], dialog') && !e.disabled;
  });
  if (!els.length) return null;
  var el = els[0]; el.setAttribute('data-wd-prompt', '1'); el.scrollIntoView({ block: 'center' });
  return { tag: el.tagName, contentEditable: el.getAttribute('contenteditable'), placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '', inForm: !!el.closest('form') };
})()`;

/** Visible same-origin Suite links usable as soft-navigation targets. */
export const SPA_TARGETS = `(function () {
  function vis(el) { var b = el.getBoundingClientRect(); return b.width > 2 && b.height > 2; }
  var hrefs = Array.prototype.slice.call(document.querySelectorAll('a[href]')).filter(vis).map(function (a) { return a.getAttribute('href') || ''; })
    .filter(function (h) { return /^\\/(suite\\/[a-z]|home$)/.test(h) && !/sign|login|pricing|subscri|account|logout/.test(h) && h.split('?')[0] !== location.pathname; });
  return Array.from(new Set(hrefs));
})()`;
