/**
 * Minimal RFC 6265-style cookie jar for tests.
 *
 * Why not happy-dom's own jar: happy-dom 20 rejects `Domain=.openart.ai` on the host
 * `openart.ai` (browsers strip the leading dot and accept it), so assertions about the
 * exact attributes OpenArt's code writes need a jar that behaves like a browser and
 * records the raw attributes.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Normalised domain without the leading dot, or null for host-only cookies. */
  domain: string | null;
  path: string;
  maxAge: number | null;
  sameSite: string | null;
  secure: boolean;
  /** The exact string assigned to document.cookie. */
  raw: string;
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  readonly writes: string[] = [];

  constructor(
    private host: string,
    private https = true,
  ) {}

  setHost(host: string, https = true): void {
    this.host = host;
    this.https = https;
  }

  private domainMatches(domain: string): boolean {
    return this.host === domain || this.host.endsWith('.' + domain);
  }

  set(raw: string): void {
    this.writes.push(raw);
    const [pair, ...attrs] = raw.split(';');
    if (!pair) return;
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain: string | null = null;
    let path = '/';
    let maxAge: number | null = null;
    let sameSite: string | null = null;
    let secure = false;
    for (const attr of attrs) {
      const [k, ...rest] = attr.trim().split('=');
      const key = (k ?? '').toLowerCase();
      const v = rest.join('=').trim();
      if (key === 'domain') domain = v.replace(/^\./, '').toLowerCase();
      else if (key === 'path') path = v || '/';
      else if (key === 'max-age') maxAge = Number(v);
      else if (key === 'samesite') sameSite = v;
      else if (key === 'secure') secure = true;
    }
    if (domain !== null && !this.domainMatches(domain)) return; // browser rejects foreign domains
    if (secure && !this.https) return;
    const id = `${name}|${domain ?? `host:${this.host}`}|${path}`;
    if (maxAge !== null && maxAge <= 0) {
      this.cookies.delete(id);
      return;
    }
    this.cookies.set(id, { name, value, domain, path, maxAge, sameSite, secure, raw });
  }

  private visible(): StoredCookie[] {
    return [...this.cookies.values()].filter((c) => {
      if (c.secure && !this.https) return false;
      if (c.domain === null) return true; // host-only cookies are only kept for the host that set them in these tests
      return this.domainMatches(c.domain);
    });
  }

  get(): string {
    return this.visible()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  find(name: string): StoredCookie | undefined {
    return this.visible().find((c) => c.name === name);
  }

  names(): string[] {
    return this.visible().map((c) => c.name);
  }

  /** Seed a cookie as if a server or earlier page had set it. */
  seed(name: string, value: string, domain = 'openart.ai'): void {
    this.set(`${name}=${value}; path=/; domain=.${domain}`);
    this.writes.pop();
  }
}
