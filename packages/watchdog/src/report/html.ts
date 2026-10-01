// report.html: a self-contained page rendered from results.json (no network, no external assets, no
// script: a Content-Security-Policy of default-src 'none' means even a crafted results.json fed to
// `cli.ts report` cannot execute anything; every value is escaped, numbers are coerced, links are
// relative paths only).
import type { Results } from '../run.js';
import { PLATFORM_LABEL, type CheckStatus, type Platform } from '../types.js';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const plabel = (p: string) => PLATFORM_LABEL[p as Platform] ?? p;
/** Numbers from results.json are coerced (a string smuggled into a numeric field renders as —). */
const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—');
/** Only plain relative paths become links (no scheme, so no javascript:/data: URLs). */
const href = (v: unknown): string => {
  const x = String(v ?? '');
  return /^(?![a-z][a-z0-9+.-]*:)[A-Za-z0-9_.\/#-]+$/i.test(x) && !x.startsWith('//') ? esc(x) : '#';
};
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const pill = (s: CheckStatus | string) => `<span class="pill ${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
const pct = (n: number | null) => (n === null ? '<span class="muted">n/a</span>' : `${num(n)}%`);
const bar = (n: number | null) => (typeof n !== 'number' || !Number.isFinite(n) ? '' : `<span class="bar"><span style="width:${Math.max(0, Math.min(100, n))}%"></span></span>`);

const CSS = `
:root{--bg:#ffffff;--fg:#1d2330;--muted:#667085;--line:#e4e7ec;--card:#f8f9fb;--pass:#067647;--pass-bg:#dcfae6;--fail:#b42318;--fail-bg:#fee4e2;--warn:#b54708;--warn-bg:#fef0c7;--skip:#475467;--skip-bg:#eaecf0;--accent:#3538cd;--code:#f2f4f7}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0f1115;--fg:#e6e8ec;--muted:#98a2b3;--line:#262b36;--card:#161a22;--pass:#47cd89;--pass-bg:#053321;--fail:#f97066;--fail-bg:#3e1411;--warn:#fdb022;--warn-bg:#3d2a07;--skip:#98a2b3;--skip-bg:#232833;--accent:#8098f9;--code:#1b2029}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:40px 0 10px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:15px;margin:22px 0 8px}
.muted{color:var(--muted)}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}code{background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:18px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card .k{font-size:12px;color:var(--muted)}.card .v{font-size:20px;font-weight:600;margin-top:2px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{background:var(--card);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:none}
.pill{display:inline-block;font-weight:700;font-size:11px;letter-spacing:.03em;padding:2px 8px;border-radius:999px;white-space:nowrap}.pill.pass,.pill.proven,.pill.ok{color:var(--pass);background:var(--pass-bg)}.pill.fail,.pill.failed,.pill.changed{color:var(--fail);background:var(--fail-bg)}.pill.error{color:var(--warn);background:var(--warn-bg)}.pill.unavailable{color:var(--warn);background:var(--warn-bg)}.pill.skip,.pill.unchanged{color:var(--skip);background:var(--skip-bg)}
tr.row-pass td:first-child{box-shadow:inset 4px 0 var(--pass)}tr.row-fail td:first-child{box-shadow:inset 4px 0 var(--fail)}tr.row-error td:first-child{box-shadow:inset 4px 0 var(--warn)}tr.row-skip td:first-child{box-shadow:inset 4px 0 var(--skip)}
details{margin-top:4px}summary{cursor:pointer;color:var(--accent)}ul.ev{margin:6px 0 0;padding-left:18px}ul.ev li{margin:2px 0}
.bar{display:inline-block;width:90px;height:8px;background:var(--skip-bg);border-radius:4px;vertical-align:middle;margin-left:8px;overflow:hidden}.bar span{display:block;height:100%;background:var(--accent)}
.sym-ok{color:var(--pass);font-weight:700}.sym-bad{color:var(--fail);font-weight:700}.sym-mid{color:var(--warn);font-weight:700}
a{color:var(--accent)}.small{font-size:12px}.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0}
`;

function checksTable(r: Results): string {
  const rows = r.checks
    .map(
      (c) => `<tr class="row-${esc(c.status.toLowerCase())}" id="check-${esc(c.id)}"><td>${pill(c.status)}</td><td><strong>${esc(c.title)}</strong><div class="muted small mono">${esc(c.id)}${c.claim ? ' · ' + esc(c.claim) : ''}${c.confidence === 'inferred' ? ' · inferred' : ''}</div></td><td>${esc(c.platform ? plabel(String(c.platform)) : '')}</td><td>${esc(c.expected)}</td><td>${esc(c.observed)}${
        c.evidence.length
          ? `<details><summary>evidence (${c.evidence.length})</summary><ul class="ev">${c.evidence.map((e) => `<li><strong>${esc(e.label)}:</strong> ${esc(e.detail)}${e.ref ? ` <code>${esc(e.ref)}</code>` : ''}</li>`).join('')}</ul></details>`
          : ''
      }</td></tr>`,
    )
    .join('');
  return `<div class="tablewrap"><table><thead><tr><th>Status</th><th>Check</th><th>Platform</th><th>Target behaviour</th><th>Observed</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function coverageSection(r: Results): string {
  const rows = r.coverage
    .map(
      (c) => `<tr><td><strong>${esc(plabel(c.platform))}</strong></td><td>${pct(c.standard.pct)} <span class="muted">(${num(c.standard.covered)}/${num(c.standard.total)})</span>${bar(c.standard.pct)}</td><td>${c.standard.total ? `${num(c.standard.stored)}/${num(c.standard.total)}` : '<span class="muted">n/a</span>'}</td><td>${pct(c.blocker.pct)} <span class="muted">(${num(c.blocker.covered)}/${num(c.blocker.total)})</span></td><td>${pct(c.all.pct)} <span class="muted">(${num(c.all.covered)}/${num(c.all.total)})</span></td></tr>`,
    )
    .join('');
  const journeys = r.journeys.filter((j) => j.perPlatform.some((p) => p.relevant));
  const platforms = r.coverage.map((c) => c.platform);
  const sym = (p: any) => (!p || !p.relevant ? '<span class="muted">—</span>' : p.sentOnFinalPage ? '<span class="sym-ok" title="click id reached the platform\'s attribution field on an app-page hit">●</span>' : p.stored.any ? '<span class="sym-mid" title="stored first-party but not sent on app-page hits">◐</span>' : '<span class="sym-bad" title="lost">✗</span>');
  const matrix = journeys
    .map((j) => `<tr><td><a href="#journey-${esc(j.id)}">${esc(j.id)}</a></td>${platforms.map((p) => `<td>${sym(j.perPlatform.find((x) => x.platform === p))}</td>`).join('')}</tr>`)
    .join('');
  return `<p class="muted">Of the journeys whose ad URL carried the platform's click ID, the share where the ID reached the platform's <em>dedicated attribution field</em> (gclaw/gclid/gbraid, fbc, context.ad.callback, click_id, li_fat_id, twclid, msclkid, oppref) on a hit fired from the app page — where signup and purchase later fire. Appearing only inside a page-URL field does not count. uBlock-simulated journeys are the blocker cohort.</p>
  <div class="tablewrap"><table><thead><tr><th>Platform</th><th>Coverage (standard browsers)</th><th>Stored first-party</th><th>With uBlock Origin defaults</th><th>All journeys</th></tr></thead><tbody>${rows}</tbody></table></div>
  <h3>Journey × platform</h3><p class="small muted"><span class="sym-ok">●</span> sent on app-page hits · <span class="sym-mid">◐</span> stored first-party only · <span class="sym-bad">✗</span> lost · — not in this journey's ad URL</p>
  <div class="tablewrap"><table><thead><tr><th>Journey</th>${platforms.map((p) => `<th>${esc(plabel(p))}</th>`).join('')}</tr></thead><tbody>${matrix}</tbody></table></div>`;
}

function pageViewSection(r: Results): string {
  const j = r.journeys.find((x) => x.pageViews);
  if (!j || !j.pageViews) return '<p class="muted">SPA journey not run.</p>';
  const pv = j.pageViews;
  const platforms = Object.keys(pv.hardLoad ?? pv.routes[0]?.counts ?? {});
  const cell = (c: any) => (c ? `${num(c.total)}${Object.keys(c.streams).length > 1 ? ` <span class="muted small">(${Object.entries(c.streams).map(([s, n]) => `${esc(s)}: ${num(n)}`).join(', ')})</span>` : ''}` : '—');
  const head = `<tr><th>Platform</th><th>Hard load</th>${pv.routes.map((rc) => `<th>${esc(rc.step)} → <span class="mono">${esc(safePath(rc.to))}</span>${rc.ok ? '' : ' <span class="pill error">not soft</span>'}</th>`).join('')}</tr>`;
  const body = platforms.map((p) => `<tr><td>${esc(plabel(p))}</td><td>${cell(pv.hardLoad?.[p])}</td>${pv.routes.map((rc) => { const c = rc.counts[p]; const bad = c && c.total !== 1 && p !== 'amplitude'; return `<td class="${bad ? 'sym-bad' : ''}">${cell(c)}</td>`; }).join('')}</tr>`).join('');
  return `<p class="muted">Distinct page-view events per user route change after collapsing transport copies (X t.co/analytics pair, Meta /tr + CAPI Gateway with one eid, Google fan-out). Target: exactly 1. History events per route: ${pv.routes.map((rc) => `${esc(rc.step)} [${esc(rc.historyEvents.join(' '))}]`).join('; ')}</p><div class="tablewrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function safePath(u: string) {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

function consentSection(r: Results): string {
  const m = r.consent.mapping;
  const letters = Object.entries(m).map(([l, v]) => `<tr><td class="mono">${esc(l)}</td><td>${esc(v.default)}</td><td>${esc(v.update)}</td></tr>`).join('');
  const obs = r.consent.observed
    .map((o) => {
      const d: any = o.decoded;
      const dec = d ? r.consent.order.map((s) => `${esc(s)}=<span class="mono">${esc(d[s]?.letter)}</span> (${esc(d[s]?.default)}${d[s]?.update && d[s].update !== 'none' ? ', update ' + esc(d[s].update) : ''})`).join('<br>') : '<span class="muted">—</span>';
      return `<tr><td>${esc(o.scope)}</td><td>${num(o.hits)}</td><td class="mono">${Object.entries(o.gcd).map(([k, v]) => `${esc(k)} ×${num(v)}`).join('<br>') || '—'}</td><td class="mono">${Object.entries(o.gcs).map(([k, v]) => `${esc(k)} ×${num(v)}`).join('<br>') || '—'}</td><td>${dec}</td><td>${num(o.consentCommands)}</td></tr>`;
    })
    .join('');
  return `<p class="muted">Decoded from the <code>gcd</code> / <code>gcs</code> parameters of every attempted Google hit (failed locally). Letter mapping: ${esc(r.consent.source.primary)}; corroborated by ${esc(r.consent.source.corroborating)} (checked ${esc(r.consent.source.checked)}). Signal order: ${esc(r.consent.order.join(', '))}. Consent probes (DE/GB/CH) rewrite, locally, only the visitor geo Google embeds in the served loaders: <code>blob["30"]/["31"]</code> and the region-matching geo <code>blob["22"]</code> (unpadded base64 JSON, fields "0" country and "1" region; other fields untouched). A probe is invalid (ERROR) if the tag fell back to fetching <code>www.google.com/ccm/geo</code> or no loader was rewritten; the mechanism is verified on Google's own tag code in <code>test/consent-geo.int.test.ts</code>.</p>
  <div class="tablewrap"><table><thead><tr><th>Scope</th><th>Google hits</th><th>gcd</th><th>gcs</th><th>Decoded (most common gcd)</th><th>consent cmds in dataLayer</th></tr></thead><tbody>${obs}</tbody></table></div>
  <details><summary>gcd letter mapping</summary><div class="tablewrap" style="margin-top:8px;max-width:420px"><table><thead><tr><th>Letter</th><th>Default</th><th>Update</th></tr></thead><tbody>${letters}</tbody></table></div></details>`;
}

function containerSection(r: Results): string {
  const c: any = r.container;
  if (c.error) return `<p>${pill('ERROR')} ${esc(c.error)}</p>`;
  const loaderRows = c.loaders.map((l: any) => `<tr><td>${esc(l.loader)}</td><td>${esc(l.snapshot.status)}</td><td>${esc(l.snapshot.containerId)} v${esc(l.snapshot.version)}</td><td class="mono">${esc((l.snapshot.resourceSha256 ?? '').slice(0, 16))}…</td><td>${l.matchesBaseline === null ? pill('ERROR') : l.matchesBaseline ? pill('UNCHANGED') : pill('CHANGED')}</td><td>${esc(l.summary.slice(0, 12).join(' · '))}</td></tr>`).join('');
  const g = c.gtagConfig;
  const gRow = g ? `<tr><td>${esc(g.loader)}</td><td>${esc(g.snapshot.status)}</td><td>${esc(g.snapshot.containerId)} v${esc(g.snapshot.version)}</td><td class="mono">${esc((g.snapshot.resourceSha256 ?? '').slice(0, 16))}…</td><td>${g.matchesBaseline === null ? pill('ERROR') : g.matchesBaseline ? pill('UNCHANGED') : pill('CHANGED')}</td><td>${esc(g.summary.slice(0, 12).join(' · '))} <span class="muted small">(baseline v${esc(g.baseline.version)})</span></td></tr>` : '';
  const diffDetail = c.loaders
    .filter((l: any) => l.diff && !l.diff.identical)
    .map((l: any) => `<h3>${esc(l.loader)} vs baseline</h3><ul class="ev">${l.summary.map((s: string) => `<li class="mono">${esc(s)}</li>`).join('')}</ul>`)
    .join('');
  const patched = c.patched ? `<h3>Patched container (${esc(c.patched.source)}) vs baseline</h3><p class="mono small">${esc(c.patched.resourceSha256)}</p><ul class="ev">${c.patched.summary.map((s: string) => `<li class="mono">${esc(s)}</li>`).join('')}</ul>` : '';
  const executed = (c.executed ?? []).map((e: any) => `<tr><td class="mono">${esc(e.url.split('?')[0])}</td><td>${esc(e.kind)}</td><td>${esc(e.version)}</td><td class="mono">${esc((e.resourceSha256Live ?? '').slice(0, 12))}</td><td class="mono">${esc((e.resourceSha256Served ?? '').slice(0, 12))}${e.resourceSha256Live !== e.resourceSha256Served ? ' <span class="pill changed">patched</span>' : ''}</td></tr>`).join('');
  return `<p>State ${pill(c.state ?? 'ERROR')}${(c.problems ?? []).length ? ' — ' + esc(c.problems.join('; ')) : ''}. Baseline <strong>${esc(c.baseline.containerId)} v${esc(c.baseline.version)}</strong> (captured ${esc(c.baseline.capturedAt)}), resource hash <code>${esc(c.baseline.resourceSha256)}</code> (SHA-256 of the canonical JSON of the embedded <code>resource</code> block; identical in gtm.js and /4vu8/). Loaders agree: ${c.loadersAgree === null ? 'n/a' : c.loadersAgree ? 'yes' : '<strong>NO</strong>'}.</p>
  <div class="tablewrap"><table><thead><tr><th>Loader</th><th>HTTP</th><th>Id / version</th><th>Resource hash</th><th>vs baseline</th><th>Changed tags / triggers / variables</th></tr></thead><tbody>${loaderRows}${gRow}</tbody></table></div>${diffDetail}${patched}
  ${executed ? `<h3>Executed in the browser runs</h3><div class="tablewrap"><table><thead><tr><th>Loader URL</th><th>Kind</th><th>Version</th><th>Live hash</th><th>Served hash</th></tr></thead><tbody>${executed}</tbody></table></div>` : ''}`;
}

function replaySection(r: Results): string {
  if (!r.replay) return '<p class="muted">Replay not run.</p>';
  const sc = r.replay.scenarios
    .map((s) => {
      const vendors = Object.entries(s.perVendor);
      const lines = vendors.length
        ? vendors
            .map(([v, hits]) => {
              const uniq = new Map<string, number>();
              for (const h of hits) {
                const f = h.fields as Record<string, unknown>;
                const key = `${h.kind}${h.event ? ' ' + h.event : ''}${f.label ? ' label=' + f.label : ''}${f.event_id !== undefined ? ' event_id=' + JSON.stringify(f.event_id) : ''}${f.conversionId ? ' conversionId=' + f.conversionId : ''}${f.val ? ' val=' + f.val : ''}${f.eventId ? ' eventId=' + f.eventId : ''}${f.conversion_id ? ' conversion_id=' + f.conversion_id : ''}${f.order_id ? ' order_id=' + f.order_id : ''}${f.ec_mode ? ' ec_mode=' + f.ec_mode : ''}`;
                uniq.set(key, (uniq.get(key) ?? 0) + 1);
              }
              const withData = hits.filter((h) => (h as { scenarioData?: boolean }).scenarioData).length;
              return `<li><strong>${esc(plabel(v))}</strong>${withData ? ` <span class="muted small">(${num(withData)} of ${num(hits.length)} carried this scenario's synthetic data; the rest is background SDK traffic in the same window)</span>` : ''}: ${[...uniq].map(([k, n]) => `<span class="mono">${esc(k)}</span>${n > 1 ? ` ×${num(n)}` : ''}`).join('; ')}</li>`;
            })
            .join('')
        : '<li class="muted">no request to any vendor</li>';
      return `<tr><td><strong>${esc(s.id)}</strong><div class="muted small">${esc(s.desc)}</div>${(s as { error?: string }).error ? `<div class="sym-bad small">threw: ${esc((s as { error?: string }).error)}</div>` : ''}</td><td><ul class="ev">${lines}</ul></td></tr>`;
    })
    .join('');
  return `<p class="muted">Page <code>${esc(r.replay.page)}</code> loaded under the collection seal; full seal (Fetch fail-all on every target + proxy refusing every connection) before the first synthetic push. Raw capture: <a href="${href(r.replay.rawFile)}">${esc(r.replay.rawFile)}</a> (local, gitignored).</p><div class="tablewrap"><table><thead><tr><th>Scenario (the app's real push)</th><th>What each vendor would have received (all failed locally)</th></tr></thead><tbody>${sc}</tbody></table></div>`;
}

function journeysSection(r: Results): string {
  return r.journeys
    .map(
      (j) => `<h3 id="journey-${esc(j.id)}">${esc(j.id)} <span class="muted small">— ${esc(j.title)}</span></h3>
  <p class="small">Ad URL <code>${esc(j.landingUrl)}</code><br>Steps: ${esc(j.stepsOrder.join(' → '))} · app steps: ${esc(j.appSteps.join(', ') || '—')} · page loads ${num(j.pageLoads)} · requests ${num(j.requestCounts.total)} (${num(j.requestCounts.allowed)} allowed, ${num(j.requestCounts.failed)} failed locally, ${num(j.requestCounts.collection)} collection) · <a href="${href(j.rawFile)}">raw</a></p>
  <div class="tablewrap"><table><thead><tr><th>Platform</th><th>Click id on app-page hits</th><th>Hits on app page (with id)</th><th>Stored first-party</th><th>Example</th></tr></thead><tbody>${j.perPlatform
    .filter((p) => p.relevant)
    .map((p) => `<tr><td>${esc(plabel(p.platform))}</td><td>${p.sentOnFinalPage ? '<span class="sym-ok">yes</span>' : p.urlOnlyOnFinal ? '<span class="sym-mid">only inside page-URL fields</span>' : '<span class="sym-bad">no</span>'}</td><td>${num(p.hitsOnFinal)} (${num(p.hitsWithIdOnFinal)})</td><td>${p.stored.any ? esc([...p.stored.cookies.map((c) => 'cookie ' + c), ...p.stored.oaAdClids.map((k) => 'oa_ad_clids.' + k), ...p.stored.localStorage.map((k) => 'localStorage ' + k)].join(', ')) : '<span class="muted">none</span>'}</td><td class="mono small">${esc(p.examples[0] ?? '')}</td></tr>`)
    .join('') || '<tr><td colspan="5" class="muted">no click ids in this journey</td></tr>'}</tbody></table></div>
  ${j.oaAdClidsFinal ? `<p class="small">oa_ad_clids at the end: <code>${esc(JSON.stringify(j.oaAdClidsFinal))}</code></p>` : ''}
  ${j.handoff ? `<p class="small">Handoff: <code>${esc(JSON.stringify(j.handoff))}</code></p>` : ''}
  ${j.generation ? `<p class="small">Generation: <code>${esc(JSON.stringify(j.generation))}</code></p>` : ''}
  ${j.blocker ? `<p class="small">Blocker: <code>${esc(JSON.stringify(j.blocker))}</code></p>` : ''}
  ${j.notes.length ? `<details><summary>notes (${j.notes.length})</summary><ul class="ev">${j.notes.map((n) => `<li class="small">${esc(n)}</li>`).join('')}</ul></details>` : ''}
  ${j.errors.length ? `<details><summary>errors (${j.errors.length})</summary><ul class="ev">${j.errors.map((n) => `<li class="small">${esc(n)}</li>`).join('')}</ul></details>` : ''}`,
    )
    .join('');
}

function zeroLeakSection(r: Results): string {
  const z = r.zeroLeak;
  const rows = z.sessions
    .map(
      (s) => `<tr><td>${s.pass ? pill('OK') : pill('FAIL')}</td><td><strong>${esc(s.id)}</strong><div class="muted small">${esc(s.kind)}</div></td><td>${num(s.seen)}</td><td>${num(s.allowed)} <span class="muted small">(${num(s.allowedViaWatchdogFetch)} 3rd-party via watchdog fetch)</span></td><td>${num(s.failed)}</td><td>${num(s.collectionFailedOk)}/${num(s.collectionAttempts)}</td><td>${num(s.independentSuspects?.length)}</td><td>${num((s.responsesForFailed?.length ?? 0) + (s.unaccounted?.length ?? 0))}</td><td>${num(s.markerLeaks?.length)}</td><td class="small">${esc((s.tunnelledHosts ?? []).join(', '))}</td><td class="small">${esc((s.refusedByProxy ?? []).join(', '))}</td><td>${s.teardownOk ? '✓' : '✗'}</td></tr>${(s.blockedInPage ?? []).length || (s.heldTargets ?? []).length ? `<tr><td></td><td colspan="11" class="muted small">refused in the page: ${esc([...(s.blockedInPage ?? []), ...(s.heldTargets ?? []).map((t) => 'held paused: ' + t)].join('; '))}</td></tr>` : ''}${(s.unpausedAllowed ?? []).length ? `<tr><td></td><td colspan="11" class="muted small">no Fetch pause but allowed by policy anyway (not a leak): ${esc(s.unpausedAllowed.join('; '))}</td></tr>` : ''}${s.problems.length ? `<tr><td></td><td colspan="11" class="sym-bad small">${esc(s.problems.join('; '))}</td></tr>` : ''}`,
    )
    .join('');
  const pilot = r.pilot ? `<h3>Seal self-test (loopback server that logs what it receives; before any openart.ai traffic)</h3><div class="tablewrap"><table><thead><tr><th></th><th>Probe</th><th>Result</th></tr></thead><tbody>${(r.pilot.expectations as any[]).map((e) => `<tr><td>${e.ok ? pill('OK') : pill('FAIL')}</td><td>${esc(e.probe)}</td><td class="small">${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const rep = r.replay ? `<h3>Replay full seal (legacy accounting)</h3><p class="small">Post-seal network records ${num(r.replay.accounting.postSealRecords)}; unaccounted ${num(r.replay.accounting.unaccounted)}; failRequest errors ${num(r.replay.accounting.failRequestErrors)}; marker/time-window attribution disagreements ${num(r.replay.accounting.attributionDisagreements)}. Seal probes: <code>${esc(JSON.stringify(r.replay.sealProbes))}</code></p>` : '';
  return `<p>${pill(z.status)} <strong>${num(z.totals.collectionAttempts)}</strong> collection attempts across ${num(z.sessions.length)} browser sessions; <strong>${num(z.totals.collectionCompleted)}</strong> completed. ${num(z.totals.seen)} requests seen, ${num(z.totals.allowed)} allowed (render resources; ${num(z.totals.allowedViaWatchdogFetch)} third-party GETs fetched by the watchdog itself), ${num(z.totals.failed)} failed locally, ${num(z.totals.unaccounted)} network requests without a Fetch decision.</p>
  <ul class="ev">${z.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
  <div class="tablewrap"><table><thead><tr><th></th><th>Session</th><th>Seen</th><th>Allowed</th><th>Failed</th><th>Collection failed</th><th>Independent suspects</th><th>Responses to failed / unaccounted</th><th>Marker leaks</th><th>Proxy tunnelled</th><th>Proxy refused</th><th>Teardown</th></tr></thead><tbody>${rows}</tbody></table></div>${pilot}${rep}`;
}

function unlistedSection(r: Results): string {
  const list = r.policy?.firstPartyUnlisted ?? [];
  if (!list.length) return '<p class="muted">None: every first-party subresource matched the allowlist (src/policy/policy.ts FIRST_PARTY_RULES).</p>';
  return `<p class="muted">Failed locally because they are not on the first-party allowlist. Each one is either a read-only API the page needs (add it to FIRST_PARTY_RULES) or telemetry (add a collection rule). Unknown means failed, never delivered.</p><div class="tablewrap"><table><thead><tr><th>Host</th><th>Type</th><th>Path pattern</th><th>Count</th></tr></thead><tbody>${list.map((x) => `<tr><td>${esc(x.host)}</td><td>${esc(x.type)}</td><td class="mono">${esc(x.path)}</td><td>${num(x.count)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function renderReport(r: Results): string {
  const s = r.summary.checks;
  const containerState = 'state' in r.container ? r.container.state : 'ERROR';
  const patches = Object.entries(r.run.patches).filter(([, v]) => v);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenArt Signal Watchdog</title><style>${CSS}</style></head><body><main>
  <h1>OpenArt signal watchdog</h1>
  <div class="muted">Run <span class="mono">${esc(r.run.id)}</span> · target <strong>${esc(r.run.target)}</strong> · ${esc(r.run.startedAt)} → ${esc(r.run.finishedAt)} · contract <span class="mono">${esc(r.run.contract)}</span></div>
  ${patches.length ? `<div class="note small">Patched run: ${patches.map(([k, v]) => `<strong>${esc(k)}</strong> <code>${esc(v!.path)}</code> sha256 <code>${esc(v!.sha256.slice(0, 16))}</code>`).join(' · ')}</div>` : ''}
  <div class="cards">
    <div class="card"><div class="k">Contract checks</div><div class="v"><span style="color:var(--pass)">${num(s.PASS ?? 0)} pass</span> · <span style="color:var(--fail)">${num(s.FAIL ?? 0)} fail</span></div><div class="k">${num(s.ERROR ?? 0)} error · ${num(s.SKIP ?? 0)} skip</div></div>
    <div class="card"><div class="k">Zero-leak proof</div><div class="v">${pill(r.zeroLeak.status)}</div><div class="k">${num(r.zeroLeak.totals.collectionAttempts)} collection attempts, ${num(r.zeroLeak.totals.collectionCompleted)} completed</div></div>
    <div class="card"><div class="k">GTM-56CMP8K + gtag config vs baseline</div><div class="v">${pill(containerState)}</div></div>
    <div class="card"><div class="k">Page loads (budget)</div><div class="v">${num(r.run.pageLoads.total)} / ${num(r.run.pageLoads.budget)}</div></div>
    <div class="card"><div class="k">Seal self-test</div><div class="v">${r.pilot ? pill(r.pilot.ok ? 'OK' : 'FAIL') : '<span class="muted">skipped</span>'}</div></div>
  </div>
  ${r.run.errors.length ? `<div class="note small"><strong>Run notes:</strong><ul class="ev">${r.run.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  <h2>Contract checks</h2>${checksTable(r)}
  <h2>Click-ID coverage</h2>${coverageSection(r)}
  <h2>Page views per route change</h2>${pageViewSection(r)}
  <h2>Consent</h2>${consentSection(r)}
  <h2>Container diff</h2>${containerSection(r)}
  <h2>Conversion replay (full seal)</h2>${replaySection(r)}
  <h2>Journeys</h2>${journeysSection(r)}
  <h2>Zero-leak proof</h2>${zeroLeakSection(r)}
  <h2>First-party requests outside the allowlist</h2>${unlistedSection(r)}
  <h2>Reproduce</h2><p class="small">From <code>packages/watchdog</code>: <code>npx tsx src/cli.ts run --target live --out reports/&lt;dir&gt;</code>; patched (before/after proof): <code>npx tsx src/cli.ts run --target patched --patch-container ../web-fixes/gtm/proof/patched_resource.json --patch-gtag-config ../web-fixes/gtm/proof/patched_gtag_config.js --inject-script ../web-fixes/gtm/proof/inject_web_fixes.min.js --edge-sim ../edge-attribution/dist/edge-sim.js --out reports/patched-&lt;date&gt;</code>. Re-render: <code>npx tsx src/cli.ts report --in results.json</code>.</p>
  <p class="muted small">Every measurement/collection request in this report was failed locally inside Chrome and never delivered; synthetic events were replayed only under a full seal. Raw captures live in <code>raw/</code> next to this file and are not committed.</p>
</main></body></html>`;
}
