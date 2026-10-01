/**
 * The only audience "client" in this package: it records and prints requests. There is no
 * live mode and no transport; wiring real uploads needs platform credentials, OpenArt's
 * approval and a separate, reviewed sender.
 */

import type { AudienceHttpRequest } from './platforms/common.js';

export function formatAudienceRequest(req: AudienceHttpRequest, maxRows = 3): string {
  const lines = [`${req.method} ${req.url}   [${req.id}, ${req.members} members]`];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
  const truncate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.length > maxRows ? [...value.slice(0, maxRows).map(truncate), `... ${value.length - maxRows} more`] : value.map(truncate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]));
    return value;
  };
  if (req.json !== undefined) lines.push('', JSON.stringify(truncate(req.json), null, 2));
  if (req.form) {
    lines.push('');
    for (const [k, v] of Object.entries(req.form)) {
      let shown = v;
      if (k === 'payload') shown = JSON.stringify(truncate(JSON.parse(v)));
      lines.push(`${k}=${shown}`);
    }
  }
  if (req.file) {
    const head = req.file.content.split('\n').slice(0, maxRows).join('\n');
    lines.push('', `file ${req.file.fileName} (${req.file.lines} lines, ${req.file.bytes} bytes, md5 ${req.file.md5}):`, head, req.file.lines > maxRows ? `... ${req.file.lines - maxRows} more lines` : '');
  }
  return lines.join('\n');
}

export class DryRunAudienceClient {
  readonly recorded: AudienceHttpRequest[] = [];

  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  async submit(request: AudienceHttpRequest): Promise<{ mode: 'dry-run'; id: string }> {
    this.recorded.push(request);
    this.log(`--- DRY RUN: this ${request.platform} request was NOT sent ---\n${formatAudienceRequest(request)}`);
    return { mode: 'dry-run', id: request.id };
  }
}
