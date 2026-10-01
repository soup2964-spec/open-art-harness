// A focused static network-filter engine for simulating uBlock Origin's DEFAULT lists
// (crawl/teardown2/blocklists: uBlock filters/badware/privacy/quick-fixes/unbreak/resource-abuse,
// EasyList, EasyPrivacy, Peter Lowe — the set uBO's assets.json enables by default).
//
// Supported: ||host anchors, | anchors, * wildcards, ^ separators, /regex/ filters, @@ exceptions,
// $important, $badfilter, resource types (script, image, stylesheet, xhr, ping, frame, font, media,
// websocket, other, document, all) and their negations, $1p/$3p (+ strict variants), $domain=/from=,
// $to=, $denyallow=, $method=, $match-case, $redirect= (treated as block), $removeparam, the
// `!#if` preprocessor for uBO on desktop Chromium, pure-hostname and hosts-file lines.
// Filters whose options only modify responses (csp, header, permissions, replace, urltransform,
// urlskip, popup, cosmetic/elemhide families) are ignored: they never block a request.
// Validated against @ghostery/adblocker verdicts for every saved journey request
// (test/fixtures/ubo-oracle.json, test/ubo.test.ts).
import fs from 'node:fs';
import path from 'node:path';

export type UboType = 'document' | 'subdocument' | 'script' | 'image' | 'stylesheet' | 'xmlhttprequest' | 'ping' | 'font' | 'media' | 'websocket' | 'other' | 'object' | 'popup';

const TYPE_ALIASES: Record<string, UboType | 'all'> = {
  script: 'script', image: 'image', img: 'image', stylesheet: 'stylesheet', css: 'stylesheet', xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
  ping: 'ping', beacon: 'ping', subdocument: 'subdocument', frame: 'subdocument', font: 'font', media: 'media', websocket: 'websocket', other: 'other',
  object: 'object', 'object-subrequest': 'object', document: 'document', doc: 'document', popup: 'popup', all: 'all', webrtc: 'other',
};
// Filters carrying these options never block a request on desktop Chromium, so they are skipped:
//   response modifiers (csp, header, permissions, replace, urltransform, urlskip), cosmetic families,
//   redirect-rule= (only redirects what another filter already blocks), ipaddress= (needs DNS
//   resolution, unavailable to uBO on Chromium — cap_ipaddress is false), AdGuard's rewrite=.
const IGNORED_FILTER_OPTIONS = new Set(['csp', 'header', 'permissions', 'replace', 'urltransform', 'uritransform', 'urlskip', 'popunder', 'generichide', 'ghide', 'elemhide', 'ehide', 'specifichide', 'shide', 'genericblock', 'inline-script', 'inline-font', 'cname', 'redirect-rule', 'ipaddress', 'rewrite']);
// Informational or "block with a surrogate" options: the filter still blocks.
const NEUTRAL_OPTIONS = new Set(['reason', 'mp4', 'empty']);

export interface DomainList {
  include: string[];
  exclude: string[];
}

export interface NetworkFilter {
  raw: string;
  exception: boolean;
  important: boolean;
  badfilter: boolean;
  re: RegExp | null; // null = matches every URL
  indexHost: string | null;
  tokens: string[];
  types: Set<UboType> | null; // null = default types
  notTypes: Set<UboType>;
  party: '1p' | '3p' | null;
  strictParty: boolean;
  domains: DomainList | null;
  to: DomainList | null;
  denyallow: string[] | null;
  methods: DomainList | null;
  redirect: boolean;
  removeparam: { all: boolean; negate: boolean; name?: string; re?: RegExp } | null;
  pureHostname: boolean;
}

export interface UboRequest {
  url: string;
  type: UboType;
  sourceUrl: string;
  method?: string;
}

export interface MatchResult {
  blocked: boolean;
  filter?: string;
  exception?: string;
}

