import { describe, expect, it } from "vitest";
import { isBotUserAgent } from "../../src/core/classify.js";
import { UA } from "../fixtures/helpers.js";
import { run } from "./run.js";

const LANDING = "https://openart.ai/?gclid=G1&utm_source=google";

describe("document navigations only", () => {
  it("processes a GET top-level navigation (Sec-Fetch-Dest: document)", async () => {
    const r = await run(LANDING);
    expect(r.skipped).toBeNull();
    expect(r.setCookies.length).toBeGreaterThan(0);
  });

  it("falls back to Accept: text/html when Sec-Fetch-* is absent (older Safari)", async () => {
    const r = await run(LANDING, {
      ua: UA.iphoneSafari,
      headers: {
        "sec-fetch-dest": "",
        "sec-fetch-mode": "",
        "sec-fetch-site": "",
        "sec-fetch-user": "",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(r.skipped).toBeNull();
  });

  it("skips non-GET methods", async () => {
    for (const method of ["POST", "HEAD", "PUT", "OPTIONS"]) {
      expect((await run(LANDING, { method })).skipped, method).toBe("method");
    }
  });

  it("skips subresources, iframes, fetch/XHR and service-worker requests", async () => {
    for (const dest of ["image", "script", "style", "iframe", "empty", "font", "serviceworker", "worker", "manifest"]) {
      const r = await run(LANDING, { headers: { "sec-fetch-dest": dest } });
      expect(r.skipped, dest).toBe("not-document");
      expect(r.setCookies).toEqual([]);
    }
  });

  it("skips requests without Sec-Fetch-Dest whose Accept is not HTML", async () => {
    const r = await run(LANDING, { headers: { "sec-fetch-dest": "", accept: "application/json" } });
    expect(r.skipped).toBe("not-document");
  });
});

describe("prefetch and prerender", () => {
  it.each([
    ["sec-purpose", "prefetch"],
    ["sec-purpose", "prefetch;prerender"],
    ["purpose", "prefetch"],
    ["x-purpose", "preview"],
    ["x-moz", "prefetch"],
  ])("skips %s: %s", async (header, value) => {
    const r = await run(LANDING, { headers: { [header]: value } });
    expect(r.skipped).toBe("prefetch");
  });
});

describe("bots", () => {
  const bots = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "AdsBot-Google (+http://www.google.com/adsbot.html)",
    "Mozilla/5.0 (Linux; Android 5.0; SM-G920A) AppleWebKit (KHTML, like Gecko) Chrome Mobile Safari (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)",
    "Mediapartners-Google",
    "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Twitterbot/1.0",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "TelegramBot (like TwitterBot)",
    "WhatsApp/2.23.20.0 A",
    "Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    "Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
    "curl/8.7.1",
    "python-requests/2.32.3",
    "Go-http-client/2.0",
    "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "",
  ];

  it.each(bots)("detects %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it("stays linear on adversarial user agents (no ReDoS on 16 KB headers)", () => {
    const hostile = [
      `Mozilla/5.0 (compatible;${" ".repeat(16_000)})`,
      `bot${"+".repeat(16_000)}`,
      `x${"bot ".repeat(4_000)}`,
      `compatible;${"a;".repeat(8_000)}`,
    ];
    for (const ua of hostile) {
      const started = performance.now();
      isBotUserAgent(ua);
      expect(performance.now() - started, ua.slice(0, 20)).toBeLessThan(50);
    }
  });

  it("does not flag real browsers, in-app webviews or phones whose model name contains 'bot'", () => {
    for (const ua of Object.values(UA)) expect(isBotUserAgent(ua), ua).toBe(false);
  });

  it("skips bot requests end to end, including AdsBot checking a gclid landing", async () => {
    const r = await run(LANDING, { ua: "AdsBot-Google (+http://www.google.com/adsbot.html)" });
    expect(r.skipped).toBe("bot");
    expect(r.setCookies).toEqual([]);
  });

  it("uses Cloudflare Bot Management when present (verified bots and score 1)", async () => {
    expect((await run(LANDING, { cf: { country: "US", botManagement: { verifiedBot: true, score: 90 } } })).skipped).toBe("bot");
    expect((await run(LANDING, { cf: { country: "US", botManagement: { verifiedBot: false, score: 1 } } })).skipped).toBe("bot");
    expect((await run(LANDING, { cf: { country: "US", botManagement: { verifiedBot: false, score: 45 } } })).skipped).toBeNull();
  });

  it("accepts a custom bot detector", async () => {
    const r = await run(LANDING, { options: { isBot: () => true } });
    expect(r.skipped).toBe("bot");
  });
});

describe("assets and non-page paths", () => {
  it.each([
    "/_next/static/chunks/main.js",
    "/suite/_next/static/chunks/91db8069961c7577.js",
    "/_astro/index.BHx.css",
    "/4vu8/",
    "/4vu8/C_mYUAFo",
    "/cdn-cgi/rum",
    "/api/user/ad-click-ids",
    "/legacy/api/tracking/impact/store-clickid",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
    "/images/hero.webp",
    "/fonts/inter.woff2",
    "/manifest.webmanifest",
    "/video/demo.mp4",
  ])("skips %s", async (path) => {
    const r = await run(`https://openart.ai${path}?gclid=G1`);
    expect(r.skipped).toBe("asset");
  });

  it("processes page paths, including .html and paths with dots in directory names", async () => {
    for (const path of ["/", "/home", "/pricing", "/ai-model/seedance-2-0/", "/blog/what-is-openart/", "/docs/v1.2/intro", "/page.html"]) {
      expect((await run(`https://openart.ai${path}?gclid=G1`)).skipped, path).toBeNull();
    }
  });

  it("supports extra skip prefixes and a host allow-list", async () => {
    expect((await run("https://openart.ai/admin/x?gclid=G1", { options: { skipPathPrefixes: ["/admin/"] } })).skipped).toBe("asset");
    expect((await run("https://other.example/?gclid=G1", { options: { hosts: ["openart.ai", ".openart.ai"] } })).skipped).toBe("host");
    expect((await run("https://www.openart.ai/?gclid=G1", { options: { hosts: ["openart.ai", ".openart.ai"] } })).skipped).toBeNull();
  });
});
