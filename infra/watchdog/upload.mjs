// Upload one watchdog run to Cloud Storage and (optionally) BigQuery, using the Cloud Run job's
// service account via Application Default Credentials. Destinations are OpenArt's own GCP project
// only; nothing is sent anywhere else.
//   node infra/watchdog/upload.mjs <runOutDir>
// Env: WATCHDOG_BUCKET (required)            e.g. openart-signal-watchdog
//      WATCHDOG_BQ_DATASET (optional)        e.g. openart-data.signal_watchdog  (tables: runs, check_results)
//      WATCHDOG_UPLOAD_RAW=1 (optional)      also upload raw/ captures (large; keep a lifecycle rule)
import fs from 'node:fs';
import path from 'node:path';
import { GoogleAuth } from 'google-auth-library';

const outDir = process.argv[2];
const bucket = process.env.WATCHDOG_BUCKET;
if (!outDir || !bucket) {
  console.error('usage: WATCHDOG_BUCKET=... node upload.mjs <runOutDir>');
  process.exit(1);
}
const results = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
const prefix = `runs/${results.run.startedAt.slice(0, 10)}/${results.run.id}`;
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write', 'https://www.googleapis.com/auth/bigquery.insertdata'] });
const client = await auth.getClient();
const TYPES = { '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript' };

async function put(file, objectName) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  await client.request({ url, method: 'POST', headers: { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }, body: fs.readFileSync(file) });
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(outDir).filter((f) => process.env.WATCHDOG_UPLOAD_RAW === '1' || !path.relative(outDir, f).startsWith('raw' + path.sep));
for (const f of files) await put(f, `${prefix}/${path.relative(outDir, f).split(path.sep).join('/')}`);
await put(path.join(outDir, 'results.json'), 'latest/results.json');
await put(path.join(outDir, 'report.html'), 'latest/report.html');
const reportUrl = `https://storage.cloud.google.com/${bucket}/${prefix}/report.html`;
fs.writeFileSync(path.join(outDir, 'upload.json'), JSON.stringify({ bucket, prefix, reportUrl, files: files.length }, null, 1));
console.log(`uploaded ${files.length} file(s) to gs://${bucket}/${prefix}`);

if (process.env.WATCHDOG_BQ_DATASET) {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const [project, dataset] = process.env.WATCHDOG_BQ_DATASET.split('.');
  const bq = new BigQuery({ projectId: project });
  const r = results;
  // raw rows with insertId: BigQuery de-duplicates a retried upload of the same run.
  await bq.dataset(dataset).table('runs').insert([{ insertId: r.run.id, json: {
    run_id: r.run.id, started_at: r.run.startedAt, finished_at: r.run.finishedAt, target: r.run.target,
    pass: r.summary.checks.PASS ?? 0, fail: r.summary.checks.FAIL ?? 0, error: r.summary.checks.ERROR ?? 0, skip: r.summary.checks.SKIP ?? 0,
    zero_leak: r.summary.zeroLeak, container_changed: r.summary.containerChanged, container_state: r.summary.containerState ?? null,
    run_errors: r.summary.runErrors ?? null, first_party_unlisted: r.summary.firstPartyUnlisted ?? null,
    coverage_json: JSON.stringify(r.coverage.map((c) => ({ platform: c.platform, standard: c.standard.pct, blocker: c.blocker.pct }))),
    page_loads: r.run.pageLoads.total, gcs_prefix: `gs://${bucket}/${prefix}`,
  } }], { raw: true });
  await bq.dataset(dataset).table('check_results').insert(r.checks.map((c) => ({ insertId: `${r.run.id}:${c.id}`, json: {
    run_id: r.run.id, started_at: r.run.startedAt, target: r.run.target, check_id: c.id, title: c.title, platform: String(c.platform ?? ''), status: c.status, observed: c.observed.slice(0, 1000), confidence: c.confidence,
  } })), { raw: true });
  console.log(`BigQuery rows written to ${process.env.WATCHDOG_BQ_DATASET}.{runs,check_results}`);
}