// ---------------------------------------------------------------------------- helpers
const SUFFIX2 = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.hk', 'com.sg', 'co.in', 'co.kr', 'co.nz', 'com.tr', 'com.mx', 'pages.dev', 'workers.dev', 'on.aws', 'run.app', 'github.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'appspot.com', 'cloudfront.net', 'azurewebsites.net', 'blogspot.com', 'web.app', 'firebaseapp.com']);
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (SUFFIX2.has(last2)) return parts.slice(-3).join('.');
  const last3 = parts.slice(-3).join('.');
  if (/\.(amazonaws\.com)$/.test(h) || /\.on\.aws$/.test(h)) return last3;
  return last2;
}

function hostMatchesEntry(host: string, entry: string): boolean {
  if (entry.startsWith('/') && entry.endsWith('/') && entry.length > 2) {
    try {
      return new RegExp(entry.slice(1, -1)).test(host);
    } catch {
      return false;
    }
  }
  if (entry.endsWith('.*')) {
    // entity: example.* matches example.<any public suffix>
    const base = entry.slice(0, -2);
    const reg = registrableDomain(host);
    const label = reg.split('.')[0];
    return host === base + reg.slice(label!.length) || host.endsWith('.' + base + reg.slice(label!.length)) || reg.startsWith(base + '.');
  }
  return host === entry || host.endsWith('.' + entry);
}

function parseDomainList(v: string): DomainList {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of v.split('|')) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.startsWith('~')) exclude.push(d.slice(1));
    else include.push(d);
  }
  return { include, exclude };
}

function domainListMatches(list: DomainList, host: string): boolean {
  if (list.exclude.some((e) => hostMatchesEntry(host, e))) return false;
  if (!list.include.length) return true;
  return list.include.some((e) => hostMatchesEntry(host, e));
}

const SEPARATOR = '(?:[^\\w\\-.%]|$)';
function patternToRegExp(pattern: string, matchCase: boolean): { re: RegExp | null; hostAnchor: boolean } {
  let p = pattern;
  let hostAnchor = false;
  let left = false;
  let right = false;
  if (p.startsWith('||')) {
    hostAnchor = true;
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    left = true;
    p = p.slice(1);
  }
  if (p.endsWith('|') && !p.endsWith('\\|')) {
    right = true;
    p = p.slice(0, -1);
  }
  // uBO: a trailing * is redundant; a leading * too
  if (!p || p === '*') return { re: null, hostAnchor };
  let src = '';
  for (const ch of p) {
    if (ch === '*') src += '.*';
    else if (ch === '^') src += SEPARATOR;
    else src += ch.replace(/[.+?${}()[\]\\|/]/g, '\\$&');
  }
  if (hostAnchor) src = '^[a-z][a-z0-9+.-]*:\\/+(?:[^\\/?#]*\\.)?' + src;
  else if (left) src = '^' + src;
  if (right) src += '$';
  return { re: new RegExp(src, matchCase ? '' : 'i'), hostAnchor };
}

function tokensOf(pattern: string, hostAnchor: boolean): string[] {
  // A token is usable only when it is bounded by literal non-token characters (or an anchor):
  // then it must appear as a whole token in any URL the pattern matches.
  const out: string[] = [];
  const p = pattern.replace(/^\|\|?/, '').replace(/\|$/, '');
  const re = /[a-z0-9%]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    const before = m.index === 0 ? (hostAnchor || pattern.startsWith('|') ? '|' : '') : p[m.index - 1];
    const after = m.index + m[0].length >= p.length ? (pattern.endsWith('|') ? '|' : '') : p[m.index + m[0].length];
    if (!before || before === '*' || !after || after === '*') continue;
    if (m[0].length >= 2) out.push(m[0].toLowerCase());
  }
  return out;
}

function splitOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inRe = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!inRe && c === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    if (c === '/' && (cur.endsWith('=') || cur.endsWith('=~'))) inRe = true;
    else if (c === '/' && inRe && s[i - 1] !== '\\') inRe = false;
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const OPTION_NAME = /^~?([a-z0-9_-]+)(=|,|$)/i;
function findOptionsStart(line: string): number {
  // Regex filter (/re/ or /re/$options): options start right after the closing slash. A line that
  // merely STARTS with "/" (a path filter such as /analytics/analytics.$~xmlhttprequest,3p) is not a
  // regex filter and falls through to the plain search, so it keeps its options.
  if (line.startsWith('/') && line.length > 2) {
    if (line.endsWith('/')) return -1;
    for (let i = line.length - 1; i > 1; i--) {
      if (line[i] === '$' && line[i - 1] === '/') {
        const rest = line.slice(i + 1);
        const first = OPTION_NAME.exec(rest);
        if (first) return i;
      }
    }
  }
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '$') continue;
    const rest = line.slice(i + 1);
    const first = OPTION_NAME.exec(rest);
    if (first) return i;
  }
  return -1;
}

/** Option-name aliases, so $badfilter matches regardless of spelling (3p / third-party, from / domain, ...). */
const OPTION_ALIASES: Record<string, string> = {
  '3p': 'third-party', '1p': 'first-party', from: 'domain', xhr: 'xmlhttprequest', css: 'stylesheet', frame: 'subdocument', doc: 'document', img: 'image', beacon: 'ping',
  ghide: 'generichide', ehide: 'elemhide', shide: 'specifichide', 'object-subrequest': 'object',
};

/** Pattern + normalised, sorted options (without badfilter): the identity $badfilter disables. */
export function canonicalFilterKey(raw: string): string {
  let line = raw.trim();
  let prefix = '';
  if (line.startsWith('@@')) {
    prefix = '@@';
    line = line.slice(2);
  }
  const at = findOptionsStart(line);
  const pattern = at >= 0 ? line.slice(0, at) : line;
  const opts = (at >= 0 ? splitOptions(line.slice(at + 1)) : [])
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      const neg = o.startsWith('~') ? '~' : '';
      const body = neg ? o.slice(1) : o;
      const eq = body.indexOf('=');
      const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
      const canon = OPTION_ALIASES[name] ?? name;
      if (canon === 'badfilter') return '';
      const value = eq >= 0 ? body.slice(eq + 1) : null;
      const v = value === null ? '' : canon === 'domain' || canon === 'to' || canon === 'denyallow' || canon === 'method' ? '=' + value.split('|').map((x) => x.trim().toLowerCase()).sort().join('|') : '=' + value;
      return neg + canon + v;
    })
    .filter(Boolean)
    .sort();
  return prefix + pattern + (opts.length ? '$' + opts.join(',') : '');
}

