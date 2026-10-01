// Writes baselines/container_v25.json (and the Google tag config baseline) from the saved
// 2026-09-29 evidence. The resource block is identical in gtm.js and the /4vu8/ gateway copy
// (research/11 §7), so one baseline covers both loaders.
//   npx tsx scripts/make-baseline.ts [evidenceDir]
import fs from 'node:fs';
import path from 'node:path';
import { parseContainerScript, resourceHash } from '../src/container/parse.js';

const EVIDENCE: string = process.argv[2] ?? process.env.OPENART_EVIDENCE_DIR ?? (() => { throw new Error('Pass the evidence directory as an argument or set OPENART_EVIDENCE_DIR'); })();
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'baselines');
fs.mkdirSync(OUT, { recursive: true });

const saved = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'raw', 'gtm_56CMP8K.js.json'), 'utf8'));
const gtm = parseContainerScript(fs.readFileSync(path.join(EVIDENCE, 'raw', 'gtm_56CMP8K.js'), 'utf8'))!;
const gw = parseContainerScript(fs.readFileSync(path.join(EVIDENCE, 'raw', 'static', 'gtg_4vu8_root.js'), 'utf8'))!;
const hash = resourceHash(saved.resource);
if (gtm.resourceSha256 !== hash || gw.resourceSha256 !== hash) throw new Error('loaders disagree with the saved resource');

fs.writeFileSync(
  path.join(OUT, 'container_v25.json'),
  JSON.stringify(
    {
      containerId: 'GTM-56CMP8K',
      version: String(saved.resource.version),
      resourceSha256: hash,
      capturedAt: '2026-09-29',
      loaders: ['https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K', 'https://openart.ai/4vu8/'],
      source: 'openart_2026-09-29/raw/gtm_56CMP8K.js.json; identical resource in raw/gtm_56CMP8K.js and raw/static/gtg_4vu8_root.js (research/11 §7)',
      hashMethod: 'sha256 of canonical JSON (keys sorted recursively) of data.resource',
      resource: saved.resource,
    },
    null,
    1,
  ) + '\n',
);

const cfg = parseContainerScript(fs.readFileSync(path.join(EVIDENCE, 'raw', 'static', 'gtg_4vu8_C.js'), 'utf8'))!;
fs.writeFileSync(
  path.join(OUT, 'gtag_config_AW-11252321380_v4.json'),
  JSON.stringify(
    {
      containerId: cfg.containerId,
      version: cfg.version,
      resourceSha256: cfg.resourceSha256,
      capturedAt: '2026-09-29',
      loaders: ['https://www.googletagmanager.com/gtag/js?id=AW-11252321380', 'https://openart.ai/4vu8/C_… (first-party config path)'],
      source: 'openart_2026-09-29/raw/static/gtg_4vu8_C.js (identical resource to raw/static/gtag_AW-11252321380.js)',
      hashMethod: 'sha256 of canonical JSON (keys sorted recursively) of data.resource',
      resource: cfg.resource,
    },
    null,
    1,
  ) + '\n',
);
console.log('container v' + saved.resource.version, hash, '| gtag config v' + cfg.version, cfg.resourceSha256);
