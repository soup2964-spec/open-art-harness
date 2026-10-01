#!/usr/bin/env -S npx tsx
// OpenArt signal watchdog CLI.
//
//   npx tsx src/cli.ts run --target live|patched [--patch-container path] [--patch-gtag-config path]
//        [--inject-script path] [--edge-sim path] [--journeys list] [--out dir]
//        [--no-replay] [--replay-page url] [--consent-regions DE,GB,CH|none] [--max-page-loads 60]
//        [--scenarios file] [--contract file] [--blocklists dir] [--chrome path]
//        [--slack-webhook-env VAR] [--fail-on never|fail|change] [--no-pilot]
//   npx tsx src/cli.ts pilot                       seal self-test (loopback server only; no internet)
//   npx tsx src/cli.ts container [--out file]      container diff only (two script GETs)
//   npx tsx src/cli.ts report --in results.json    re-render report.html
//   npx tsx src/cli.ts alert --in results.json [--slack-webhook-env VAR] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { buildSlackMessage, sendSlack, shouldAlert } from './alert/slack.js';
import { containerReport } from './container/fetch.js';
import { renderReport } from './report/html.js';
import { DEFAULT_CHROME, PACKAGE_DIR, run, type Results } from './run.js';
import { runPilot } from './pilot.js';
import { JOURNEYS } from './journeys/journeys.js';

export interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(['no-replay', 'no-pilot', 'dry-run', 'help']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
      flags[name] = v;
      i++;
    }
  }
  return { cmd, flags };
}

const str = (f: Record<string, string | boolean>, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export function defaultOutDir(now = new Date()): string {
  return path.join(PACKAGE_DIR, 'reports', `run-${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, '')}`);
}

function writeOutputs(results: Results, outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(outDir, 'report.html'), renderReport(results));
}

