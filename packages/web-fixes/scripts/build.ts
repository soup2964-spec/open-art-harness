/**
 * Builds every generated artifact of the web fix pack (deterministic; no network):
 *   shim/dist/openart-click-id-shim.min.js           (esbuild, IIFE)
 *   consent/dist/openart-consent-defaults.min.js     (esbuild, IIFE)
 *   hubspot/dist/openart-hubspot-fill.min.js         (esbuild, IIFE)
 *   gtm/proof/inject_web_fixes.min.js               (esbuild, IIFE; watchdog --inject-script)
 *   gtm/import/openart-gtm-fixpack.json              (GTM export, MERGE import)
 *   gtm/proof/patched_resource.json                  (compiled v25 resource + fix pack)
 *   gtm/proof/patch-report.json                      (what the patcher changed)
 *   gtm/proof/patched_gtag_config.js                 (Google tag config v4, form auto-events off)
 *   gtm/proof/variants/patched_resource.linkedin-lintrk-value.json (optional LinkedIn value variant, B3 option c)
 *   gtm/proof/variants/patched_resource.linkedin-server-only.json  (optional LinkedIn server-only purchases, B3 option b)
 *
 *   npx tsx scripts/build.ts          write everything
 *   npx tsx scripts/build.ts --check  fail if any committed artifact is stale
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { renderImportJson } from '../gtm/src/build-import';
import { patchContainerResource } from '../gtm/src/patch-container';
import { patchGtagConfig } from '../gtm/src/patch-gtag-config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const BUNDLES: Array<{ entry: string; out: string; banner: string }> = [
  {
    entry: 'shim/src/entry.ts',
    out: 'shim/dist/openart-click-id-shim.min.js',
    banner: '/* OpenArt Click ID Shim v2 — openart-signal/packages/web-fixes/shim (drop-in for the inline Astro shim) */',
  },
  {
    entry: 'consent/src/entry.ts',
    out: 'consent/dist/openart-consent-defaults.min.js',
    banner: '/* OpenArt Consent Mode v2 defaults (on-page form) — openart-signal/packages/web-fixes/consent */',
  },
  {
    entry: 'hubspot/src/entry.ts',
    out: 'hubspot/dist/openart-hubspot-fill.min.js',
    banner: '/* OpenArt HubSpot enterprise-form attribution fill — openart-signal/packages/web-fixes/hubspot */',
  },
  {
    entry: 'scripts/proof-inject.entry.ts',
    out: 'gtm/proof/inject_web_fixes.min.js',
    banner: '/* PROOF ONLY (watchdog --inject-script): consent defaults + click-ID shim + stand-ins for the app patches — openart-signal/packages/web-fixes */',
  },
];

export async function bundle(entry: string, banner: string): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2018',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    banner: { js: banner },
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error(`esbuild produced no output for ${entry}`);
  return file.text;
}

async function outputs(): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const b of BUNDLES) out.push({ path: b.out, content: await bundle(b.entry, b.banner) });

  out.push({ path: 'gtm/import/openart-gtm-fixpack.json', content: renderImportJson() });

  const container = JSON.parse(readFileSync(join(ROOT, 'gtm/test/fixtures/gtm_56CMP8K.js.json'), 'utf8')) as { resource: unknown };
  const { resource, report } = patchContainerResource(container.resource);
  out.push({ path: 'gtm/proof/patched_resource.json', content: `${JSON.stringify(resource, null, 2)}\n` });
  out.push({ path: 'gtm/proof/patch-report.json', content: `${JSON.stringify(report, null, 2)}\n` });
  for (const variant of ['linkedin-lintrk-value', 'linkedin-server-only'] as const) {
    const patched = patchContainerResource(container.resource, { variant });
    out.push({ path: `gtm/proof/variants/patched_resource.${variant}.json`, content: `${JSON.stringify(patched.resource, null, 2)}\n` });
  }

  const gtag = readFileSync(join(ROOT, 'gtm/test/fixtures/gtag_AW-11252321380_v4_executed.js'), 'utf8');
  out.push({ path: 'gtm/proof/patched_gtag_config.js', content: patchGtagConfig(gtag).js });
  return out;
}

async function main(): Promise<void> {
  const stale: string[] = [];
  for (const { path, content } of await outputs()) {
    const abs = join(ROOT, path);
    if (CHECK) {
      if (!existsSync(abs) || readFileSync(abs, 'utf8') !== content) stale.push(path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`wrote ${relative(ROOT, abs)} (${Buffer.byteLength(content)} bytes)`);
  }
  if (CHECK) {
    if (stale.length) {
      console.error(`stale build outputs (run \`npm run build\`):\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log('build outputs are up to date');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