// ---------------------------------------------------------------------------- parsing
export function parseFilter(lineIn: string): NetworkFilter | null {
  let line = lineIn.trim();
  if (!line || line.startsWith('!') || line.startsWith('[')) return null;
  if (/#[@?$%]*#|#\+js|##\^/.test(line) && !line.startsWith('/')) return null; // cosmetic / scriptlet / html
  const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)$/i.exec(line);
  if (hosts) line = `||${hosts[1]}^`;
  let exception = false;
  if (line.startsWith('@@')) {
    exception = true;
    line = line.slice(2);
  }
  const optAt = findOptionsStart(line);
  const pattern = optAt >= 0 ? line.slice(0, optAt) : line;
  const optText = optAt >= 0 ? line.slice(optAt + 1) : '';
  const f: NetworkFilter = {
    raw: lineIn.trim(), exception, important: false, badfilter: false, re: null, indexHost: null, tokens: [], types: null, notTypes: new Set(), party: null, strictParty: false,
    domains: null, to: null, denyallow: null, methods: null, redirect: false, removeparam: null, pureHostname: false,
  };
  let matchCase = false;
  for (const optRaw of optText ? splitOptions(optText) : []) {
    const opt = optRaw.trim();
    if (!opt) continue;
    const neg = opt.startsWith('~');
    const body = neg ? opt.slice(1) : opt;
    const eq = body.indexOf('=');
    const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
    const value = eq >= 0 ? body.slice(eq + 1) : '';
    if (IGNORED_FILTER_OPTIONS.has(name)) return null;
    const t = TYPE_ALIASES[name];
    if (t) {
      if (t === 'all') {
        if (!neg) f.types = new Set(['document', 'subdocument', 'script', 'image', 'stylesheet', 'xmlhttprequest', 'ping', 'font', 'media', 'websocket', 'other', 'object', 'popup']);
        continue;
      }
      if (neg) f.notTypes.add(t);
      else (f.types ??= new Set()).add(t);
      continue;
    }
    switch (name) {
      case 'third-party':
      case '3p':
        f.party = neg ? '1p' : '3p';
        break;
      case 'first-party':
      case '1p':
        f.party = neg ? '3p' : '1p';
        break;
      case 'strict1p':
        f.party = '1p';
        f.strictParty = true;
        break;
      case 'strict3p':
        f.party = '3p';
        f.strictParty = true;
        break;
      case 'domain':
      case 'from':
        f.domains = parseDomainList(value);
        break;
      case 'to':
        f.to = parseDomainList(value);
        break;
      case 'denyallow':
        f.denyallow = value.split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
        break;
      case 'method':
        f.methods = parseDomainList(value.toLowerCase());
        break;
      case 'important':
        f.important = true;
        break;
      case 'badfilter':
        f.badfilter = true;
        break;
      case 'match-case':
        matchCase = true;
        break;
      case 'redirect':
        f.redirect = true;
        break;
      case 'removeparam':
      case 'queryprune': {
        if (!value) f.removeparam = { all: true, negate: false };
        else {
          const negate = value.startsWith('~');
          const v = negate ? value.slice(1) : value;
          const rm = /^\/(.*)\/([a-z]*)$/.exec(v);
          if (rm) {
            try {
              f.removeparam = { all: false, negate, re: new RegExp(rm[1]!, rm[2]!.replace(/[^imsu]/g, '')) };
            } catch {
              return null;
            }
          } else f.removeparam = { all: false, negate, name: v };
        }
        break;
      }
      default:
        if (NEUTRAL_OPTIONS.has(name)) break;
        return null; // unknown option: uBO would reject the filter
    }
  }
  // pattern
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    try {
      f.re = new RegExp(pattern.slice(1, -1), matchCase ? '' : 'i');
    } catch {
      return null;
    }
    return f;
  }
  let pat = pattern;
  if (!optText && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(pat) && !exception) {
    // uBO treats a pure hostname line as ||hostname^
    pat = `||${pat}^`;
    f.pureHostname = true;
  }
  const { re, hostAnchor } = patternToRegExp(pat, matchCase);
  f.re = re;
  if (hostAnchor) {
    // Index by host only when a WHOLE hostname is anchored (followed by ^ / : | or the end). A partial
    // label (||google.*/..., ||ads*.x.com^, ||discord-nitro.) would sit under a key no request host
    // ever produces; such filters go to the token index instead.
    const m = /^\|\|([a-z0-9.-]+)(?=[\^/:|]|$)/i.exec(pat);
    if (m && !/[.-]$/.test(m[1]!) && !m[1]!.startsWith('.')) f.indexHost = m[1]!.toLowerCase();
    if (/^\|\|[a-z0-9.-]+\^?\|?$/i.test(pat)) f.pureHostname = true;
  }
  if (!f.indexHost && re) f.tokens = tokensOf(pat, hostAnchor);
  return f;
}