/** Returns false when an alert was due but could not be delivered (the CLI then exits non-zero). */
async function maybeAlert(results: Results, flags: Record<string, string | boolean>): Promise<boolean> {
  const envName = str(flags, 'slack-webhook-env');
  if (!envName) return true;
  const decision = shouldAlert(results);
  if (!decision.send) {
    console.log('alert: nothing to report');
    return true;
  }
  const msg = buildSlackMessage(results, process.env.WATCHDOG_REPORT_URL);
  if (flags['dry-run']) {
    console.log(JSON.stringify(msg, null, 1));
    return true;
  }
  const url = process.env[envName];
  if (!url) {
    console.error(`alert: ${envName} is not set; an alert was due and could not be sent`);
    return false;
  }
  try {
    const r = await sendSlack(url, msg);
    console.log(`alert: Slack ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error('alert: Slack delivery failed: ' + (e as Error).message);
    return false;
  }
}

export const EXIT = { OK: 0, CHECKS: 1, ZERO_LEAK: 2, CRASH: 3, ALERT_UNDELIVERED: 4 } as const;

const HELP = `openart-signal watchdog
  run --target live|patched [--patch-container path] [--patch-gtag-config path] [--inject-script path] [--edge-sim path]
      [--journeys ${JOURNEYS.map((j) => j.id).join(',')}] [--out dir]
      [--no-replay] [--replay-page url] [--consent-regions DE,GB,CH|none] [--max-page-loads 60] [--scenarios file]
      [--contract file] [--blocklists dir] [--chrome path] [--slack-webhook-env VAR] [--fail-on never|fail|change] [--no-pilot]
  pilot | container [--out file] | report --in results.json | alert --in results.json [--slack-webhook-env VAR] [--dry-run]`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'run') {
    const target = str(flags, 'target');
    if (target !== 'live' && target !== 'patched') throw new Error('--target must be live or patched');
    const failOnFlag = str(flags, 'fail-on') ?? 'never';
    if (!['never', 'fail', 'change'].includes(failOnFlag)) throw new Error('--fail-on must be never, fail or change');
    const out = path.resolve(str(flags, 'out') ?? defaultOutDir());
    const results = await run({
      target,
      patchContainer: str(flags, 'patch-container'),
      patchGtagConfig: str(flags, 'patch-gtag-config'),
      injectScript: str(flags, 'inject-script'),
      edgeSim: str(flags, 'edge-sim'),
      journeys: list(str(flags, 'journeys')),
      out,
      chromePath: str(flags, 'chrome') ?? DEFAULT_CHROME,
      replay: !flags['no-replay'],
      replayPage: str(flags, 'replay-page'),
      consentRegions: str(flags, 'consent-regions') === 'none' ? [] : list(str(flags, 'consent-regions')),
      maxPageLoads: str(flags, 'max-page-loads') !== undefined ? Number(str(flags, 'max-page-loads')) : undefined,
      blocklistsDir: str(flags, 'blocklists'),
      scenariosFile: str(flags, 'scenarios'),
      contractFile: str(flags, 'contract'),
      pilot: !flags['no-pilot'],
    });
    writeOutputs(results, out);
    const s = results.summary;
    console.log(`\nresults: ${path.join(out, 'results.json')}\nreport:  ${path.join(out, 'report.html')}`);
    console.log(`checks ${JSON.stringify(s.checks)} · zero-leak ${s.zeroLeak} · container ${s.containerState} · run errors ${s.runErrors} · first-party unlisted ${s.firstPartyUnlisted} · coverage ${JSON.stringify(s.coverage)}`);
    const alerted = await maybeAlert(results, flags);
    if (s.zeroLeak !== 'PROVEN') return EXIT.ZERO_LEAK;
    const failOn = str(flags, 'fail-on') ?? 'never';
    if (failOn === 'fail' && ((s.checks.FAIL ?? 0) > 0 || (s.checks.ERROR ?? 0) > 0 || s.runErrors > 0)) return EXIT.CHECKS;
    if ((failOn === 'fail' || failOn === 'change') && s.containerChanged) return EXIT.CHECKS;
    return alerted ? EXIT.OK : EXIT.ALERT_UNDELIVERED;
  }
  if (cmd === 'pilot') {
    const r = await runPilot({ chromePath: str(flags, 'chrome') ?? DEFAULT_CHROME, profilesDir: path.join(PACKAGE_DIR, '.profiles'), log: console.log });
    for (const e of r.expectations) console.log(`${e.ok ? 'OK  ' : 'FAIL'} ${e.probe} — ${e.detail}`);
    return r.ok ? 0 : 2;
  }
  if (cmd === 'container') {
    const rep = await containerReport({});
    const out = str(flags, 'out');
    if (out) fs.writeFileSync(out, JSON.stringify(rep, null, 1));
    for (const l of [...rep.loaders, ...(rep.gtagConfig ? [rep.gtagConfig] : [])]) console.log(`${l.loader}: ${l.snapshot.containerId} v${l.snapshot.version} ${l.status.toUpperCase()}\n  ${l.summary.join('\n  ')}`);
    console.log(`container state: ${rep.state}${rep.problems.length ? ' — ' + rep.problems.join('; ') : ''}`);
    return rep.changed ? EXIT.CHECKS : EXIT.OK;
  }
  if (cmd === 'report') {
    const inFile = path.resolve(str(flags, 'in') ?? 'results.json');
    const results = JSON.parse(fs.readFileSync(inFile, 'utf8')) as Results;
    const out = path.join(path.dirname(inFile), 'report.html');
    fs.writeFileSync(out, renderReport(results));
    console.log(out);
    return 0;
  }
  if (cmd === 'alert') {
    const results = JSON.parse(fs.readFileSync(path.resolve(str(flags, 'in') ?? 'results.json'), 'utf8')) as Results;
    return (await maybeAlert(results, { ...flags, 'slack-webhook-env': str(flags, 'slack-webhook-env') ?? 'SLACK_WEBHOOK_URL' })) ? EXIT.OK : EXIT.ALERT_UNDELIVERED;
  }
  throw new Error(`unknown command ${cmd}\n${HELP}`);
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  process.on('unhandledRejection', (e) => {
    // puppeteer rejects pending CDP calls when Chrome is SIGKILLed at teardown; anything else is reported
    if (!/Target closed|Connection closed|Session closed|Protocol error|detached/i.test(String((e as Error)?.message ?? e))) console.error('unhandled rejection:', e);
  });
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error('watchdog error:', e instanceof Error ? e.message : e);
      process.exit(3);
    },
  );
}
