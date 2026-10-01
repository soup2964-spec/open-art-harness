// Slack incoming-webhook alert: sent when any contract check FAILs / ERRORs, when GTM-56CMP8K (or
// the Google tag config) differs from its baseline or cannot be read, when the run itself recorded
// errors, when first-party requests outside the allowlist were seen, or when the zero-leak proof did
// not hold. The webhook URL is read from an environment variable (Secret Manager on Cloud Run),
// never from a file in the repo. Text from the site (observed values, diff lines) is escaped for
// Slack mrkdwn, every section stays under Slack's 3000-character limit, and a failed delivery is
// reported to the caller (the CLI exits non-zero) instead of being logged and forgotten.
import type { Results } from '../run.js';

export interface AlertDecision {
  send: boolean;
  reasons: string[];
}

export function shouldAlert(r: Results, opts: { onFail?: boolean; onChange?: boolean } = {}): AlertDecision {
  const reasons: string[] = [];
  const failing = r.checks.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
  if ((opts.onFail ?? true) && failing.length) reasons.push(`${failing.length} contract check(s) failing or not evaluable`);
  const c: any = r.container;
  if (opts.onChange ?? true) {
    if (c?.state === 'CHANGED') reasons.push('GTM-56CMP8K / Google tag config changed vs baseline');
    else if (c?.state === 'UNAVAILABLE' || c?.error) reasons.push('container check could not read a loader (fail-closed)');
  }
  if (r.zeroLeak.status !== 'PROVEN') reasons.push('ZERO-LEAK PROOF FAILED');
  if (r.pilot && !r.pilot.ok) reasons.push('seal self-test failed');
  if (r.run.errors.length) reasons.push(`${r.run.errors.length} run error(s)`);
  const unlisted = r.policy?.firstPartyUnlisted?.length ?? 0;
  if (unlisted) reasons.push(`${unlisted} first-party request pattern(s) not on the allowlist were failed — review the policy`);
  return { send: reasons.length > 0, reasons };
}

/** Escape text for Slack mrkdwn: &, <, > (so "<!channel>" or "<https://x|y>" from a site cannot become markup). */
export function slackEscape(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SECTION_MAX = 2900;
function clip(text: string, max = SECTION_MAX): string {
  return text.length <= max ? text : text.slice(0, max - 20) + '\n… (truncated)';
}

export function buildSlackMessage(r: Results, reportUrl?: string): { text: string; blocks: unknown[] } {
  const d = shouldAlert(r);
  const s = r.summary.checks;
  const failing = r.checks.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
  const container: any = r.container;
  const changes: string[] = [
    ...(container?.problems ?? []),
    ...((container?.loaders ?? []) as any[]).flatMap((l) => (l.status === 'changed' ? l.summary.slice(0, 6).map((x: string) => `${l.loader}: ${x}`) : [])),
  ];
  const cov = Object.entries(r.summary.coverage).map(([p, v]) => `${p} ${v}`).join(' · ');
  const text = clip(`OpenArt watchdog (${r.run.target}): ${s.PASS ?? 0} pass / ${s.FAIL ?? 0} fail / ${s.ERROR ?? 0} error — ${slackEscape(d.reasons.join('; ') || 'all green')}`, 2000);
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `OpenArt signal watchdog — ${r.run.target}`.slice(0, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: clip(`*${s.PASS ?? 0}* pass · *${s.FAIL ?? 0}* fail · *${s.ERROR ?? 0}* error · zero-leak *${r.zeroLeak.status}* · container *${slackEscape(container?.state ?? (container?.error ? 'ERROR' : 'n/a'))}*\n${d.reasons.map((x) => `• ${slackEscape(x)}`).join('\n')}`) } },
  ];
  if (failing.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(failing.slice(0, 20).map((c) => `${c.status === 'FAIL' ? ':red_circle:' : ':warning:'} *${slackEscape(c.title)}* — ${slackEscape(c.observed).slice(0, 240)}`).join('\n')) } });
  if (changes.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip('*Container*\n' + changes.slice(0, 20).map((x) => '`' + slackEscape(x).replace(/`/g, "'").slice(0, 200) + '`').join('\n')) } });
  const link = reportUrl && /^https:\/\//.test(reportUrl) && !/[<>|]/.test(reportUrl) ? ` · <${reportUrl}|report>` : '';
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`Click-ID coverage: ${slackEscape(cov)}${link} · run ${slackEscape(r.run.id)}`, 1900) }] });
  return { text, blocks };
}

export async function sendSlack(webhookUrl: string, message: { text: string; blocks: unknown[] }, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  if (!/^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_-]+$/.test(webhookUrl)) throw new Error('refusing to post: not a hooks.slack.com incoming-webhook URL');
  const res = await fetchImpl(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  return { ok: res.ok, status: res.status };
}