// ---------------------------------------------------------------------------- preprocessor
const UBO_ENV: Record<string, boolean> = {
  env_chromium: true, env_firefox: false, env_safari: false, env_mobile: false, env_edge: false, env_legacy: false, env_mv3: false,
  ext_ubol: false, cap_html_filtering: false, cap_user_stylesheet: true, cap_ipaddress: false, adguard: false, adguard_app_windows: false, adguard_ext_chromium: false, false: false, true: true,
};
function evalCondition(expr: string): boolean {
  // supports !, &&, || and parentheses over the tokens above
  const tokens = expr.match(/!|\(|\)|&&|\|\||[a-z_0-9]+/gi) || [];
  let i = 0;
  const parseOr = (): boolean => {
    let v = parseAnd();
    while (tokens[i] === '||') {
      i++;
      v = parseAnd() || v;
    }
    return v;
  };
  const parseAnd = (): boolean => {
    let v = parseNot();
    while (tokens[i] === '&&') {
      i++;
      v = parseNot() && v;
    }
    return v;
  };
  const parseNot = (): boolean => {
    if (tokens[i] === '!') {
      i++;
      return !parseNot();
    }
    if (tokens[i] === '(') {
      i++;
      const v = parseOr();
      i++;
      return v;
    }
    const t = tokens[i++] || 'false';
    return UBO_ENV[t] ?? false;
  };
  return parseOr();
}

export function preprocess(text: string): string[] {
  const out: string[] = [];
  const stack: boolean[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('!#if ')) {
      stack.push(evalCondition(t.slice(5)));
      continue;
    }
    if (t === '!#else') {
      if (stack.length) stack[stack.length - 1] = !stack[stack.length - 1];
      continue;
    }
    if (t === '!#endif') {
      stack.pop();
      continue;
    }
    if (stack.every(Boolean)) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------- engine
export const UBO_DEFAULT_LISTS = ['ubo_filters_all.txt', 'ubo_badware.txt', 'ubo_privacy.txt', 'ubo_resource_abuse.txt', 'ubo_quick_fixes.txt', 'ubo_unbreak.txt', 'easylist.txt', 'easyprivacy.txt', 'peterlowe.txt'];

export class UboEngine {
  private byHost = new Map<string, NetworkFilter[]>();
  private byToken = new Map<string, NetworkFilter[]>();
  private generic: NetworkFilter[] = [];
  private removeparams: NetworkFilter[] = [];
  readonly stats = { lines: 0, network: 0, skipped: 0, badfiltered: 0, removeparam: 0 };

  static fromDirectory(dir: string, lists = UBO_DEFAULT_LISTS): UboEngine {
    return new UboEngine(lists.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  constructor(texts: string[]) {
    const filters: NetworkFilter[] = [];
    const bad = new Set<string>();
    for (const text of texts) {
      for (const line of preprocess(text)) {
        this.stats.lines++;
        const f = parseFilter(line);
        if (!f) {
          this.stats.skipped++;
          continue;
        }
        if (f.badfilter) {
          bad.add(canonicalFilterKey(f.raw));
          continue;
        }
        filters.push(f);
      }
    }
    for (const f of filters) {
      if (bad.size && bad.has(canonicalFilterKey(f.raw))) {
        this.stats.badfiltered++;
        continue;
      }
      this.stats.network++;
      if (f.removeparam) {
        this.stats.removeparam++;
        this.removeparams.push(f);
        continue;
      }
      if (f.indexHost) push(this.byHost, f.indexHost, f);
      else if (f.tokens.length) push(this.byToken, f.tokens.reduce((a, b) => (b.length > a.length ? b : a)), f);
      else this.generic.push(f);
    }
  }

  private candidates(url: string, host: string): NetworkFilter[] {
    const out: NetworkFilter[] = [];
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      const h = labels.slice(i).join('.');
      const l = this.byHost.get(h);
      if (l) out.push(...l);
    }
    const seen = new Set<string>();
    for (const tok of url.toLowerCase().match(/[a-z0-9%]+/g) || []) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const l = this.byToken.get(tok);
      if (l) out.push(...l);
    }
    out.push(...this.generic);
    return out;
  }

  private applies(f: NetworkFilter, req: UboRequest, u: URL, src: URL): boolean {
    const t = req.type;
    if (f.types) {
      if (!f.types.has(t)) return false;
    } else if (t === 'document' && !f.pureHostname) return false; // default types exclude the main frame
    else if (t === 'popup') return false;
    if (f.notTypes.has(t)) return false;
    if (f.party) {
      const same = f.strictParty ? u.hostname === src.hostname : registrableDomain(u.hostname) === registrableDomain(src.hostname);
      if (f.party === '3p' && same) return false;
      if (f.party === '1p' && !same) return false;
    }
    if (f.domains && !domainListMatches(f.domains, src.hostname)) return false;
    if (f.to && !domainListMatches(f.to, u.hostname)) return false;
    if (f.denyallow && f.denyallow.some((d) => hostMatchesEntry(u.hostname, d))) return false;
    if (f.methods && !domainListMatches(f.methods, (req.method || 'GET').toLowerCase())) return false;
    return f.re ? f.re.test(req.url) : true;
  }

  match(req: UboRequest): MatchResult {
    let u: URL;
    let src: URL;
    try {
      u = new URL(req.url);
      src = new URL(req.sourceUrl);
    } catch {
      return { blocked: false };
    }
    let block: NetworkFilter | undefined;
    let important: NetworkFilter | undefined;
    let exception: NetworkFilter | undefined;
    for (const f of this.candidates(req.url, u.hostname)) {
      if (f.exception ? exception : f.important ? important : block) continue;
      if (!this.applies(f, req, u, src)) continue;
      if (f.exception) exception = f;
      else if (f.important) important = f;
      else block = f;
    }
    if (important) return { blocked: true, filter: important.raw };
    if (block && !exception) return { blocked: true, filter: block.raw };
    return { blocked: false, exception: block && exception ? exception.raw : undefined, filter: block?.raw };
  }

  /** $removeparam on a navigation URL (uBO strips these before the request is sent). */
  removeParams(url: string, sourceUrl: string, type: UboType = 'document'): { url: string; removed: string[]; filters: string[] } {
    let u: URL;
    let src: URL;
    try {
      u = new URL(url);
      src = new URL(sourceUrl);
    } catch {
      return { url, removed: [], filters: [] };
    }
    if (!u.search) return { url, removed: [], filters: [] };
    const req: UboRequest = { url, type, sourceUrl };
    const rules = this.removeparams.filter((f) => this.applies({ ...f, types: f.types ?? new Set<UboType>(['document', 'subdocument']) }, req, u, src));
    const block = rules.filter((f) => !f.exception);
    const allow = rules.filter((f) => f.exception);
    if (allow.some((f) => f.removeparam!.all)) return { url, removed: [], filters: [] };
    const hits = (f: NetworkFilter, name: string, value: string) => {
      const r = f.removeparam!;
      if (r.all) return true;
      const m = r.name !== undefined ? name === r.name : r.re!.test(`${name}=${value}`);
      return r.negate ? !m : m;
    };
    const removed: string[] = [];
    const used = new Set<string>();
    const kept = new URLSearchParams();
    for (const [name, value] of u.searchParams) {
      const by = block.find((f) => hits(f, name, value));
      const spared = allow.some((f) => hits(f, name, value));
      if (by && !spared) {
        removed.push(name);
        used.add(by.raw);
      } else kept.append(name, value);
    }
    if (!removed.length) return { url, removed: [], filters: [] };
    const q = kept.toString();
    return { url: `${u.origin}${u.pathname}${q ? '?' + q : ''}${u.hash}`, removed, filters: [...used] };
  }
}

function push(m: Map<string, NetworkFilter[]>, k: string, f: NetworkFilter) {
  const l = m.get(k);
  if (l) l.push(f);
  else m.set(k, [f]);
}

/** CDP Network.ResourceType -> uBO request type. */
export function uboTypeOf(cdpType: string, isMainFrame: boolean): UboType {
  switch (cdpType) {
    case 'Document':
      return isMainFrame ? 'document' : 'subdocument';
    case 'Script':
      return 'script';
    case 'Stylesheet':
      return 'stylesheet';
    case 'Image':
      return 'image';
    case 'Font':
      return 'font';
    case 'Media':
      return 'media';
    case 'XHR':
    case 'Fetch':
      return 'xmlhttprequest';
    case 'Ping':
      return 'ping';
    case 'WebSocket':
      return 'websocket';
    default:
      return 'other';
  }
}
